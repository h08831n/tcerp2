import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { SmsService } from './sms.service';

/**
 * R4-1..3 (final merge gate): the REAL Nest DI graph must resolve — a plain
 * object 4th constructor parameter (options) emits design:paramtypes=Object
 * and Nest throws UnknownDependenciesException at bootstrap. TypeScript
 * compiling and `new SmsService(...)` both hide this failure; only a real
 * module compile exposes it. Smoke-level: no DB connection is needed —
 * compile() resolves the dependency graph without running lifecycle hooks.
 */
describe('R4 Nest bootstrap DI graph ( SmsService options param)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Minimal env so ConfigModule's zod validation passes WITHOUT .env (CI
    // provides only DATABASE_URL — cover every REQUIRED schema key here).
    const required: Record<string, string> = {
      DATABASE_URL: 'postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public',
      JWT_SECRET: 'bootstrap-di-test-secret-0123456789',
      JWT_REFRESH_SECRET: 'bootstrap-di-test-refresh-secret-0123456789',
      REDIS_URL: 'redis://localhost:6379',
    };
    for (const [key, fallback] of Object.entries(required)) {
      savedEnv[key] = process.env[key];
      if (!process.env[key]) process.env[key] = fallback;
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('compiles AppModule with the REAL providers — SmsService resolves', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const sms = moduleRef.get(SmsService, { strict: false });
    expect(sms).toBeTruthy();
    // The injected options default must be present (per-pass bound active).
    expect((sms as unknown as { passRowLimit: number }).passRowLimit).toBeGreaterThan(0);
  });
});
