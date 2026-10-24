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
 * HTTP adapter for the real Moadian Tax API — CURRENT applicable protocol:
 * «دستورالعمل فنی نحوه اتصال به سامانه مودیان» **نسخه دوم** (tax.gov.ir;
 * mirrored BaseMax/moadian-api-example, README dated 2025-05-25):
 *   base:    https://tp.tax.gov.ir/requestsmanager/api/v2
 *   nonce:   GET  …/nonce?timeToLive={10..200}        → { nonce, expDate }
 *   JWS:     RS256 over base64url(header).base64url(payload) where
 *            header = { alg: RS256, x5c: [cert], sigT: ISO-8601, crit: [sigT] }
 *            payload = { nonce, clientId }
 *   server info: GET …/server-information  (Bearer <JWS>) → org public key
 *   NOTE: the older نسخه اول flow (`…/req/…`, GET_TOKEN packet) is
 *   SUPERSEDED — see docs/08 for the version discrepancy record.
 *
 * Crypto per the official instruction:
 *  - normalization: flattened key=value pairs, keys sorted alphabetically,
 *    pairs joined with '#'; '#' inside values → '##'; null/empty → '###'
 *    placeholder; arrays flattened with index (body.0.field) — the exact
 *    official array-index sample is UNVERIFIED (flagged in docs/08)
 *  - dataSignature: RSA2048-SHA256 over the normalized invoice string
 *  - data: XOR-whitened with the AES key in 256-bit blocks, then AES-256-GCM
 *  - key material: AES key + IV wrapped with RSA-OAEP-SHA256 (org public key)
 *  - envelope signature: RSA2048-SHA256 over the normalized packets JSON
 *
 * ⚠️ UNVERIFIED against the live service: real operation requires the
 * taxpayer's Sharjh credentials (private key + X.509 certificate + clientId +
 * fiscalId) supplied at runtime — never stored in this repository. The
 * XOR-whitening and key-wrap concatenation order follow the instruction text
 * and are UNVERIFIED.
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

  /** نسخه دوم auth: GET nonce → build JWS (RS256, x5c cert, sigT, crit) →
   *  the JWS itself is the Bearer credential for subsequent calls. */
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
    const res = await this.fetchImpl(`${this.base}/nonce?timeToLive=200`);
    if (!res.ok) throw new Error(`MOADIAN_NONCE_FAILED:${res.status}`);
    const body = (await res.json()) as { nonce?: string };
    if (!body.nonce) throw new Error('MOADIAN_NONCE_MISSING');
    return body.nonce;
  }

  /** Official normalization (signature section of the instruction, verified
   *  against the canonical Table 1 example): flatten with dotted paths
   *  (arrays as key.0.field — per the C# appendix; the Java appendix uses
   *  key.E0), sort pairs by key alphabetically, then output the VALUES ONLY
   *  joined with '#'. '#' inside values → '##'. null/undefined/'' render as
   *  an EMPTY slot (the doc's ### notation describes the empty position, not
   *  literal characters). Table 1: {k2:v1, k4:v2, k3:{k1:v4, k5:v5}} →
   *  'v1#v4#v5#v2'. Array index form (key.0 vs key.E0) is UNVERIFIED against
   *  a live response — the two appendices of the instruction differ. */
  static normalize(payload: Record<string, unknown>): string {
    const pairs: Array<[string, string]> = [];
    const walk = (prefix: string, value: unknown) => {
      const key = prefix.startsWith('.') ? prefix.slice(1) : prefix;
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(`${prefix}.${i}`, v));
      } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) walk(`${prefix}.${k}`, v);
      } else {
        const rendered =
          value === null || value === undefined || value === ''
            ? ''
            : String(value).replace(/#/g, '##');
        pairs.push([key, rendered]);
      }
    };
    walk('', payload);
    pairs.sort(([a], [b]) => a.localeCompare(b));
    return pairs.map(([, v]) => v).join('#');
  }

  signNormalized(normalized: string, privateKeyPem = this.privateKeyPem): string {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(normalized);
    return signer.sign(privateKeyPem, 'base64');
  }

  /** نسخه دوم: Bearer credential = the JWS built from a fresh nonce. */
  async getToken(): Promise<MoadianToken> {
    const nonce = await this.getNonce();
    const jws = this.buildJws(nonce);
    return { token: jws, expiresInSeconds: 200 }; // nonce TTL 10..200s
  }

  async getServerInformation(): Promise<{ publicKeyId: string; publicKeyPem: string }> {
    const token = (await this.getToken()).token;
    const res = await this.fetchImpl(`${this.base}/server-information`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    });
    if (!res.ok) throw new Error(`MOADIAN_SERVER_INFO_FAILED:${res.status}`);
    const body = (await res.json()) as { result: { publicKeyId: string; publicKey: string } };
    return { publicKeyId: body.result.publicKeyId, publicKeyPem: body.result.publicKey };
  }

  /** Official packet crypto: XOR-whiten the JSON with the AES key in
   *  256-bit blocks, AES-256-GCM encrypt, wrap (AES key ‖ IV) with
   *  RSA-OAEP-SHA256 under the org public key, and RSA-sign the normalized
   *  invoice. UNVERIFIED end-to-end (needs live server information). */
  static preparePacket(
    packet: MoadianPacket,
    orgPublicKeyPem: string,
    signerPrivateKeyPem: string,
  ): MoadianPacket {
    const invoice = JSON.parse(packet.data) as Record<string, unknown>;
    const normalized = MoadianHttpAdapter.normalize(invoice);
    const dataSignature = (() => {
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(normalized);
      return signer.sign(signerPrivateKeyPem, 'base64');
    })();

    const aesKey = crypto.randomBytes(32); // AES-256
    const iv = crypto.randomBytes(12);
    // XOR whitening per the instruction: XOR the JSON bytes with the AES key
    // in 256-bit (32-byte) blocks
    const plain = Buffer.from(packet.data, 'utf8');
    const whitened = Buffer.alloc(plain.length);
    for (let offset = 0; offset < plain.length; offset += 32) {
      for (let i = 0; i < 32 && offset + i < plain.length; i += 1) {
        whitened[offset + i] = plain[offset + i] ^ aesKey[i];
      }
    }
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(whitened), cipher.final(), cipher.getAuthTag()]);
    // wrap (AES key ‖ IV) with RSA-OAEP-SHA256 (org public key)
    const wrapped = crypto.publicEncrypt(
      { key: orgPublicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.concat([aesKey, iv]),
    );

    return {
      ...packet,
      data: encrypted.toString('base64'),
      dataSignature,
      symmetricKey: wrapped.toString('base64'),
      iv: iv.toString('base64'),
    };
  }

  /** envelope.signature = RSA2048-SHA256 over the normalized packets JSON. */
  static envelopeSignature(packets: MoadianPacket[], privateKeyPem: string): string {
    const normalized = MoadianHttpAdapter.normalize({ packets });
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(normalized);
    return signer.sign(privateKeyPem, 'base64');
  }

  async enqueue(packets: MoadianPacket[]): Promise<MoadianAsyncResponse[]> {
    if (packets.length > 100) throw new Error('MOADIAN_PACKET_LIMIT: max 100 packets per enqueue (official 5006)');
    const token = (await this.getToken()).token;
    const org = await this.getServerInformation();
    const prepared = packets.map((p) =>
      MoadianHttpAdapter.preparePacket(p, org.publicKeyPem, this.privateKeyPem),
    );
    const envelope = {
      packets: prepared,
      signature: MoadianHttpAdapter.envelopeSignature(prepared, this.privateKeyPem),
      signatureKeyId: org.publicKeyId,
    };
    const res = await this.fetchImpl(`${this.base}/normal-enqueue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) throw new Error(`MOADIAN_ENQUEUE_FAILED:${res.status}`);
    const body = (await res.json()) as { result: MoadianAsyncResponse[] };
    return body.result ?? [];
  }

  async inquiryByUid(uids: string[]): Promise<MoadianInquiryResult[]> {
    const token = (await this.getToken()).token;
    const res = await this.fetchImpl(`${this.base}/INQUIRY_BY_UID`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uidList: uids, fiscalId: this.fiscalId }),
    });
    if (!res.ok) throw new Error(`MOADIAN_INQUIRY_FAILED:${res.status}`);
    const body = (await res.json()) as { result: MoadianInquiryResult[] };
    return body.result ?? [];
  }
}
