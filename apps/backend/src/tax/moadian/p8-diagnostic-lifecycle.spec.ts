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
      const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as { uidList: string[] };
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
});
