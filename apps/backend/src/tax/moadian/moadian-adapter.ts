/**
 * Moadian adapter contract (Phase 8 — OFFICIAL protocol RC_TICS.IS_v1.6,
 * شهریور ۱۴۰۴, retrieved from www.intamedia.ir).
 *
 * Official flow (§5-§8): nonce (GET, timeToLive 10..200) → JWS Bearer token
 * (RS256/x5c/sigT/crit over {nonce, clientId}, single-use per request) →
 * server-information (publicKeys[], purpose 1 = encryption) → invoice
 * submission as `POST /api/v2/invoice` with
 * [{ payload: JWE, header: { requestTraceId, fiscalId } }] where the payload
 * is the invoice JSON signed (§7.2 JWS) then encrypted (§7.3 JWE,
 * RSA-OAEP-256 + A256GCM) — the response `uid` echoes OUR requestTraceId →
 * status inquiry via `GET /api/v2/inquiry-by-uid?uidList=…&fiscalId=…`
 * (SUCCESS | FAILED | IN_PROGRESS | NOT_FOUND).
 *
 * The older mirror-era contracts (normal-enqueue packets, normalization +
 * dataSignature, XOR-whitening, INQUIRY_BY_UID POST, error 5005) DO NOT
 * exist in the official document and are not part of this contract.
 *
 * NOTHING here invents legal/API details. The HTTP adapter is UNVERIFIED
 * against the live service until real Sharjh credentials (private key +
 * certificate + clientId + fiscalId) are supplied at runtime — mock mode is
 * the default and mock/simulated success is never real connectivity.
 */

export interface MoadianConfig {
  mode: 'mock' | 'sandbox' | 'live';
  baseUrl?: string; // default https://tp.tax.gov.ir/req
  fiscalId?: string; // شناسه یکتای حافظه مالیاتی
  economicCode?: string; // شناسه ملی/کد اقتصادی مودی
  privateKeyPem?: string; // signer key (RSA2048-SHA256 normalization signature)
}

/** One packet = one invoice send attempt. WIRE USAGE (official v1.6):
 *  `uid` becomes header.requestTraceId, `data` (invoice JSON) is signed and
 *  encrypted into the JWE payload, `fiscalId` fills the envelope header.
 *  The remaining fields are INTERNAL bookkeeping/history only — they are
 *  never placed on the wire (retry is our resubmission bookkeeping; the
 *  crypto fields belong to the retired mirror-era envelope). */
export interface MoadianPacket {
  uid: string; // client-generated unique send id (== official requestTraceId)
  packetType: string; // internal classification (not sent on the v1.6 wire)
  retry: boolean; // internal bookkeeping: true on resubmission after FAILED
  data: string; // serialized invoice JSON (signed + encrypted by the adapter)
  encryptionKeyId: string; // legacy bookkeeping (not on the v1.6 wire)
  symmetricKey: string; // legacy bookkeeping (not on the v1.6 wire)
  iv: string; // legacy bookkeeping (not on the v1.6 wire)
  fiscalId: string;
  dataSignature: string; // legacy bookkeeping (not on the v1.6 wire)
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
  /** §5 auth: nonce → JWS Bearer (single-use per request). */
  getToken(): Promise<MoadianToken>;
  /** §7: POST /invoice — send signed+encrypted invoice payloads. */
  enqueue(packets: MoadianPacket[]): Promise<MoadianAsyncResponse[]>;
  /** §8.2: GET /inquiry-by-uid — per-uid submission results. */
  inquiryByUid(uids: string[]): Promise<MoadianInquiryResult[]>;
  /** §6: GET /server-information — purpose-1 encryption public key. */
  getServerInformation(): Promise<{ publicKeyId: string; publicKeyPem: string }>;
}
