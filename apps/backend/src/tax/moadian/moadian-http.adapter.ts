import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import {
  MoadianAdapter,
  MoadianAsyncResponse,
  MoadianInquiryResult,
  MoadianPacket,
  MoadianToken,
} from './moadian-adapter';

/**
 * HTTP adapter for the real Moadian Tax API — OFFICIAL current protocol:
 * «دستورالعمل فنی اتصال به سامانه مودیان» شناسه سند RC_TICS.IS_v1.6
 * (شهریور ۱۴۰۴) — retrieved directly from the official portal
 * (www.intamedia.ir → پایانه‌های فروشگاهی و سامانه مودیان). Third-party
 * mirrors (rahrokh/HPM/BaseMax) are NOT equivalent sources and the older
 * mirror-era shapes (normal-enqueue packets, normalize/dataSignature,
 * XOR-whitening) do NOT exist in the official document.
 *
 *   base:      https://tp.tax.gov.ir/requestsmanager/api/v2
 *   auth:      GET  …/nonce?timeToLive={10..200,default 30} → {nonce,expDate};
 *              JWS (RS256, x5c=[cert], sigT ISO-8601, crit=[sigT]) over
 *              {nonce, clientId} = single-use Bearer token per request (§5)
 *   server:    GET  …/server-information → { serverTime, publicKeys:
 *              [{ key: base64 SPKI, id, algorithm: "RSA", purpose: 1 }] } (§6)
 *   submit:    POST …/invoice  body=[{ payload: JWE,
 *              header: { requestTraceId, fiscalId } }] (§7);
 *              response { timestamp, result: [{ uid, packetType,
 *              referenceNumber, data }] } — the response uid echoes OUR
 *              requestTraceId (§7/§8: «uid … همان requestTraceId»)
 *   invoice:   JSON {header, body, payments[]} → signed as compact JWS (§7.2)
 *              → encrypted as compact JWE {alg: RSA-OAEP-256, enc: A256GCM,
 *              kid} with AAD=ASCII(Base64URL(header)) (§7.3)
 *   inquiry:   GET  …/inquiry-by-uid?uidList=…&fiscalId=… → array of
 *              { uid, status: SUCCESS|FAILED|IN_PROGRESS|NOT_FOUND,
 *              data: { error[], warning, success }, sign } (§8.2)
 *
 * ⚠️ Runtime UNVERIFIED against the live service: real operation requires
 * the taxpayer's Sharjh credentials (private key + X.509 certificate +
 * clientId + fiscalId) supplied at runtime — never stored in this repository.
 * All wire shapes here follow the official v1.6 document text.
 */
@Injectable()
export class MoadianHttpAdapter implements MoadianAdapter {
  private readonly logger = new Logger('MoadianHttpAdapter');
  readonly base: string;
  readonly fiscalId: string;
  readonly economicCode: string;
  readonly clientId: string;
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  /** injectable for deterministic offline tests (default: global fetch) */
  readonly fetchImpl: typeof fetch;

  constructor(config: {
    baseUrl?: string;
    fiscalId?: string;
    economicCode?: string;
    privateKeyPem?: string;
    clientId?: string;
    certificatePem?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.base = config.baseUrl ?? 'https://tp.tax.gov.ir/requestsmanager/api/v2';
    this.fiscalId = config.fiscalId ?? '';
    this.economicCode = config.economicCode ?? '';
    this.clientId = config.clientId ?? '';
    this.privateKeyPem = config.privateKeyPem ?? '';
    this.certificatePem = config.certificatePem ?? '';
    this.fetchImpl = config.fetchImpl ?? fetch;
    const missing = [
      ['fiscalId', this.fiscalId],
      ['economicCode', this.economicCode],
      ['clientId', this.clientId],
      ['privateKeyPem', this.privateKeyPem],
      ['certificatePem', this.certificatePem],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`MOADIAN_HTTP_CONFIG_MISSING: ${missing.join(', ')} are required for sandbox/live mode`);
    }
    // the X.509 certificate must parse AND its public key must match the
    // configured private key — a JWS signed with an unrelated key is not
    // protocol-compliant even when cryptographically valid
    let cert: crypto.X509Certificate;
    try {
      cert = new crypto.X509Certificate(this.certificatePem);
    } catch {
      throw new Error('MOADIAN_CERT_INVALID: certificatePem is not a parseable X.509 certificate');
    }
    const certPublicKeyPem = cert.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPublicKeyPem = crypto
      .createPublicKey(this.privateKeyPem)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    if (certPublicKeyPem !== privateKeyPublicKeyPem) {
      throw new Error('MOADIAN_CERT_KEY_MISMATCH: certificate public key does not match privateKeyPem');
    }
  }

