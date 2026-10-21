/**
 * Moadian adapter contract (Phase 8, docs/08).
 *
 * The technical flow follows the official "دستورالعمل فنی نحوه اتصال به
 * سامانه مودیان" (technical instructions for connecting to the Iranian
 * Moadian system, tax.gov.ir — mirrored at rahrokh.com): the whole migration
 * of an invoice packet to `https://tp.tax.gov.ir/req/` works through
 * async enqueue (normal/fast) + sync inquiry, with packets that carry a
 * client `uid`, a `packetType` (INVOICE.V01), a `retry` flag, and an
 * RSA2048-SHA256 `dataSignature` over the normalized JSON.
 *
 * NOTHING in this file invents legal/API details: every field below maps to
 * the fetched official instruction. The HTTP adapter is UNVERIFIED against
 * the live service until real Sharjh credentials (private key + fiscalId +
 * economic code) are supplied at runtime — mock mode is the default.
 */

export interface MoadianConfig {
  mode: 'mock' | 'sandbox' | 'live';
  baseUrl?: string; // default https://tp.tax.gov.ir/req
  fiscalId?: string; // شناسه یکتای حافظه مالیاتی
  economicCode?: string; // شناسه ملی/کد اقتصادی مودی
  privateKeyPem?: string; // signer key (RSA2048-SHA256 normalization signature)
}

/** One packet = one invoice send attempt (official packet fields). */
export interface MoadianPacket {
  uid: string; // client-generated unique send id
  packetType: string; // e.g. INVOICE.V01
  retry: boolean; // official spec: must be true on resubmission after FAILED
  data: string; // serialized invoice JSON (encrypted or plaintext)
  encryptionKeyId: string; // org public key id (empty when unencrypted)
  symmetricKey: string; // RSA-OAEP wrapped AES key (empty when unencrypted)
  iv: string; // AES IV (empty when unencrypted)
  fiscalId: string;
  dataSignature: string; // RSA2048-SHA256 over the normalized JSON
}

export interface MoadianAsyncResponse {
  uid: string;
  referenceNumber: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface MoadianInquiryResult {
  uid: string;
  referenceNumber?: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  errorCode?: string;
  errorDetail?: string;
  confirmationReferenceId?: string;
  taxResult?: string;
}

export interface MoadianToken {
  token: string;
  expiresInSeconds: number;
}

/** NestJS injection token (interfaces are types only). */
export const MOADIAN_ADAPTER = Symbol('MOADIAN_ADAPTER');

export interface MoadianAdapter {
  /** GET_TOKEN (sync) — JWT for async enqueue calls. */
  getToken(): Promise<MoadianToken>;
  /** normal-enqueue (async) — send invoice packets. */
  enqueue(packets: MoadianPacket[]): Promise<MoadianAsyncResponse[]>;
  /** INQUIRY_BY_UID (sync) — per-uid submission results. */
  inquiryByUid(uids: string[]): Promise<MoadianInquiryResult[]>;
  /** GET_SERVER_INFORMATION — org public key id + key (for encryption). */
  getServerInformation(): Promise<{ publicKeyId: string; publicKeyPem: string }>;
}
