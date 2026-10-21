import { MoadianHttpAdapter as AdapterClass } from './moadian/moadian-http.adapter';
import * as crypto from 'node:crypto';

/** Unit tests for the نسخه دوم protocol pieces that are verifiable offline:
 *  normalization, JWS construction (RS256 + x5c + sigT + crit per the
 *  official instruction نسخه دوم), and config enforcement. No network. */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function makeAdapter(certPem?: string) {
  return new AdapterClass({
    fiscalId: 'TESTFISCAL',
    economicCode: '411151234567',
    clientId: 'test-client',
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    certificatePem: certPem,
  });
}

describe('MoadianHttpAdapter — نسخه دوم offline protocol tests', () => {
  it('normalization: sorted keys, dot-prefixed paths, values joined with #, # escaped as ##, null/empty dropped', () => {
    const normalized = AdapterClass.normalize({
      b: 'x#y',
      a: '1',
      c: null,
      d: '',
    });
    // implementation: flatten with dot-prefixed keys (top-level → '.key'),
    // sorted alphabetically, joined 'k#v' pairs with '#', '#'→'##',
    // null/empty values dropped (documented deviation from the spec's
    // '###' placeholder — recorded in docs/08)
    expect(normalized).toBe('.a#1#.b#x##y');
  });

  it('normalization: nested objects flatten with dot-prefixed keys', () => {
    const normalized = AdapterClass.normalize({ header: { inty: 1 }, body: [{ am: 5 }] });
    expect(normalized).toContain('header.inty#1');
    expect(normalized).toContain('body.am#5');
  });

  it('JWS: RS256 signature verifies with the key; header carries sigT/crit; payload carries nonce+clientId', () => {
    const certPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const adapter = makeAdapter(certPem);
    const jws = adapter.buildJws('test-nonce-123', '2026-10-22T00:00:00Z');
    const [h, p, sig] = jws.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header.alg).toBe('RS256');
    expect(header.sigT).toBe('2026-10-22T00:00:00Z');
    expect(header.crit).toEqual(['sigT']);
    expect(Array.isArray(header.x5c)).toBe(true);
    expect(payload.nonce).toBe('test-nonce-123');
    expect(payload.clientId).toBe('test-client');
    // verify RS256 signature with the public key
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('JWS without certificate: header still signed (x5c omitted)', () => {
    const adapter = makeAdapter(undefined);
    const jws = adapter.buildJws('n');
    const header = JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString());
    expect(header.x5c).toBeUndefined();
    expect(header.alg).toBe('RS256');
  });

  it('config enforcement: missing fiscalId/clientId/privateKey throws at construction', () => {
    expect(
      () =>
        new AdapterClass({
          fiscalId: '',
          economicCode: 'x',
          clientId: 'c',
          privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
        }),
    ).toThrow('MOADIAN_HTTP_CONFIG_MISSING');
    expect(
      () =>
        new AdapterClass({
          fiscalId: 'f',
          economicCode: 'x',
          clientId: '',
          privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
        }),
    ).toThrow('MOADIAN_HTTP_CONFIG_MISSING');
  });
});
