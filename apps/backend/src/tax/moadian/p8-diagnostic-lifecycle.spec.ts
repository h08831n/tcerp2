import * as crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { MoadianDiagnosticService } from "./moadian-diagnostic.service";
import { TEST_CERT_PEM, TEST_PRIVATE_PEM } from "./test-certs";
import { TEST_INTEGRATION, disconnectIntegrationPrisma } from "../../testing/integration";
import { assertSafeIntegrationDatabase } from "../../testing/db-guard";

jest.setTimeout(120000);

const DB_URL = process.env.DATABASE_URL;

if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

// the mock authority's org key must be a REAL RSA keypair: the adapter
// encrypts the invoice JWE with the SERVER public key (official §7.3) and
// this mock decrypts with the SERVER private key to prove the round-trip
const ORG_KEY_B64_SPKI = crypto.createPublicKey(TEST_PRIVATE_PEM)
  .export({ type: "spki", format: "pem" })
  .toString()
  .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, "")
  .replace(/[\r\n]+/g, "")
  .trim();

const COMPANY_IDS: string[] = [];
let prismaService: PrismaService;
let prisma: PrismaClient;
let inquiryScript: Array<"PENDING" | "SUCCESS" | "FAILED"> = [];
let inquiryFailures = 0;
let inquiryFailureKind: "timeout" | "error" = "error";
let inquiryEmptyResponse = false;
const enqueuedUids: string[] = [];

/** official RC_TICS.IS_v1.6 §7.3 authority-side recovery: unwrap the JWE
 *  (RSA-OAEP-256 CEK + A256GCM, AAD = ASCII(Base64URL(header))), then
 *  §7.2 verify the inner compact JWS: header {alg: RS256, x5c: [cert],
 *  sigT seconds-precision, crit: [sigT]}, signature verifies against the
 *  certificate, payload is a complete invoice JSON. Throws on ANY failure —
 *  a broken adapter crypto cannot reach this mock unnoticed. */
