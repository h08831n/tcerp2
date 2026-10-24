import { MoadianInquiryResult, MoadianToken } from './moadian-adapter';
import type { MoadianPacket } from './moadian-adapter';

/** Shared deterministic fake Moadian adapter for offline tests. */
export class FakeMoadianAdapter {
  inquiryQueue: Array<'PENDING' | 'SUCCESS' | 'FAILED'> = [];
  enqueued: Array<{ uid: string; retry: boolean }> = [];
  inquiries = 0;

  async getToken(): Promise<MoadianToken> {
    return { token: 'fake-token-for-diagnostics', expiresInSeconds: 900 };
  }
  async enqueue(packets: MoadianPacket[]) {
    this.enqueued.push(...packets.map((p) => ({ uid: p.uid, retry: p.retry })));
    return packets.map((p) => ({ uid: p.uid, referenceNumber: `ref-${p.uid.slice(0, 8)}` }));
  }
  async inquiryByUid(uids: string[]): Promise<MoadianInquiryResult[]> {
    this.inquiries += uids.length;
    return uids.map((uid) => {
      const next = this.inquiryQueue.shift() ?? 'SUCCESS';
      if (next === 'PENDING') return { uid, status: 'PENDING' as const };
      if (next === 'FAILED')
        return { uid, status: 'FAILED' as const, errorCode: 'CONTENT', errorDetail: 'Duplicate tax id' };
      return {
        uid,
        status: 'SUCCESS' as const,
        confirmationReferenceId: `conf-${uid.slice(0, 8)}`,
        taxResult: 'fake-tax-result',
      };
    });
  }
  async getServerInformation() {
    return { publicKeyId: 'fake', publicKeyPem: 'fake' };
  }
}
