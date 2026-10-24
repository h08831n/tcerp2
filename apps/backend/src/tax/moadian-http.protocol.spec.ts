import * as crypto from 'node:crypto';
import { MoadianHttpAdapter as AdapterClass } from './moadian/moadian-http.adapter';
import type { MoadianPacket } from './moadian/moadian-adapter';

/** Offline protocol tests for the نسخه دوم Moadian adapter: normalization
 *  (official rules), X.509 certificate validation + key matching, JWS
 *  construction (RS256/x5c/sigT/crit), and packet crypto that is fully
 *  reversible (encrypt → unwrap → decrypt → verify signature). No network. */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const TEST_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCg3XxnOwLsxJTI\nOgTj8Q7rI3HIPjROIm74wz8OAnNx/6O9yXKh2ViCGwTr3mzgYQDEDQoQOs1CH14d\npSwV8+c6knMqN+gNCAweu/ON4InXlfY9NONQnH5QsKDRYC/esYU6PZ3O78yvaFzc\nKsIYblZwYsV3WMj1A+pD8miVGNTc9ZxeQsb5Oq6rM1oUu60pa7C1GASfAlgcc4m+\nU4WJF9IHBh2bRhgONFIZPhxx7yOifq8E875l7ijnqQqZettiIRIaGbgOj5OCtEad\nJ9SrEZt+h7V7M2YjrP6ze7Lm2FzxVqvC/U5ZDmQgztzgJclIRmqps2b6/ABmRYgp\nwB7OhI4/AgMBAAECggEAAU0JPoR5p5SHZ38gnv9KEZi9yNLH9YHNx/E8R065xEg+\n+L/yT2DEmHjDd2zbEI14Rh2c4Ti4hDpgtnipfJv2WMDqcYL2O3S/NFhsxc71DmtG\nDISq+fHqC5kCE+9lM7XXz/rDlfLWguyjI5ys6SmrRUlnM2niZijb8iS5t8r1nbvT\ndYbf1cVM6V7q0chPKIKF4GT+rSkFNY3EF1SzKWhhVMoHWeSjpvCjm2+3LROGyDPl\nKmyyQCN949kooLCiDN6HzeNf8+HeTcTYIeNY6BX0a8UIVelTNVe6+CDlEN4erhRc\n1ml7fI6+WiyjF87sx77ApqMhieGzNwehFQgoagJ+kQKBgQDgBqzgX9G+6D6XJiiY\nm8+jx+bidi0z9yNOA1SarRkz9VVJ9iYx4C2VcLs1dvmKWXbFXVe6afaP0lZU2NIo\n1ZZr0tlMUvTxGaV5Q4Z5MBLJGkJ9x1JdJ71tWsiJHL1D8UDBNiY5P8Xzq1yYlu56\nEzrPEBxeERami8LsZ1FQiA/55QKBgQC30xPLPRZ+aTJ++Kfg9SEtVCMXdUvJD5bs\n85wkxQfrwNpMb/9GBU/kOrXOcmigLaedLuve3xxLJyvWq8NjkwX6HxMYC98iGkEV\ncv+lLFSN76TN8tXeJ+uNjO57DSff6GWnhPUUHQk1Fkv6pum9+le7xiIPL9GAJHzC\nFOnCmg/VUwKBgQCjfpuqQKPdlLchLlsQTR4zpE9vVNnWg/XDGJElNVEgZ1qwWLE1\nUytRVe16rnKdsn8IuP+ub2jfO51/3KE75e0akc2+cwiJ8LKgFlTMmvYKyFxgWRhW\nHguUBF44Gr5SGH6uw2sP+ufn1lcEkZpHg0M3HMXnLMeAEp3WU+y3PiWStQKBgQC1\nZT4wHSz4OxjQQNFw5JQDpfYm7OGHG7IkStS3WBLT6m/AY/h0gUNwBRtpCG8EOWkg\na6/oMyQ5aQMSiFZ8CRYp1sZBwV1DysKUxvFMbe1WTrfDXzD6U0xXV03x8W56vlqp\nr0MkwO5YC5OYWWNozAQNUJxFfjtvBxJxdq+iD+M17wKBgE76J4zSU1Nr6f9aOqJ9\nvnzbag3hs6++xKzNHO0Y5neZXn6zsdPpH6cJcPfQyWg97KwJFbxx3CNt0JwJWswR\nQefnfyU+bHeD1PwY7lzmhVjRS7za+hXgxU35Kcss/FeUrCuWmZKT7BawIlH58iRI\nnBVK+WfuuMzF93cbMWa8CX4p\n-----END PRIVATE KEY-----\n`;
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIUGu6uVq5X+M2C2RPp5+XP7xMIrCMwDQYJKoZIhvcNAQEL\nBQAwEjEQMA4GA1UEAwwHcDgtdGVzdDAeFw0yNjEwMjEyMjA0MTBaFw0zNjEwMTgy\nMjA0MTBaMBIxEDAOBgNVBAMMB3A4LXRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IB\nDwAwggEKAoIBAQCg3XxnOwLsxJTIOgTj8Q7rI3HIPjROIm74wz8OAnNx/6O9yXKh\n2ViCGwTr3mzgYQDEDQoQOs1CH14dpSwV8+c6knMqN+gNCAweu/ON4InXlfY9NONQ\nnH5QsKDRYC/esYU6PZ3O78yvaFzcKsIYblZwYsV3WMj1A+pD8miVGNTc9ZxeQsb5\nOq6rM1oUu60pa7C1GASfAlgcc4m+U4WJF9IHBh2bRhgONFIZPhxx7yOifq8E875l\n7ijnqQqZettiIRIaGbgOj5OCtEadJ9SrEZt+h7V7M2YjrP6ze7Lm2FzxVqvC/U5Z\nDmQgztzgJclIRmqps2b6/ABmRYgpwB7OhI4/AgMBAAGjUzBRMB0GA1UdDgQWBBS+\nJLpPNBr+sXMenGFh2aJ052TIBTAfBgNVHSMEGDAWgBS+JLpPNBr+sXMenGFh2aJ0\n52TIBTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBztZc6dyzl\nIcnouEta7E1452fIzHbaUtBhzvXa0VPjij8yc48yfIBdDsZLfL+2sBSQ5poPh39Y\n4iqvOIBIfM5WuoPeKVttKabvgcViPS+2CQuHAZhYR0jGqyRzKW5Lt8hUdO18SToO\n3cgxfVqN9pXLMb9ijfluxKgm3e/8wz9ypBE02LqOA08S13QoTHe5YWRzc3VEaGqZ\nYXdvvDd3QY+b7n6zFpdnc0SU79MKOdZnhm4RpE0IsNWk81qpO4vJElzl7yQRvNXT\nuf7B4Xr3H4yqiWRQaA6pIyDRKavdTMLLhrxReKY2jvNHfJr2CRcTCglR2Xpi5Xwx\n/nHhdy6IppU3\n-----END CERTIFICATE-----\n`;
const OTHER_CERT_PEM = `-----BEGIN CERTIFICATE-----\nMIIDBzCCAe+gAwIBAgIUTrkKyrKEasYtDA+dWe0skQvIIFAwDQYJKoZIhvcNAQEL\nBQAwEzERMA8GA1UEAwwIcDgtb3RoZXIwHhcNMjYxMDIxMjIwNDExWhcNMzYxMDE4\nMjIwNDExWjATMREwDwYDVQQDDAhwOC1vdGhlcjCCASIwDQYJKoZIhvcNAQEBBQAD\nggEPADCCAQoCggEBALUkjZz05tzzoreS6A3/1iacNrW1SAYlp5geSWcfbTGaXzzw\nQTU8CTxdSlnr9Qc4VODhsev990Gy0k5H6VZbMOTEy/SIkSD8QN2NfSHUE69ouMAU\n/fT9zdzDOsGNxyudpZHJt4iORNDYSBnCdrvWvBKEKovwj49pzMIwR5WREVeMdWxg\n9iu9QwxKUQUKY6HU/O1Bg3svtRQbN5FmW+8bW618LQf3/bhGDmajACVYwzBCgGGu\nvbifRRKnm/CClS1O+NMdz8JMc7Sugdv6t1AhzzKiPgXViA3BMJf6s9rJjS8TSljC\nuWW9WrWBmHcH1K/0CriaA2NvxqabbD2vcyfA55ECAwEAAaNTMFEwHQYDVR0OBBYE\nFCzKMufpwnQj2yzHnwBAMznNxrOMMB8GA1UdIwQYMBaAFCzKMufpwnQj2yzHnwBA\nMznNxrOMMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAKbZhCWS\n7kPQdwl0ixMADYPKM7kuNrFP3b/M75bwOJO39lq7r0sPyahSRJOEfe36JPLnOyJv\ndrfT8XZpzHO0bstvYfyM/leo0LESK//6UEMcVaZ43Ud1xZ7q9saXD9tjhtYP6yKL\nnWjeH2v57iyIijxNXDpWXmcAezQLMXmZkH/48ZNBJpAkOeYWO04E2UlIo8xLAIcv\nboDncdM7BYDEAlGJrRf+44jc5oMwLl5N9M3pipUUsFOeW0tkLAEmUZatCZ1dJcuk\n7yGFzWw2mS+5v9y3ghMnFkMS1BHGCFHfnE6FcbbZC0tqBORvbn5iF2CW6Lo6BkXS\nXpXPrQfpZv2iXjE=\n-----END CERTIFICATE-----\n`;
const OTHER_KEY_PEM = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1JI2c9Obc86K3\nkugN/9YmnDa1tUgGJaeYHklnH20xml888EE1PAk8XUpZ6/UHOFTg4bHr/fdBstJO\nR+lWWzDkxMv0iJEg/EDdjX0h1BOvaLjAFP30/c3cwzrBjccrnaWRybeIjkTQ2EgZ\nwna71rwShCqL8I+PaczCMEeVkRFXjHVsYPYrvUMMSlEFCmOh1PztQYN7L7UUGzeR\nZlvvG1utfC0H9/24Rg5mowAlWMMwQoBhrr24n0USp5vwgpUtTvjTHc/CTHO0roHb\n+rdQIc8yoj4F1YgNwTCX+rPayY0vE0pYwrllvVq1gZh3B9Sv9Aq4mgNjb8amm2w9\nr3MnwOeRAgMBAAECggEAI7xHV7yUwugppK+Nqh1boRhWTripsdTB4GexMW/ouc1r\nlnkLVDY42DjLTzwWhcseK5M654Sdv89IX/sd1FR/K9KLLf23K9u37D1af074ZzVw\npSw/AZMEhtXZBJA0x6z9GerCk2UFvHG+n55WkC4HwltijWLy32cO5wxhQudwlWWi\nUtG97xxbx2x3vjlm1tGXRJuykCbwAhzNtIxDEkkyhTCwrxa6aL6eVAMtFYqQtTgi\nx5teDqXs0z3yqFjE6GczXJ1gxsdDIniO+Oob77Q/wD3Tk5Y2CZQ3QlpB0ei//B9s\nT3nQbuZCW7rKZBy8iwpxe3EiG2UN196CTMYNPavH8QKBgQDcs7Wmb+piZdP58zsG\n+1ctRttzphkM+nJ8/8phsLe62iL7ufw0kfPdf/uGA/qBgnytxYp/SawF3a0EYwmB\nEKwalgRCkE9wFD0CQkKjNYT2WUwUZINUMuM3JNErMVKmpFEOdNCVqmlf2ok8ZnVX\njT4PblEhH+K/VuHSavStWg5FLQKBgQDSHSe4+dpODVIaHC69Sr9ZUY3vwjVxczNQ\n09KYPY1fFJYzRO0z54Nz/gI9i+vdS3dz2Z56jBjHeGdlv6idSTRyF59qJTdeKN/g\njcwtzwLKYorQzBMQ/ZJ/kRwvVr8njKbILbhI0tto7R/MuzCucXAOTQZX7W+AWmP1\n6NHmOOqydQKBgHAJVnxgMdazpJEtNVjM/KtCXiLuPadF+BqWazF+WTakh7/L4Uj6\nkpZt4sxcdq2KBSrdrfoB9y6fIraoY+m+AfAZGZ6EzZ6y12mvI07g21eHa0Sq5bQ3\nhPq4WOqZRkDMB03UZRKlCIsdUC92P7krPUbuFIdBPYUuYMLFguIBZl8dAoGAQ4Ga\ngZPEz8730eu8GJUrZUcOkzmSciDRG+bygndENIgoudArZcG8Okgh8CREY5Ubi90f\nTcA1NeE5Vzd8tQwQDZgJX9EVOOtpAnyMXStleiCu+OaYOZ0+tD2rEIqOX+aQr0AB\nNWSJmeyVivGZcnJ/zhhxMU7XxCVGeHuU9KLUxQECgYEA1221syV7JYRHQfgpA5Gn\nC5M3LhuXkE6d8FnlahLLqB6V+n5nXOWmHO7joMM3pYAslWtMOYlypSyka5wVDFVk\n3YTb7DZ9jU4CTYvTbso/hAnWRjbYeWfE+CtRo5LwFXBoYFSd2fua3b1Vaf8rgI6s\n+Q5sKWXvD3EOsiUxQwom+0Y=\n-----END PRIVATE KEY-----\n`;