function decryptAndVerifyInvoiceJwe(jwe: string): { invoice: { header: Record<string, unknown>; body: unknown[]; payments: unknown[] } } {
  const parts = jwe.split(".");
  if (parts.length !== 5) throw new Error("mock: not a compact JWE");
  const [h, ek, iv, ct, tag] = parts;
  const jweHeader = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
    alg?: string;
    enc?: string;
    kid?: string;
  };
  if (jweHeader.alg !== "RSA-OAEP-256" || jweHeader.enc !== "A256GCM" || !jweHeader.kid) {
    throw new Error("mock: JWE protected header does not match the official parameters");
  }
  const cek = crypto.privateDecrypt(
    { key: TEST_PRIVATE_PEM, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ek, "base64url"),
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", cek, Buffer.from(iv, "base64url"), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(h, "ascii"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const signedJws = Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  const [jwsH, jwsP, jwsSig] = signedJws.split(".");
  if (!jwsH || !jwsP || !jwsSig) throw new Error("mock: inner payload is not a compact JWS");
  const jwsHeader = JSON.parse(Buffer.from(jwsH, "base64url").toString("utf8")) as {
    alg?: string;
    x5c?: string[];
    sigT?: string;
    crit?: string[];
  };
  if (jwsHeader.alg !== "RS256" || !Array.isArray(jwsHeader.x5c) || jwsHeader.crit?.[0] !== "sigT") {
    throw new Error("mock: JWS protected header does not match the official parameters");
  }
  if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(jwsHeader.sigT ?? "")) {
    throw new Error("mock: sigT is not seconds-precision ISO-8601 UTC");
  }
  const signerCert = new crypto.X509Certificate(
    `-----BEGIN CERTIFICATE-----\n${jwsHeader.x5c[0]}\n-----END CERTIFICATE-----`,
  );
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${jwsH}.${jwsP}`);
  if (!verifier.verify(signerCert.publicKey, Buffer.from(jwsSig, "base64url"))) {
    throw new Error("mock: inner JWS signature does NOT verify against the submitted certificate");
  }
  const invoice = JSON.parse(Buffer.from(jwsP, "base64url").toString("utf8")) as {
    header: Record<string, unknown>;
    body: unknown[];
    payments: unknown[];
  };
  if (!invoice.header || !Array.isArray(invoice.body) || !Array.isArray(invoice.payments)) {
    throw new Error("mock: signed payload is not a complete invoice JSON");
  }
  return { invoice };
}

function makeFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/nonce")) {
      return new Response(JSON.stringify({ nonce: "n".repeat(32) }), { status: 200 }) as never;
    }
    if (url.includes("server-information")) {
      // official §6 shape: { serverTime, publicKeys: [{ key (base64 SPKI), id, algorithm, purpose }] }
      return new Response(
        JSON.stringify({
          serverTime: 1684055518885,
          publicKeys: [{ key: ORG_KEY_B64_SPKI, id: "org-key-1", algorithm: "RSA", purpose: 1 }],
        }),
        { status: 200 },
      ) as never;
    }
    if (url.includes("/invoice")) {
      // official §7: body [{ payload: JWE, header: { requestTraceId, fiscalId } }]
      const body = JSON.parse(String((init as RequestInit).body ?? "[]")) as Array<{
        payload: string;
        header: { requestTraceId: string; fiscalId: string };
      }>;
      for (const item of body) {
        // full cryptographic + structural verification; throws on any mismatch
        decryptAndVerifyInvoiceJwe(item.payload);
        if (!item.header.requestTraceId || !item.header.fiscalId) {
          throw new Error("mock: envelope header misses requestTraceId/fiscalId");
        }
        enqueuedUids.push(item.header.requestTraceId); // §8: uid === requestTraceId
      }
      return new Response(
        JSON.stringify({
          timestamp: 1684054900556,
          result: body.map((item) => ({
            uid: item.header.requestTraceId,
            packetType: null,
            referenceNumber: "ref-" + item.header.requestTraceId.slice(0, 8),
            data: null,
          })),
        }),
        { status: 200 },
      ) as never;
    }
    if (url.includes("inquiry-by-uid")) {
      if (inquiryFailures > 0) {
        inquiryFailures -= 1;
        if (inquiryFailureKind === "timeout") {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        }
        throw new Error("inquiry transport failure");
      }
      // official §8.2: GET with REPEATED uidList query params + fiscalId
      const query = new URL(url).searchParams;
      const uids = query.getAll("uidList");
      if (inquiryEmptyResponse) {
        return new Response(JSON.stringify([]), { status: 200 }) as never;
      }
      const results = uids.map((uid) => {
        const next = inquiryScript.shift() ?? "SUCCESS";
        if (next === "PENDING")
          return { uid, status: "IN_PROGRESS", data: { error: [], warning: [], success: false }, packetType: "receive_invoice_confirm", fiscalId: query.get("fiscalId"), sign: "" };
        if (next === "FAILED")
          return {
            uid,
            status: "FAILED",
            data: { error: [{ code: "012802", message: "مقدار وارد شده مجاز نیست", errorType: "ERROR" }], warning: [], success: false },
            packetType: "receive_invoice_confirm",
            fiscalId: query.get("fiscalId"),
            sign: "",
          };
        return {
          uid,
          status: "SUCCESS",
          data: { error: [], warning: [], success: true },
          packetType: "receive_invoice_confirm",
          fiscalId: query.get("fiscalId"),
          sign: "fake-core-signature",
        };
      });
      return new Response(JSON.stringify(results), { status: 200 }) as never;
    }
    return new Response("not found", { status: 404 }) as never;
  }) as typeof fetch;
}

function makeService(): MoadianDiagnosticService {
  return new MoadianDiagnosticService(prismaService as never, makeFetch());
}

async function createCompany(): Promise<string> {
  // reset mock knobs — tests run sequentially and share module state
  inquiryScript = [];
  inquiryFailures = 0;
  inquiryFailureKind = "error";
  inquiryEmptyResponse = false;
  const company = await prismaService.company.create({
    data: { nameFa: `p8r-${Date.now()}`, status: "ACTIVE" },
  });
  COMPANY_IDS.push(company.id);
  return company.id;
}

async function cleanupCompanies(): Promise<void> {
  for (const companyId of COMPANY_IDS) {
    await prisma.moadianDiagnosticAttempt.deleteMany({ where: { companyId } }).catch(() => undefined);
    await prisma.moadianDiagnosticRun.deleteMany({ where: { companyId } }).catch(() => undefined);
    await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  }
  COMPANY_IDS.length = 0;
}

describe("p8-18 — attempt lifecycle & recovery (durable state machine)", () => {
  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    prismaService = new PrismaService();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    new AuditService(prismaService as never);
  });

  afterAll(async () => {
    if (!prismaService) return;
    await cleanupCompanies();
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  const itif =
    TEST_INTEGRATION && DB_URL
      ? it
      : (name: string, fn: jest.ProvidesCallback) => it.skip(name, fn);

  const SANDBOX_ENV: Record<string, string> = {
    MOADIAN_MODE: "sandbox",
    MOADIAN_BASE_URL: "https://tp.tax.gov.ir/requestsmanager/api/v2",
    MOADIAN_FISCAL_ID: "F-TEST",
    MOADIAN_ECONOMIC_CODE: "E",
    MOADIAN_CLIENT_ID: "C",
    MOADIAN_PRIVATE_KEY: TEST_PRIVATE_PEM,
    MOADIAN_CERTIFICATE: TEST_CERT_PEM,
    MOADIAN_SANDBOX_TAXID: "AABBCCDDEEFF001122334455",
    MOADIAN_SANDBOX_TINS: "1111222233",
    MOADIAN_SANDBOX_SSTID: "1234567890",
  };

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  itif(
    "p8-18a REJECTED attempt -> official retry enqueues a NEW uid with retry=true exactly once",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      inquiryScript = ["FAILED"];
      const r1 = await svc.runSandboxFullTest(companyId);
      expect(r1.submission?.status).toBe("REJECTED");
      const attempt1 = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
        where: { companyId, uid: r1.submission!.uid },
      });
      expect(attempt1.status).toBe("REJECTED");
      expect(attempt1.retry).toBe(false);

      inquiryScript = ["FAILED", "SUCCESS"]; // reconcile sees the rejection, then the retry succeeds
      const r2 = await svc.runSandboxFullTest(companyId);
      expect(r2.submission?.status).toBe("SUCCESS");
      const attempts = await prisma.moadianDiagnosticAttempt.findMany({
        where: { companyId, uid: { in: [r1.submission!.uid, r2.submission!.uid] } },
        orderBy: { attempt: "asc" },
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[1].attempt).toBe(2);
      expect(attempts[1].retry).toBe(true);
      expect(attempts[1].uid).not.toBe(attempts[0].uid);
      expect(attempts.filter((a) => a.status === "SUCCESS")).toHaveLength(1);
      expect(enqueuedUids.filter((u) => u === attempts[0].uid)).toHaveLength(1);
      expect(enqueuedUids.filter((u) => u === attempts[1].uid)).toHaveLength(1);
    },
  );

  itif("p8-18b crash after claim -> reconcile by the persisted uid, NEVER resent", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    const run = await prisma.moadianDiagnosticRun.create({
      data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "SUBMITTED" },
    });
    const uid = "sandbox-crash-uid-1";
    await prisma.moadianDiagnosticAttempt.create({
      data: {
        runId: run.id,
        companyId,
        attempt: 1,
        uid,
        retry: false,
        status: "SUBMITTED",
        payloadSnapshot: {},
      },
    });
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(res.submission?.uid).toBe(uid);
    expect(res.submission?.status).toBe("SUCCESS");
  });

  itif(
    "p8-18c two independent service instances on one DB -> exactly one claim, one enqueue",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svcA = makeService();
      const svcB = makeService();
      const settled = await Promise.allSettled([
        svcA.runSandboxFullTest(companyId),
        svcB.runSandboxFullTest(companyId),
      ]);
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
      const attempts = await prisma.moadianDiagnosticAttempt.findMany({ where: { companyId } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe("SUCCESS");
      expect(enqueuedUids.filter((u) => u === attempts[0].uid)).toHaveLength(1);
      // fifth review #2: after the losing instance returns, the aggregate
      // reflects ONLY the winner's final state — never a contender's
      const runRow = await prisma.moadianDiagnosticRun.findFirstOrThrow({ where: { companyId } });
      expect(runRow.status).toBe("SUCCESS");
    },
  );

  itif(
    "p8-18d enqueue timeout (unknown outcome) -> reconcile resolves SUCCESS without resend",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      const run = await prisma.moadianDiagnosticRun.create({
        data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "SUBMITTED" },
      });
      const uid = "sandbox-timeout-uid-1";
      await prisma.moadianDiagnosticAttempt.create({
        data: {
          runId: run.id,
          companyId,
          attempt: 1,
          uid,
          retry: false,
          status: "SUBMITTED",
          payloadSnapshot: {},
        },
      });
      inquiryScript = ["SUCCESS"];
      const enqueuedBefore = enqueuedUids.length;
      const res = await svc.runSandboxFullTest(companyId);
      expect(res.submission?.status).toBe("SUCCESS");
      const attempts = await prisma.moadianDiagnosticAttempt.findMany({
        where: { companyId },
        orderBy: { attempt: "asc" },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].uid).toBe(uid);
      expect(enqueuedUids.length).toBe(enqueuedBefore);
    },
  );

  itif("p8-18e UNKNOWN stays blocked on inconclusive inquiry — no resend", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    const run = await prisma.moadianDiagnosticRun.create({
      data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "UNKNOWN" },
    });
    const uid = "sandbox-unknown-uid-1";
    await prisma.moadianDiagnosticAttempt.create({
      data: {
        runId: run.id,
        companyId,
        attempt: 1,
        uid,
        retry: false,
        status: "UNKNOWN",
        errorCode: "SANDBOX_UNKNOWN_OUTCOME",
        payloadSnapshot: {},
      },
    });
    inquiryScript = ["PENDING"];
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(res.submission?.uid).toBe(uid);
    expect(res.submission?.status).toBe("UNKNOWN");
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid },
    });
    expect(attempt.status).toBe("UNKNOWN");
  });

  itif(
    "p8-19a legacy claim-without-attempt crash window -> recovered safely, nothing resent",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      // fourth review #1 regression: aggregate claimed (SUBMITTED) but the
      // attempt identity was never persisted. Attempt creation precedes
      // enqueue in every code version, so nothing was ever sent — recovery
      // starts attempt 1 with a fresh uid instead of getting stuck claimless.
      await prisma.moadianDiagnosticRun.create({
        data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "SUBMITTED" },
      });
      const enqueuedBefore = enqueuedUids.length;
      const res = await svc.runSandboxFullTest(companyId);
      expect(res.submission?.status).toBe("SUCCESS");
      const attempts = await prisma.moadianDiagnosticAttempt.findMany({ where: { companyId } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].attempt).toBe(1);
      expect(attempts[0].status).toBe("SUCCESS");
      expect(enqueuedUids.length).toBe(enqueuedBefore + 1);
      expect(enqueuedUids.filter((u) => u === attempts[0].uid)).toHaveLength(1);
    },
  );

  itif(
    "p8-19b expired-lease PREPARED attempt -> resumed with the SAME uid and frozen packet",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      const run = await prisma.moadianDiagnosticRun.create({
        data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "SUBMITTED" },
      });
      // crash after claim+attempt, before enqueue — lease long expired
      await prisma.moadianDiagnosticAttempt.create({
        data: {
          runId: run.id,
          companyId,
          attempt: 1,
          uid: "sandbox-resume-uid-1",
          retry: false,
          status: "PREPARED",
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          payloadSnapshot: {
            packets: [
              {
                uid: "sandbox-resume-uid-1",
                packetType: "INVOICE.V01",
                retry: false,
                // a COMPLETE invoice — the mock authority verifies the inner
                // JWS payload structure (header/body/payments)
                data: JSON.stringify({
                  header: { taxid: null, inty: 1, inp: 1, ins: 1 },
                  body: [{ sstid: "2710000138624", am: "1", vam: "0" }],
                  payments: [],
                }),
                dataSignature: "",
                encryptionKeyId: "",
                symmetricKey: "",
                iv: "",
                fiscalId: "F-TEST",
              },
            ],
          },
        },
      });
      const enqueuedBefore = enqueuedUids.length;
      const res = await svc.runSandboxFullTest(companyId);
      expect(res.submission?.uid).toBe("sandbox-resume-uid-1");
      expect(res.submission?.status).toBe("SUCCESS");
      const attempts = await prisma.moadianDiagnosticAttempt.findMany({ where: { companyId } });
      expect(attempts).toHaveLength(1); // NO new attempt/uid was created
      expect(enqueuedUids.length).toBe(enqueuedBefore + 1); // resumed exactly once
      expect(enqueuedUids.filter((u) => u === "sandbox-resume-uid-1")).toHaveLength(1);
    },
  );

  itif("p8-19c fresh-lease PREPARED attempt -> other instances back off (no enqueue)", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    const run = await prisma.moadianDiagnosticRun.create({
      data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "SUBMITTED" },
    });
    await prisma.moadianDiagnosticAttempt.create({
      data: {
        runId: run.id,
        companyId,
        attempt: 1,
        uid: "sandbox-inprogress-uid-1",
        retry: false,
        status: "PREPARED",
        payloadSnapshot: {},
      },
    });
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(res.submission?.status).toBe("PREPARED");
    expect(res.errorCode).toBe("SANDBOX_CLAIM_IN_PROGRESS");
    const attempts = await prisma.moadianDiagnosticAttempt.findMany({ where: { companyId } });
    expect(attempts).toHaveLength(1);
    // fifth review #2: the contending (losing) caller must NOT overwrite the
    // aggregate — it stays exactly as the owning instance left it
    const runRow = await prisma.moadianDiagnosticRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runRow.status).toBe("SUBMITTED");
  });

  itif(
    "p8-19d aggregate sync failure -> result downgraded to FAIL, attempt state stays truthful",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      const updateSpy = jest
        .spyOn(prisma.moadianDiagnosticRun, "update")
        .mockRejectedValueOnce(new Error("db down"));
      try {
        const res = await svc.runSandboxFullTest(companyId);
        expect(res.report.overall).toBe("FAIL");
        expect(res.errorCode).toBe("SANDBOX_AGGREGATE_SYNC_FAILED");
        expect(res.submission?.status).toBe("SUCCESS"); // the attempt DID succeed
        const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
          where: { companyId },
        });
        expect(attempt.status).toBe("SUCCESS");
        // the aggregate itself was NOT updated — honest, never falsely final
        const runRow = await prisma.moadianDiagnosticRun.findFirstOrThrow({ where: { companyId } });
        expect(runRow.status).not.toBe("SUCCESS");
      } finally {
        updateSpy.mockRestore();
      }
    },
  );

  itif(
    "p8-19e inquiry timeout -> UNKNOWN persisted; restart reconciles later SUCCESS without resend",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      inquiryFailures = 1;
      inquiryFailureKind = "timeout";
      const res1 = await svc.runSandboxFullTest(companyId);
      expect(res1.report.overall).toBe("FAIL");
      expect(res1.submission?.status).toBe("UNKNOWN");
      const uid = res1.submission!.uid;
      const attempt1 = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
        where: { companyId, uid },
      });
      expect(attempt1.status).toBe("UNKNOWN"); // persisted BEFORE returning
      expect(attempt1.errorCode).toBe("SANDBOX_INQUIRY_UNKNOWN");
      const enqueuedAfterFirst = enqueuedUids.length;
      // restart: a NEW service instance reconciles the persisted uid
      inquiryFailures = 0;
      inquiryScript = ["SUCCESS"];
      const svc2 = makeService();
      const res2 = await svc2.runSandboxFullTest(companyId);
      expect(res2.submission?.uid).toBe(uid);
      expect(res2.submission?.status).toBe("SUCCESS");
      expect(enqueuedUids.length).toBe(enqueuedAfterFirst); // NO resend
      expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    },
  );

  itif("p8-19f reconcile inquiry failure -> attempt unchanged, nothing resent", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    const run = await prisma.moadianDiagnosticRun.create({
      data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "SUBMITTED" },
    });
    await prisma.moadianDiagnosticAttempt.create({
      data: {
        runId: run.id,
        companyId,
        attempt: 1,
        uid: "sandbox-reconcile-fail-1",
        retry: false,
        status: "SUBMITTED",
        payloadSnapshot: {},
      },
    });
    inquiryFailures = 1;
    inquiryFailureKind = "error";
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(res.report.overall).toBe("FAIL");
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-reconcile-fail-1" },
    });
    expect(attempt.status).toBe("SUBMITTED"); // EXACTLY as before — untouched
  });

  itif(
    "p8-19g aggregate in-flight with NO attempt row -> blocked (SANDBOX_ATTEMPT_IDENTITY_LOST)",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      await prisma.moadianDiagnosticRun.create({
        data: { companyId, runDay: today(), fiscalId: "F-TEST", status: "PENDING" },
      });
      const enqueuedBefore = enqueuedUids.length;
      const res = await svc.runSandboxFullTest(companyId);
      expect(res.submission).toBeNull();
      expect(res.errorCode).toBe("SANDBOX_ATTEMPT_IDENTITY_LOST");
      expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(0);
      expect(enqueuedUids.length).toBe(enqueuedBefore);
    },
  );

  // fifth review #1 — retry is unlocked ONLY by a fresh, explicit,
  // authoritative rejection for the exact persisted uid
  async function seedRejectedHead(uid: string): Promise<{ runId: string }> {
    const run = await prisma.moadianDiagnosticRun.create({
      data: { companyId: COMPANY_IDS[COMPANY_IDS.length - 1], runDay: today(), fiscalId: "F-TEST", status: "REJECTED" },
    });
    await prisma.moadianDiagnosticAttempt.create({
      data: {
        runId: run.id,
        companyId: COMPANY_IDS[COMPANY_IDS.length - 1],
        attempt: 1,
        uid,
        retry: false,
        status: "REJECTED",
        errorCode: "CONTENT",
        errorDetail: "prior authoritative rejection",
        payloadSnapshot: {},
      },
    });
    return { runId: run.id };
  }

  itif("p8-20a prior REJECTED + inquiry PENDING -> NO new attempt, NO enqueue", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    await seedRejectedHead("sandbox-rej-pending-1");
    inquiryScript = ["PENDING"];
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(res.report.overall).toBe("FAIL");
    expect(res.submission?.status).toBe("REJECTED"); // unchanged
    expect(enqueuedUids.length).toBe(enqueuedBefore); // no resend
    expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-rej-pending-1" },
    });
    expect(attempt.status).toBe("REJECTED"); // not overwritten by the inconclusive inquiry
    const runRow = await prisma.moadianDiagnosticRun.findFirstOrThrow({ where: { companyId } });
    expect(runRow.status).toBe("REJECTED");
  });

  itif("p8-20b prior REJECTED + empty inquiry response -> NO new attempt, NO enqueue", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    await seedRejectedHead("sandbox-rej-empty-1");
    inquiryEmptyResponse = true;
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(res.report.overall).toBe("FAIL");
    expect(res.submission?.status).toBe("REJECTED");
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-rej-empty-1" },
    });
    expect(attempt.status).toBe("REJECTED");
  });

  itif("p8-20c prior REJECTED + inquiry transport failure -> NO new attempt, NO enqueue", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    await seedRejectedHead("sandbox-rej-transport-1");
    inquiryFailures = 1;
    inquiryFailureKind = "error";
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(res.report.overall).toBe("FAIL");
    expect(res.submission?.status).toBe("REJECTED");
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-rej-transport-1" },
    });
    expect(attempt.status).toBe("REJECTED");
  });

  itif(
    "p8-20d explicit authoritative rejection for the persisted uid -> retry permitted exactly once",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      const { runId } = await seedRejectedHead("sandbox-rej-explicit-1");
      void runId;
      // fresh explicit FAILED from the authority for the SAME persisted uid
      inquiryScript = ["FAILED", "SUCCESS"];
      const res = await svc.runSandboxFullTest(companyId);
      expect(res.submission?.status).toBe("SUCCESS");
      const attempts = await prisma.moadianDiagnosticAttempt.findMany({
        where: { companyId },
        orderBy: { attempt: "asc" },
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[1].attempt).toBe(2);
      expect(attempts[1].retry).toBe(true);
      expect(attempts[1].uid).not.toBe("sandbox-rej-explicit-1");
      // exactly one enqueue, and only for the NEW uid (the rejected uid is
      // never re-sent)
      expect(enqueuedUids.filter((u) => u === "sandbox-rej-explicit-1")).toHaveLength(0);
      expect(enqueuedUids.filter((u) => u === attempts[1].uid)).toHaveLength(1);
    },
  );

  // sixth review #1 — a persisted SUCCESS is never retried; ANY non-SUCCESS
  // authority response for an accepted uid is a contradiction, checked
  // BEFORE the inconclusive branch; transport failure stays an inquiry
  // failure; nothing is enqueued or created in any of these cases
  async function seedAcceptedHead(uid: string): Promise<void> {
    const run = await prisma.moadianDiagnosticRun.create({
      data: { companyId: COMPANY_IDS[COMPANY_IDS.length - 1], runDay: today(), fiscalId: "F-TEST", status: "SUCCESS" },
    });
    await prisma.moadianDiagnosticAttempt.create({
      data: {
        runId: run.id,
        companyId: COMPANY_IDS[COMPANY_IDS.length - 1],
        attempt: 1,
        uid,
        retry: false,
        status: "SUCCESS",
        referenceNumber: "ref-accepted",
        confirmationReferenceId: "conf-accepted",
        payloadSnapshot: {},
      },
    });
  }

  itif("p8-21a accepted uid + inquiry PENDING -> SANDBOX_RECONCILE_CONTRADICTION, no resend", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    await seedAcceptedHead("sandbox-acc-pending-1");
    inquiryScript = ["PENDING"];
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(res.report.overall).toBe("FAIL");
    expect(res.errorCode).toBe("SANDBOX_RECONCILE_CONTRADICTION");
    expect(res.submission?.uid).toBe("sandbox-acc-pending-1");
    expect(res.submission?.status).toBe("SUCCESS"); // consistent with attempt/aggregate
    expect(enqueuedUids.length).toBe(enqueuedBefore); // zero enqueue
    expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-acc-pending-1" },
    });
    expect(attempt.status).toBe("SUCCESS"); // never overwritten by PENDING
    const runRow = await prisma.moadianDiagnosticRun.findFirstOrThrow({ where: { companyId } });
    expect(runRow.status).toBe("SUCCESS"); // aggregate consistent
  });

  itif("p8-21b accepted uid + empty inquiry response -> SANDBOX_RECONCILE_CONTRADICTION", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    await seedAcceptedHead("sandbox-acc-empty-1");
    inquiryEmptyResponse = true;
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(res.errorCode).toBe("SANDBOX_RECONCILE_CONTRADICTION"); // NOT silently inconclusive
    expect(res.submission?.status).toBe("SUCCESS");
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-acc-empty-1" },
    });
    expect(attempt.status).toBe("SUCCESS");
  });

  itif("p8-21c accepted uid + explicit FAILED -> SANDBOX_RECONCILE_CONTRADICTION, attempt kept SUCCESS", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    await seedAcceptedHead("sandbox-acc-failed-1");
    inquiryScript = ["FAILED"];
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(res.errorCode).toBe("SANDBOX_RECONCILE_CONTRADICTION");
    expect(res.submission?.status).toBe("SUCCESS");
    expect(enqueuedUids.length).toBe(enqueuedBefore);
    expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-acc-failed-1" },
    });
    expect(attempt.status).toBe("SUCCESS"); // a reported acceptance is never overwritten/retried
    const runRow = await prisma.moadianDiagnosticRun.findFirstOrThrow({ where: { companyId } });
    expect(runRow.status).toBe("SUCCESS");
  });

  itif("p8-21d accepted uid + inquiry transport failure -> inquiry failure, NOT a contradiction", async () => {
    const companyId = await createCompany();
    process.env = { ...process.env, ...SANDBOX_ENV };
    const svc = makeService();
    await seedAcceptedHead("sandbox-acc-transport-1");
    inquiryFailures = 1;
    inquiryFailureKind = "error";
    const enqueuedBefore = enqueuedUids.length;
    const res = await svc.runSandboxFullTest(companyId);
    expect(res.report.overall).toBe("FAIL");
    // seventh review #1: the TOP-LEVEL API result carries the stable
    // SANDBOX_INQUIRY_FAILED classification, agreeing with the step
    const reconcileStep = res.report.steps.find((s) => s.step === "sandbox_reconcile");
    expect(res.errorCode).toBe("SANDBOX_INQUIRY_FAILED");
    expect(reconcileStep?.errorCode).toBe("SANDBOX_INQUIRY_FAILED");
    expect(res.errorCode).toBe(reconcileStep?.errorCode); // API response and step agree
    // sanitized network classification appears in the step details
    expect(reconcileStep?.message).toContain("NETWORK_ERROR");
    // the authority said nothing, so no contradiction is claimed anywhere
    expect(res.report.steps.some((s) => s.errorCode === "SANDBOX_RECONCILE_CONTRADICTION")).toBe(false);
    // persisted states unchanged: same uid, attempt and aggregate stay SUCCESS
    expect(res.submission?.uid).toBe("sandbox-acc-transport-1");
    expect(res.submission?.status).toBe("SUCCESS");
    expect(enqueuedUids.length).toBe(enqueuedBefore); // zero enqueue, zero retry
    expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
    const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
      where: { companyId, uid: "sandbox-acc-transport-1" },
    });
    expect(attempt.status).toBe("SUCCESS");
    expect(attempt.uid).toBe("sandbox-acc-transport-1");
    const runRow = await prisma.moadianDiagnosticRun.findFirstOrThrow({ where: { companyId } });
    expect(runRow.status).toBe("SUCCESS"); // aggregate unchanged
  });

  itif(
    "p8-22 combined failure: inquiry transport failure + aggregate sync failure -> SANDBOX_AGGREGATE_SYNC_FAILED wins, both classifications reported",
    async () => {
      const companyId = await createCompany();
      process.env = { ...process.env, ...SANDBOX_ENV };
      const svc = makeService();
      await seedAcceptedHead("sandbox-acc-syncfail-1");
      inquiryFailures = 1; // transport failure on the reconcile inquiry
      inquiryFailureKind = "error";
      // deterministic aggregate persistence failure
      const updateSpy = jest
        .spyOn(prisma.moadianDiagnosticRun, "update")
        .mockRejectedValue(new Error("db down"));
      try {
        const enqueuedBefore = enqueuedUids.length;
        const res = await svc.runSandboxFullTest(companyId);
        expect(res.report.overall).toBe("FAIL");
        // eighth review #1: a genuine aggregate persistence failure ALWAYS
        // wins the top-level errorCode — the caller's SANDBOX_INQUIRY_FAILED
        // must not mask it
        expect(res.errorCode).toBe("SANDBOX_AGGREGATE_SYNC_FAILED");
        // the report identifies BOTH failures, each with its own step:
        // the original inquiry classification (sanitized) and the persistence failure
        const inquiryStep = res.report.steps.find((s) => s.errorCode === "SANDBOX_INQUIRY_FAILED");
        const persistenceStep = res.report.steps.find((s) => s.errorCode === "SANDBOX_AGGREGATE_SYNC_FAILED");
        expect(inquiryStep).toBeDefined();
        expect(persistenceStep).toBeDefined();
        expect(inquiryStep?.message).toContain("NETWORK_ERROR"); // sanitized classification
        expect(persistenceStep?.step).toBe("sandbox_persistence");
        // no secrets in any diagnostic detail
        for (const s of res.report.steps) {
          expect(s.message).not.toContain("PRIVATE KEY");
          expect(s.message).not.toContain("BEGIN CERTIFICATE");
        }
        // persisted states unchanged: same uid, attempt and aggregate stay SUCCESS
        expect(res.submission?.uid).toBe("sandbox-acc-syncfail-1");
        expect(res.submission?.status).toBe("SUCCESS");
        expect(enqueuedUids.length).toBe(enqueuedBefore); // zero retry, zero enqueue
        expect(await prisma.moadianDiagnosticAttempt.count({ where: { companyId } })).toBe(1);
        const attempt = await prisma.moadianDiagnosticAttempt.findFirstOrThrow({
          where: { companyId, uid: "sandbox-acc-syncfail-1" },
        });
        expect(attempt.status).toBe("SUCCESS");
        expect(attempt.uid).toBe("sandbox-acc-syncfail-1");
        // the aggregate could not be updated — it stays honestly at SUCCESS
        const runRow = await prisma.moadianDiagnosticRun.findFirstOrThrow({ where: { companyId } });
        expect(runRow.status).toBe("SUCCESS");
      } finally {
        updateSpy.mockRestore();
      }
    },
  );});
