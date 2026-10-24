import { createPublicKey } from "crypto";
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

// the mock authority's org key must be a REAL RSA public key: the adapter
// wraps the packet AES key with RSA-OAEP under it before enqueue
const ORG_PUBLIC_PEM = createPublicKey(TEST_PRIVATE_PEM)
  .export({ type: "spki", format: "pem" })
  .toString();

const COMPANY_IDS: string[] = [];
let prismaService: PrismaService;
let prisma: PrismaClient;
let inquiryScript: Array<"PENDING" | "SUCCESS" | "FAILED"> = [];
let inquiryFailures = 0;
let inquiryFailureKind: "timeout" | "error" = "error";
let inquiryEmptyResponse = false;
const enqueuedUids: string[] = [];

function makeFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/nonce")) {
      return new Response(JSON.stringify({ nonce: "n".repeat(32) }), { status: 200 }) as never;
    }
    if (url.includes("server-information")) {
      return new Response(
        JSON.stringify({ result: { publicKeyId: "org-key-1", publicKey: ORG_PUBLIC_PEM } }),
        { status: 200 },
      ) as never;
    }
    if (url.includes("normal-enqueue")) {
      const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as {
        packets: Array<{ uid: string }>;
      };
      enqueuedUids.push(...body.packets.map((p) => p.uid));
      return new Response(
        JSON.stringify({ result: body.packets.map((p) => ({ uid: p.uid, referenceNumber: "ref" })) }),
        { status: 200 },
      ) as never;
    }
    if (url.includes("INQUIRY_BY_UID")) {
      if (inquiryFailures > 0) {
        inquiryFailures -= 1;
        if (inquiryFailureKind === "timeout") {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        }
        throw new Error("inquiry transport failure");
      }
      const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as { uidList: string[] };
      if (inquiryEmptyResponse) {
        return new Response(JSON.stringify({ result: [] }), { status: 200 }) as never;
      }
      const results = body.uidList.map((uid) => {
        const next = inquiryScript.shift() ?? "SUCCESS";
        if (next === "PENDING") return { uid, status: "PENDING" };
        if (next === "FAILED")
          return { uid, status: "FAILED", errorCode: "CONTENT", errorDetail: "Duplicate tax id" };
        return { uid, status: "SUCCESS", confirmationReferenceId: "conf", taxResult: "fake" };
      });
      return new Response(JSON.stringify({ result: results }), { status: 200 }) as never;
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
                data: "{}",
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
  );});
