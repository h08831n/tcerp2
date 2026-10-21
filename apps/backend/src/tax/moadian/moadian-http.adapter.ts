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
 *   server info: GET …/server-information  (Bearer <JWS>)
 *   NOTE: the older نسخه اول flow (`…/req/…`, GET_TOKEN packet) is
 *   SUPERSEDED — see docs/08 for the version discrepancy record.
 *
 * ⚠️ UNVERIFIED against the live service: real operation requires the
 * taxpayer's Sharjh credentials (private key + certificate + clientId +
 * fiscalId) supplied at runtime — never stored in this repository.
 */
@Injectable()
export class MoadianHttpAdapter implements MoadianAdapter {
  private readonly logger = new Logger('MoadianHttpAdapter');
  private readonly base: string;
  private readonly fiscalId: string;
  private readonly economicCode: string;
  private readonly clientId: string;
  private readonly privateKeyPem: string;
  private readonly certificatePem?: string;

  constructor(config: {
    baseUrl?: string;
    fiscalId?: string;
    economicCode?: string;
    privateKeyPem?: string;
    clientId?: string;
    certificatePem?: string;
  }) {
    this.base = config.baseUrl ?? 'https://tp.tax.gov.ir/requestsmanager/api/v2';
    this.fiscalId = config.fiscalId ?? '';
    this.economicCode = config.economicCode ?? '';
    this.clientId = config.clientId ?? '';
    this.privateKeyPem = config.privateKeyPem ?? '';
    this.certificatePem = config.certificatePem;
    if (!this.fiscalId || !this.economicCode || !this.privateKeyPem || !this.clientId) {
      throw new Error(
        'MOADIAN_HTTP_CONFIG_MISSING: fiscalId, economicCode, clientId and privateKeyPem are required for sandbox/live mode',
      );
    }
  }

  /** نسخه دوم auth: GET nonce → build JWS (RS256, x5c cert, sigT, crit) →
   *  the JWS itself is the Bearer credential for subsequent calls. */
  buildJws(nonce: string, sigT = new Date().toISOString()): string {
    const b64url = (input: Buffer | string) =>
      Buffer.from(input).toString('base64url');
    const cert = this.certificatePem
      ? this.certificatePem
          .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, '')
          .replace(/[\r\n]+/g, '')
          .trim()
      : undefined;
    const header: Record<string, unknown> = { alg: 'RS256', sigT, crit: ['sigT'] };
    if (cert) header.x5c = [cert];
    const encodedHeader = b64url(JSON.stringify(header));
    const encodedPayload = b64url(JSON.stringify({ nonce, clientId: this.clientId }));
    const dataToSign = `${encodedHeader}.${encodedPayload}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(dataToSign);
    const signature = signer.sign(this.privateKeyPem);
    return `${dataToSign}.${b64url(signature)}`;
  }

  private async getNonce(): Promise<string> {
    const res = await fetch(`${this.base}/nonce?timeToLive=200`);
    if (!res.ok) throw new Error(`MOADIAN_NONCE_FAILED:${res.status}`);
    const body = (await res.json()) as { nonce?: string };
    if (!body.nonce) throw new Error('MOADIAN_NONCE_MISSING');
    return body.nonce;
  }

  /** Official normalization: sorted flat key-values joined with '#'. */
  static normalize(payload: Record<string, unknown>): string {
    const flat: Array<[string, string]> = [];
    const walk = (prefix: string, value: unknown) => {
      if (value === null || value === undefined || value === '') return;
      if (Array.isArray(value)) {
        value.forEach((v) => walk(prefix, v));
      } else if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(`${prefix}.${k}`, v);
      } else {
        flat.push([prefix, String(value).replace(/#/g, '##')]);
      }
    };
    walk('', payload);
    flat.sort(([a], [b]) => a.localeCompare(b));
    return flat.map(([k, v]) => `${k}#${v}`).join('#') || '###';
  }

  signNormalized(normalized: string): string {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(normalized);
    return signer.sign(this.privateKeyPem, 'base64');
  }

  /** نسخه دوم: Bearer credential = the JWS built from a fresh nonce. */
  async getToken(): Promise<MoadianToken> {
    const nonce = await this.getNonce();
    const jws = this.buildJws(nonce);
    return { token: jws, expiresInSeconds: 200 }; // nonce TTL 10..200s
  }

  async getServerInformation(): Promise<{ publicKeyId: string; publicKeyPem: string }> {
    const token = (await this.getToken()).token;
    const res = await fetch(`${this.base}/server-information`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    });
    if (!res.ok) throw new Error(`MOADIAN_SERVER_INFO_FAILED:${res.status}`);
    const body = (await res.json()) as { result: { publicKeyId: string; publicKey: string } };
    return { publicKeyId: body.result.publicKeyId, publicKeyPem: body.result.publicKey };
  }

  async enqueue(packets: MoadianPacket[]): Promise<MoadianAsyncResponse[]> {
    const token = (await this.getToken()).token;
    const envelope = { packets, signature: '', signatureKeyId: null };
    const res = await fetch(`${this.base}/normal-enqueue`, {
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
    const res = await fetch(`${this.base}/INQUIRY_BY_UID`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uidList: uids, fiscalId: this.fiscalId }),
    });
    if (!res.ok) throw new Error(`MOADIAN_INQUIRY_FAILED:${res.status}`);
    const body = (await res.json()) as { result: MoadianInquiryResult[] };
    return body.result ?? [];
  }
}
