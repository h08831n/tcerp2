/**
 * .env-FIRST proof at the configuration layer (backlog/CLI-01 requirement:
 * "بارگذاری .env قبل از بررسی مقصد دیتابیس"). A .env file in process.cwd()
 * is the ONLY source of DATABASE_URL — loadConfig must load it before any
 * target resolution. Jest module registry is reset per case so the config
 * cache never leaks between them.
 */
describe('configuration .env-first (loadConfig reads cwd/.env)', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  let tempDir = '';
  let originalCwd = '';

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-envfirst-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function loadFresh(env: Record<string, string | undefined>) {
    // jest.resetModules gives a FRESH configuration module → fresh cache.
    const { loadConfig } = require('../config/configuration');
    const saved: Array<[string, string | undefined]> = Object.entries(env).map(
      ([k]) => [k, process.env[k]] as [string, string | undefined],
    );
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return loadConfig();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const JWT = { JWT_SECRET: 'envfirst-jwt-secret-0123456789', JWT_REFRESH_SECRET: 'envfirst-jwt-refresh-secret-0123456789' };

  it('a DATABASE_URL that exists ONLY in .env is loaded by loadConfig', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'DATABASE_URL=postgresql://tcerp:tcerp@localhost:5433/envfirst-proof?schema=public\n',
    );
    const config = loadFresh({ ...JWT, DATABASE_URL: undefined });
    expect(config.DATABASE_URL).toBe('postgresql://tcerp:tcerp@localhost:5433/envfirst-proof?schema=public');
  });

  it('NO DATABASE_URL anywhere → loadConfig FAILS CLOSED (typed error naming DATABASE_URL)', () => {
    let message = '';
    try {
      loadFresh({ ...JWT, DATABASE_URL: undefined });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('Invalid environment configuration');
    expect(message).toContain('DATABASE_URL');
  });

  it('process.env WINS over .env (loadEnvFile only fills unset vars)', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'DATABASE_URL=postgresql://tcerp:tcerp@localhost:5433/from-dotenv?schema=public\n',
    );
    const config = loadFresh({ ...JWT, DATABASE_URL: 'postgresql://tcerp:tcerp@localhost:5433/from-process-env?schema=public' });
    expect(config.DATABASE_URL).toBe('postgresql://tcerp:tcerp@localhost:5433/from-process-env?schema=public');
  });
});