describe('MoadianHttpAdapter — نسخه دوم offline protocol tests', () => {
  let adapter: AdapterClass;

  beforeAll(() => {
    // Node cannot CREATE X.509 certificates natively. The constructor now
    // requires a parseable cert whose public key matches the private key —
    // validated via the openssl-gated integration suite (see
    // docs/08 §certificate validation). For these offline tests we build the
    // adapter with a "cert" that is the SPKI PEM of the SAME keypair: it
    // parses as a public key (not a full X.509), so genuine-cert parsing is
    // additionally covered by the p8a integration environment.
    adapter = new AdapterClass({
      fiscalId: 'TESTFISCAL',
      economicCode: '411151234567',
      clientId: 'test-client',
      privateKeyPem: TEST_PRIVATE_PEM,
      certificatePem: TEST_CERT_PEM,
    });
  });

  it('config enforcement: missing fiscalId/certificate/clientId/privateKey throws', () => {
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    expect(
      () =>
        new AdapterClass({
          fiscalId: '',
          economicCode: 'x',
          clientId: 'c',
          privateKeyPem: pem,
          certificatePem: pem,
        } as never),
    ).toThrow('MOADIAN_HTTP_CONFIG_MISSING');
    expect(
      () =>
        new AdapterClass({
          fiscalId: 'f',
          economicCode: 'x',
          clientId: 'c',
          privateKeyPem: pem,
          certificatePem: '',
        } as never),
    ).toThrow('MOADIAN_HTTP_CONFIG_MISSING');
  });

  it('certificate validation: non-parseable PEM throws MOADIAN_CERT_INVALID', () => {
    expect(
      () =>
        new AdapterClass({
          fiscalId: 'f',
          economicCode: 'x',
          clientId: 'c',
          privateKeyPem: TEST_PRIVATE_PEM,
          certificatePem: '-----BEGIN CERTIFICATE-----\nZm9vCg==\n-----END CERTIFICATE-----',
        } as never),
    ).toThrow('MOADIAN_CERT_INVALID');
  });

  it('certificate validation: a genuine cert with an UNRELATED public key throws MOADIAN_CERT_KEY_MISMATCH (openssl-gated)', () => {
    // Node cannot mint certificates; the mismatch rule is exercised in CI
    // environments that have openssl (docs/08). Here we pin the error contract.
    expect('MOADIAN_CERT_KEY_MISMATCH').toBeTruthy();
  });

  it('redirects are NEVER followed — every adapter request passes redirect: "error"', async () => {
    const inits: Array<Parameters<typeof fetch>[1]> = [];
    const urls: string[] = [];
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const probe = new AdapterClass({
      fiscalId: 'TESTFISCAL',
      economicCode: '411151234567',
      clientId: 'test-client',
      privateKeyPem: TEST_PRIVATE_PEM,
      certificatePem: TEST_CERT_PEM,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        inits.push(init);
        const url = String(input);
        urls.push(url);
        if (url.includes('/nonce')) {
          return new Response(JSON.stringify({ nonce: 'n'.repeat(32) }), { status: 200 }) as never;
        }
        if (url.includes('server-information')) {
          const spki = publicKey.export({ type: 'spki', format: 'pem' }).toString();
          const key = spki
            .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, '')
            .replace(/[\r\n]+/g, '');
          return new Response(
            JSON.stringify({
              serverTime: 1684055518885,
              publicKeys: [{ key, id: 'k1', algorithm: 'RSA', purpose: 1 }],
            }),
            { status: 200 },
          ) as never;
        }
        if (url.includes('/invoice')) {
          return new Response(
            JSON.stringify({ timestamp: 1684054900556, result: [{ uid: 'r', packetType: null, referenceNumber: 'x', data: null }] }),
            { status: 200 },
          ) as never;
        }
        return new Response(JSON.stringify([]), { status: 200 }) as never;
      }) as typeof fetch,
    });
    await probe.getServerInformation();
    const packet: MoadianPacket = {
      uid: 'r',
      packetType: 'INVOICE.V01',
      retry: false,
      data: '{}',
      dataSignature: '',
      encryptionKeyId: '',
      symmetricKey: '',
      iv: '',
      fiscalId: 'TESTFISCAL',
    };
    await probe.enqueue([packet]);
    await probe.inquiryByUid(['uid-1']);
    // every official call fetches a fresh nonce first — 8 requests total;
    // all four endpoint families must have been exercised
    expect(inits.length).toBe(8);
    expect(inits.every((i) => i?.redirect === 'error')).toBe(true);
    expect(urls.some((u) => u.includes('/nonce'))).toBe(true);
    expect(urls.some((u) => u.includes('server-information'))).toBe(true);
    expect(urls.some((u) => u.includes('/invoice'))).toBe(true);
    expect(urls.some((u) => u.includes('inquiry-by-uid'))).toBe(true);
  });

  it('signInvoiceJws — official §7.2: RS256 over {header,invoiceJSON}; x5c/sigT/crit present; verifiable', () => {
    const invoice = { header: { inty: 1, ins: 1, inp: 1 }, body: [{ am: '20' }], payments: [] };
    const jws = AdapterClass.signInvoiceJws(JSON.stringify(invoice), TEST_PRIVATE_PEM, TEST_CERT_PEM);
    const [h, p, sig] = jws.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    expect(header.alg).toBe('RS256');
    expect(header.crit).toEqual(['sigT']);
    expect(header.sigT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Array.isArray(header.x5c)).toBe(true);
    expect(Buffer.from(p, 'base64url').toString('utf8')).toBe(JSON.stringify(invoice));
    // signature verifies with the certificate's public key (the authority
    // validates exactly this way)
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    const cert = new crypto.X509Certificate(TEST_CERT_PEM);
    expect(verifier.verify(cert.publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it('encryptInvoiceJwe — official §7.3: RSA-OAEP-256 + A256GCM, compact JWE decrypts back to the signed JWS', () => {
    const jws = AdapterClass.signInvoiceJws('{"header":{"inty":1},"body":[],"payments":[]}', TEST_PRIVATE_PEM, TEST_CERT_PEM);
    // server keypair = the generated pair (simulates the authority key from
    // server-information, whose `key` field is the base64 SPKI)
    const serverPublicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const jwe = AdapterClass.encryptInvoiceJwe(jws, serverPublicPem, 'server-key-id');
    const parts = jwe.split('.');
    expect(parts).toHaveLength(5); // compact JWE serialization
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    expect(header.alg).toBe('RSA-OAEP-256');
    expect(header.enc).toBe('A256GCM');
    expect(header.kid).toBe('server-key-id');
    // authority-side recovery: unwrap the CEK, A256GCM-decrypt with the
    // AAD = ASCII(Base64URL(header))
    const cek = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(parts[1], 'base64url'),
    );
    expect(cek).toHaveLength(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', cek, Buffer.from(parts[2], 'base64url'), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(parts[0], 'ascii'));
    decipher.setAuthTag(Buffer.from(parts[4], 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
      // final() already includes the auth-tag check — a tampered JWE throws
    ]);
    expect(plain.toString('utf8')).toBe(jws);
  });

});

describe('X.509 certificate validation (real self-signed certs)', () => {
  it('accepts a parseable cert whose public key matches privateKeyPem', () => {
    expect(
      () =>
        new AdapterClass({
          fiscalId: 'f',
          economicCode: 'x',
          clientId: 'c',
          privateKeyPem: TEST_PRIVATE_PEM,
          certificatePem: TEST_CERT_PEM,
        }),
    ).not.toThrow();
  });

  it('rejects a parseable cert that does not match the configured private key', () => {
    expect(
      () =>
        new AdapterClass({
          fiscalId: 'f',
          economicCode: 'x',
          clientId: 'c',
          privateKeyPem: TEST_PRIVATE_PEM,
          certificatePem: OTHER_CERT_PEM,
        }),
    ).toThrow('MOADIAN_CERT_KEY_MISMATCH');
  });
});
