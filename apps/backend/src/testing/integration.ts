import { PrismaClient } from '@prisma/client';

/**
 * Integration tests run only when TEST_INTEGRATION=1 and the database is
 * reachable — `npm test` (unit) needs neither DB nor Redis.
 */
export const TEST_INTEGRATION = process.env.TEST_INTEGRATION === '1';

/** describe.skipUnless(TEST_INTEGRATION) */
export const describeIntegration: typeof describe = TEST_INTEGRATION ? describe : describe.skip;

/** The seeded default company (migration backfill + seed upsert). */
export const INTEGRATION_COMPANY_ID = '00000000-0000-4000-8000-000000000001';

let client: PrismaClient | null = null;

/** Shared PrismaClient for integration tests (lazy connect). */
export function integrationPrisma(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export async function disconnectIntegrationPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

/** Random UUID for test entities (no FK targets exist yet for phase tables). */
export function testUuid(): string {
  return globalThis.crypto.randomUUID();
}
