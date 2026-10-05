import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment loading + zod validation.
 * Fails fast at boot on missing/invalid configuration.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  ACCESS_TOKEN_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, 'ACCESS_TOKEN_TTL must look like "15m", "3600s", "12h" or "1d"')
    .default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  /** Seed credentials — no defaults for the password (see startup guard below). */
  SEED_ADMIN_USERNAME: z.string().min(1).default('admin'),
  SEED_ADMIN_PASSWORD: z.string().optional(),

  /** Queue runtime driver: auto (bullmq, falling back to db polling) | bullmq | db. */
  QUEUE_DRIVER: z.enum(['auto', 'bullmq', 'db']).default('auto'),

  REDIS_URL: z.string().min(1).optional(),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1).default('tcerpminio'),
  S3_SECRET_KEY: z.string().min(1).default('tcerpminio123'),
  S3_BUCKET: z.string().min(1).default('tcerp-files'),
  S3_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(true)
    .transform((v) => v === true || v === 'true'),
});

export type AppConfig = z.infer<typeof envSchema>;

/** DI token for the validated app config (see ConfigModule). */
export const CONFIG = 'TCERP_CONFIG';

/**
 * Passwords that must never reach production as the seed admin password.
 * `loadConfig` refuses to boot in production when one of these is configured.
 */
export const FORBIDDEN_PRODUCTION_PASSWORDS = ['Admin@12345', 'admin', 'password', '123456'];

/** True when the configured seed password is a known insecure default. */
export function isForbiddenSeedPassword(password: string | undefined): boolean {
  if (!password) return false;
  return FORBIDDEN_PRODUCTION_PASSWORDS.includes(password);
}

/** Minimal .env loader (no external dependency). Existing process.env wins. */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^["'](.*)["']$/, '$1');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

let cached: AppConfig | null = null;

/** Parse and validate the environment; throws a descriptive error on failure. */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  loadEnvFile();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  // Security startup guard: refuse production with a well-known seed password.
  // Checked for both the current SEED_* names and the legacy ADMIN_PASSWORD.
  if (parsed.data.NODE_ENV === 'production') {
    const candidates = [
      parsed.data.SEED_ADMIN_PASSWORD,
      process.env.ADMIN_PASSWORD,
    ];
    for (const candidate of candidates) {
      if (isForbiddenSeedPassword(candidate)) {
        throw new Error(
          'Refusing to start: a well-known default seed admin password is configured in production. ' +
            'Set SEED_ADMIN_PASSWORD to a strong unique value.',
        );
      }
    }
  }

  cached = parsed.data;
  return cached;
}