  /** Official §5 auth: GET nonce → build JWS (RS256, x5c cert, sigT, crit) →
   *  the JWS itself is the single-use Bearer credential for one request. */
  buildJws(nonce: string, sigT = new Date().toISOString()): string {
    const b64url = (input: Buffer | string) =>
      Buffer.from(input).toString('base64url');
    const cert = this.certificatePem
      .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, '')
      .replace(/[\r\n]+/g, '')
      .trim();
    const header: Record<string, unknown> = {
      alg: 'RS256',
      x5c: [cert],
      sigT,
      crit: ['sigT'],
    };
    const encodedHeader = b64url(JSON.stringify(header));
    const encodedPayload = b64url(JSON.stringify({ nonce, clientId: this.clientId }));
    const dataToSign = `${encodedHeader}.${encodedPayload}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(dataToSign);
    const signature = signer.sign(this.privateKeyPem);
    return `${dataToSign}.${b64url(signature)}`;
  }

  private async getNonce(): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/nonce?timeToLive=200`, { redirect: 'error' });
    if (!res.ok) throw new Error(`MOADIAN_NONCE_FAILED:${res.status}`);
    const body = (await res.json()) as { nonce?: string };
    if (!body.nonce) throw new Error('MOADIAN_NONCE_MISSING');
    return body.nonce;
  }

  /** Official §5 auth: Bearer credential = the JWS built from a fresh nonce
   *  (single-use per request — a fresh nonce is fetched for every call). */
  async getToken(): Promise<MoadianToken> {
    const nonce = await this.getNonce();
    const jws = this.buildJws(nonce);
    return { token: jws, expiresInSeconds: 200 }; // nonce TTL 10..200s (§5.1.1)
  }

  /** Official §6 server information: { serverTime, publicKeys: [{ key
   *  (base64 SPKI), id, algorithm, purpose }] } — purpose 1 = encryption
   *  key. The base64 SPKI is wrapped into a PEM for node crypto use. */
  async getServerInformation(): Promise<{ publicKeyId: string; publicKeyPem: string }> {
    const token = (await this.getToken()).token;
    const res = await this.fetchImpl(`${this.base}/server-information`, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    });
    if (!res.ok) throw new Error(`MOADIAN_SERVER_INFO_FAILED:${res.status}`);
    const body = (await res.json()) as {
      serverTime?: number;
      publicKeys?: Array<{ key?: string; id?: string; algorithm?: string; purpose?: number }>;
    };
    const keys = body.publicKeys ?? [];
    const encryption = keys.find((k) => k.purpose === 1) ?? keys[0];
    if (!encryption?.key || !encryption.id) throw new Error('MOADIAN_SERVER_INFO_SCHEMA');
    const pem = `-----BEGIN PUBLIC KEY-----\n${(encryption.key.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----`;
    return { publicKeyId: encryption.id, publicKeyPem: pem };
  }

  /** Official §7.2: sign the invoice JSON as a compact JWS — header
   *  {alg: RS256, x5c: [cert], sigT: ISO-8601, crit: [sigT]}, payload =
   *  the invoice JSON (utf8 → Base64URL), RSASSA-PKCS1-v1_5 SHA-256. */
  static signInvoiceJws(
    invoiceJson: string,
    privateKeyPem: string,
    certificatePem: string,
    sigT = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  ): string {
    const headerB64 = Buffer.from(
      JSON.stringify({
        alg: 'RS256',
        x5c: [
          certificatePem
            .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, '')
            .replace(/[\r\n]+/g, '')
            .trim(),
        ],
        sigT,
        crit: ['sigT'],
      }),
    ).toString('base64url');
    const payloadB64 = Buffer.from(invoiceJson, 'utf8').toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    return `${signingInput}.${signer.sign(privateKeyPem, 'base64url')}`;
  }

  /** Official §7.3: encrypt the signed JWS into a compact JWE — protected
   *  header {alg: RSA-OAEP-256, enc: A256GCM, kid}, fresh 256-bit CEK
   *  wrapped with RSA-OAEP-256 under the server's 4096-bit public key,
   *  fresh 96-bit IV, AAD = ASCII(Base64URL(header)). */
  static encryptInvoiceJwe(signedJws: string, serverPublicKeyPem: string, keyId: string): string {
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: keyId }),
    ).toString('base64url');
    const cek = crypto.randomBytes(32);
    const encryptedKey = crypto.publicEncrypt(
      { key: serverPublicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      cek,
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', cek, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(headerB64, 'ascii'));
    const ciphertext = Buffer.concat([cipher.update(signedJws, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      headerB64,
      encryptedKey.toString('base64url'),
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  /** Official §7: submit invoices — each packet's invoice JSON is signed
   *  (JWS) then encrypted (JWE) and sent as
   *  { payload, header: { requestTraceId, fiscalId } }; the response echoes
   *  OUR requestTraceId back as `uid` (§7/§8). The official response has NO
   *  errorCode field — content errors surface at INQUIRY time (§8). */
  async enqueue(packets: MoadianPacket[]): Promise<MoadianAsyncResponse[]> {
    if (packets.length > 100) throw new Error('MOADIAN_PACKET_LIMIT: max 100 invoices per request');
    const token = (await this.getToken()).token;
    const org = await this.getServerInformation();
    const envelope = packets.map((p) => {
      const signed = MoadianHttpAdapter.signInvoiceJws(p.data, this.privateKeyPem, this.certificatePem);
      const payload = MoadianHttpAdapter.encryptInvoiceJwe(signed, org.publicKeyPem, org.publicKeyId);
      return { payload, header: { requestTraceId: p.uid, fiscalId: p.fiscalId || this.fiscalId } };
    });
    const res = await this.fetchImpl(`${this.base}/invoice`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) throw new Error(`MOADIAN_INVOICE_FAILED:${res.status}`);
    const body = (await res.json()) as { result?: Array<{ uid?: string; referenceNumber?: string }> };
    return (body.result ?? []).map((r) => ({ uid: r.uid ?? '', referenceNumber: r.referenceNumber ?? '' }));
  }

  /** Official §8.2: GET /inquiry-by-uid with REPEATED uidList query params
   *  + fiscalId. Statuses SUCCESS | FAILED | IN_PROGRESS | NOT_FOUND;
   *  IN_PROGRESS and NOT_FOUND are INCONCLUSIVE for our state machines and
   *  map to PENDING (never blind-resend on an inconclusive answer). */
  async inquiryByUid(uids: string[]): Promise<MoadianInquiryResult[]> {
    const token = (await this.getToken()).token;
    const params = new URLSearchParams();
    for (const uid of uids) params.append('uidList', uid);
    params.append('fiscalId', this.fiscalId);
    const res = await this.fetchImpl(`${this.base}/inquiry-by-uid?${params.toString()}`, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    });
    if (!res.ok) throw new Error(`MOADIAN_INQUIRY_FAILED:${res.status}`);
    const body = (await res.json()) as Array<{
      uid?: string;
      status?: string;
      referenceNumber?: string;
      data?: { error?: Array<{ code?: string; message?: string }>; warning?: unknown[]; success?: boolean };
      sign?: string;
    }>;
    return (Array.isArray(body) ? body : []).map((r) => ({
      uid: r.uid ?? '',
      status:
        r.status === 'SUCCESS'
          ? ('SUCCESS' as const)
          : r.status === 'FAILED'
            ? ('FAILED' as const)
            : ('PENDING' as const),
      referenceNumber: r.referenceNumber ?? undefined,
      errorCode: r.data?.error?.[0]?.code ?? undefined,
      errorDetail: r.data?.error?.[0]?.message ?? undefined,
      confirmationReferenceId: r.status === 'SUCCESS' ? r.referenceNumber ?? undefined : undefined,
      taxResult: r.sign ?? undefined,
    }));
  }
}
