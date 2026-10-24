import { MoadianAdapter } from './moadian-adapter';
import { MockMoadianAdapter } from './mock-moadian.adapter';
import { MoadianHttpAdapter } from './moadian-http.adapter';

/**
 * Moadian adapter factory — the ONLY place where MOADIAN_* environment
 * variables are read (docs/08). Mock mode (default) never touches real
 * credentials. sandbox/live REQUIRE all credential fields and fail fast
 * with a single, complete configuration error — no silent mock fallback.
 *
 * PEM environment values (MOADIAN_PRIVATE_KEY, MOADIAN_CERTIFICATE) may
 * carry escaped newlines which are unescaped here. Credential values are
 * never logged.
 */

export type MoadianMode = 'mock' | 'sandbox' | 'live';

export class MoadianConfigError extends Error {}

/** Unescapes `\n` sequences in PEM-shaped env values. */
export function pem(value: string | undefined): string | undefined {
  return value?.replace(/\\n/g, '\n');
}

/** Live/sandbox adapter configuration (constructor argument shape). */
export interface MoadianLiveConfig {
  baseUrl?: string;
  fiscalId: string;
  economicCode: string;
  clientId: string;
  privateKeyPem: string;
  certificatePem: string;
}

/** Destination allowlist (docs/08 security): only the official Moadian
 *  requestsmanager host over HTTPS is permitted by default; an explicit,
 *  tightly controlled deployment exception may add hosts via
 *  MOADIAN_EXTRA_ALLOWED_HOSTS (comma-separated exact hostnames). Loopback,
 *  private, link-local and arbitrary internal hosts are always rejected. */
const MOADIAN_ALLOWED_HOSTS = ['tp.tax.gov.ir'];

export function validateMoadianBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new MoadianConfigError('MOADIAN_BASE_URL is malformed: not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new MoadianConfigError(
      `MOADIAN_BASE_URL must use HTTPS (got ${parsed.protocol}) — plaintext or custom schemes are rejected`,
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // loopback/private/link-local/IP-literal rejection FIRST (SSRF hardening) —
  // before any allowlist check, so an allowlisted-looking internal name
  // cannot sneak through via an env exception
  if (['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new MoadianConfigError(`MOADIAN_BASE_URL host "${host}" is a loopback/internal destination — rejected`);
  }
  if (/^(10|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) {
    throw new MoadianConfigError(`MOADIAN_BASE_URL host "${host}" is a private-network address — rejected (SSRF)`);
  }
  const extra = (process.env.MOADIAN_EXTRA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowed = [...MOADIAN_ALLOWED_HOSTS, ...extra];
  if (!allowed.includes(host)) {
    throw new MoadianConfigError(
      `MOADIAN_BASE_URL host "${host}" is not allowlisted — permitted: ${allowed.join(', ')}`,
    );
  }
  const port = parsed.port || '443';
  if (port !== '443') {
    throw new MoadianConfigError(`MOADIAN_BASE_URL port ${port} is not allowlisted — only 443 (HTTPS)`);
  }
  // the official v2 base path is /requestsmanager/api/v2 — the adapter appends
  // endpoint paths; anything else is rejected
  const path = parsed.pathname.replace(/\/$/, '');
  const allowedPath = '/requestsmanager/api/v2';
  if (path !== allowedPath) {
    throw new MoadianConfigError(
      `MOADIAN_BASE_URL path "${path || '/'}" is not allowlisted — expected "${allowedPath}"`,
    );
  }
}

export function loadMoadianConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  mode: MoadianMode;
  config?: Omit<MoadianLiveConfig, 'fetchImpl'>;
} {
  const rawMode = env.MOADIAN_MODE ?? 'mock';
  const VALID_MODES: readonly MoadianMode[] = ['mock', 'sandbox', 'live'];
  // STRICT validation: an invalid/unknown value is a configuration ERROR —
  // it is never silently interpreted as live/mock
  if (!VALID_MODES.includes(rawMode as MoadianMode)) {
    throw new MoadianConfigError(
      `MOADIAN_MODE has invalid value "${rawMode}" — valid values are: ${VALID_MODES.join(', ')}`,
    );
  }
  const mode = rawMode as MoadianMode;
  if (mode === 'mock') return { mode };
  const fields = {
    fiscalId: env.MOADIAN_FISCAL_ID,
    economicCode: env.MOADIAN_ECONOMIC_CODE,
    clientId: env.MOADIAN_CLIENT_ID,
    privateKeyPem: pem(env.MOADIAN_PRIVATE_KEY),
    certificatePem: pem(env.MOADIAN_CERTIFICATE),
  };
  const missing = Object.entries(fields)
    .filter(([, value]) => !value)
    .map(([key]) => `MOADIAN_${key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`);
  if (missing.length > 0) {
    throw new MoadianConfigError(
      `MOADIAN_MODE=${mode} but required configuration is missing: ${missing.join(', ')}. ` +
        'Set these environment variables or use MOADIAN_MODE=mock.',
    );
  }
  const present = fields as {
    fiscalId: string;
    economicCode: string;
    clientId: string;
    privateKeyPem: string;
    certificatePem: string;
  };
  const baseUrl = env.MOADIAN_BASE_URL || 'https://tp.tax.gov.ir/requestsmanager/api/v2';
  validateMoadianBaseUrl(baseUrl);
  return {
    mode,
    config: {
      baseUrl,
      ...present,
    },
  };
}

export function buildMoadianAdapter(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): MoadianAdapter {
  const { mode, config } = loadMoadianConfigFromEnv(env);
  if (mode === 'mock') return new MockMoadianAdapter();
  return new MoadianHttpAdapter({ ...config!, fetchImpl });
}
