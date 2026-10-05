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

  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(1).default('Admin@12345'),

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
  cached = parsed.data;
  return cached;
}
