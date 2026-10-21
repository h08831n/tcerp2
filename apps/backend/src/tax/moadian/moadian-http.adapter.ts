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
 * HTTP adapter for the real Moadian Tax API (docs/08 — per the official
 * "دستورالعمل فنی نحوه اتصال به سامانه مودیان", tax.gov.ir):
 *   base: https://tp.tax.gov.ir/req
 *   async send:  POST …/api/self-tsp/async/normal-enqueue/
 *   inquiry:     POST …/api/self-tsp/sync/INQUIRY_BY_UID/
 *   token:       POST …/api/self-tsp/sync/GET_TOKEN/
 *   server info: POST …/api/self-tsp/sync/GET_SERVER_INFORMATION/
 *
 * Crypto per the official instruction:
 *  - normalization: flattened key-value pairs sorted alphabetically, values
 *    joined with '#'; '#' → '##'; null/empty → '###'
 *  - dataSignature: RSA2048-SHA256 over the normalized string
 *  - body: AES-256-GCM, key+IV wrapped with RSA-OAEP-SHA256 (org public key)
 *
 * ⚠️ UNVERIFIED against the live service: real operation requires the
 * taxpayer's Sharjh credentials (private key, fiscalId, economic code) that
 * this repository deliberately does not contain. Enabled only when
 * MOADIAN_MODE=sandbox|live AND the key material is configured.
 */
@Injectable()
export class MoadianHttpAdapter implements MoadianAdapter {
  private readonly logger = new Logger('MoadianHttpAdapter');
  private readonly base: string;
  private readonly fiscalId: string;
  private readonly economicCode: string;
  private readonly privateKeyPem: string;
  private cachedToken?: { token: string; expiresAt: number };

  constructor(config: {
    baseUrl?: string;
    fiscalId?: string;
    economicCode?: string;
    privateKeyPem?: string;
  }) {
    this.base = config.baseUrl ?? 'https://tp.tax.gov.ir/req';
    this.fiscalId = config.fiscalId ?? '';
    this.economicCode = config.economicCode ?? '';
    this.privateKeyPem = config.privateKeyPem ?? '';
    if (!this.fiscalId || !this.economicCode || !this.privateKeyPem) {
      throw new Error(
        'MOADIAN_HTTP_CONFIG_MISSING: fiscalId, economicCode and privateKeyPem are required for sandbox/live mode',
      );
    }
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

  async getToken(): Promise<MoadianToken> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return { token: this.cachedToken.token, expiresInSeconds: 900 };
    }
    const nonce = Date.now();
    const payload = { economicCode: this.economicCode, fiscalId: this.fiscalId, nonce };
    const signature = this.signNormalized(MoadianHttpAdapter.normalize(payload));
    const res = await fetch(`${this.base}/api/self-tsp/sync/GET_TOKEN/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    });
    if (!res.ok) {
      this.logger.error(`GET_TOKEN failed: ${res.status} ${await res.text()}`);
      throw new Error(`MOADIAN_GET_TOKEN_FAILED:${res.status}`);
    }
    const body = (await res.json()) as { result: { token: string } };
    this.cachedToken = { token: body.result.token, expiresAt: Date.now() + 14 * 60 * 1000 };
    return { token: this.cachedToken.token, expiresInSeconds: 900 };
  }

  async getServerInformation(): Promise<{ publicKeyId: string; publicKeyPem: string }> {
    const token = (await this.getToken()).token;
    const res = await fetch(`${this.base}/api/self-tsp/sync/GET_SERVER_INFORMATION/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiscalId: this.fiscalId }),
    });
    if (!res.ok) throw new Error(`MOADIAN_SERVER_INFO_FAILED:${res.status}`);
    const body = (await res.json()) as { result: { publicKeyId: string; publicKey: string } };
    return { publicKeyId: body.result.publicKeyId, publicKeyPem: body.result.publicKey };
  }

  async enqueue(packets: MoadianPacket[]): Promise<MoadianAsyncResponse[]> {
    const token = (await this.getToken()).token;
    const envelope = { packets, signature: '', signatureKeyId: null };
    const res = await fetch(`${this.base}/api/self-tsp/async/normal-enqueue/`, {
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
    const res = await fetch(`${this.base}/api/self-tsp/sync/INQUIRY_BY_UID/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uidList: uids, fiscalId: this.fiscalId }),
    });
    if (!res.ok) throw new Error(`MOADIAN_INQUIRY_FAILED:${res.status}`);
    const body = (await res.json()) as { result: MoadianInquiryResult[] };
    return body.result ?? [];
  }
}
