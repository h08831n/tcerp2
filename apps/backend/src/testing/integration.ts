import { PrismaClient } from '@prisma/client';
import { assertSafeIntegrationDatabase } from './db-guard';

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

/** Shared PrismaClient for integration tests (lazy connect).
 *  The DATABASE_URL safety guard runs BEFORE the first connection — but only
 *  in real integration runs (TEST_INTEGRATION=1): describe.skip still
 *  executes the describe body during registration, so unit runs reach this
 *  function too and must not fail on a missing/dev URL they never query. */
export function integrationPrisma(): PrismaClient {
  if (!client) {
    if (TEST_INTEGRATION) assertSafeIntegrationDatabase(process.env.DATABASE_URL);
    client = new PrismaClient();
  }
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
