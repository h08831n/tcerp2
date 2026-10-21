import { Injectable, Logger } from '@nestjs/common';
import {
  MoadianAdapter,
  MoadianAsyncResponse,
  MoadianInquiryResult,
  MoadianPacket,
  MoadianToken,
} from './moadian-adapter';

/**
 * Deterministic mock of the Moadian authority (default MOADIAN_MODE=mock).
 *
 * Behavior:
 *  - enqueue: ALWAYS accepts — returns a referenceNumber derived from the uid.
 *  - inquiry: packets whose uid ends in 'f' (or data containing
 *    `"mockResult":"FAILED"`) report FAILED with the official-style content
 *    error; everything else reports SUCCESS with a confirmationReferenceId
 *    after its first inquiry, and PENDING on the same-uid FIRST inquiry…
 *    No: deterministic and simple — first inquiry per uid returns PENDING
 *    unless a failure marker is present; second inquiry returns the final
 *    state. This exercises the real client lifecycle (enqueue → pending →
 *    final) without randomness.
 *  - getToken: mock JWT with a fixed 15-minute expiry.
 */
@Injectable()
export class MockMoadianAdapter implements MoadianAdapter {
  private readonly logger = new Logger('MockMoadianAdapter');
  private readonly pendingSeen = new Set<string>();

  async getToken(): Promise<MoadianToken> {
    return { token: 'mock-token', expiresInSeconds: 900 };
  }

  async enqueue(packets: MoadianPacket[]): Promise<MoadianAsyncResponse[]> {
    if (packets.length > 100) {
      // official limit 5006 packet.size.is.too.large
      return packets.map((p) => ({
        uid: p.uid,
        referenceNumber: '',
        errorCode: '5006',
        errorDetail: 'packet.size.is.too.large',
      }));
    }
    return packets.map((p) => {
      if (p.data.includes('"mockResult":"REJECTED"')) {
        return {
          uid: p.uid,
          referenceNumber: '',
          errorCode: '5001',
          errorDetail: 'bad.request',
        };
      }
      return {
        uid: p.uid,
        referenceNumber: `mock-ref-${p.uid.slice(0, 8)}`,
      };
    });
  }

  async inquiryByUid(uids: string[]): Promise<MoadianInquiryResult[]> {
    return uids.map((uid) => {
      const firstPass = !this.pendingSeen.has(uid);
      this.pendingSeen.add(uid);
      // content failure marker → FAILED deterministically on every inquiry
      if (uid.endsWith('f') || uid.includes('failed')) {
        return {
          uid,
          status: 'FAILED' as const,
          errorCode: 'CONTENT',
          errorDetail: 'Duplicate tax id (mock)',
        };
      }
      if (firstPass) {
        return { uid, status: 'PENDING' as const };
      }
      this.logger.debug(`mock inquiry final success for ${uid}`);
      return {
        uid,
        status: 'SUCCESS' as const,
        confirmationReferenceId: `mock-confirm-${uid.slice(0, 8)}`,
        taxResult: 'mock-tax-result',
      };
    });
  }

  async getServerInformation() {
    return { publicKeyId: 'mock-public-key', publicKeyPem: 'mock-public-key-pem' };
  }
}
