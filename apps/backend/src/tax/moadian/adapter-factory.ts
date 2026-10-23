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

export function loadMoadianConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  mode: MoadianMode;
  config?: MoadianLiveConfig;
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
  return {
    mode,
    config: {
      baseUrl: env.MOADIAN_BASE_URL || undefined,
      ...present,
    },
  };
}

export function buildMoadianAdapter(env: NodeJS.ProcessEnv = process.env): MoadianAdapter {
  const { mode, config } = loadMoadianConfigFromEnv(env);
  if (mode === 'mock') return new MockMoadianAdapter();
  return new MoadianHttpAdapter(config!);
}
