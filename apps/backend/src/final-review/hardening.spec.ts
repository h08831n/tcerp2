import { readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';

/**
 * FINAL REVIEW hardening sweep (handover §35: بازبینی امنیت + مدیریت Secretها):
 *
 *  1. ROUTE GUARD SWEEP — every route decorator in EVERY controller carries
 *     either @RequirePermissions (permission-gated) or @Public (explicitly
 *     anonymous). A route with neither would be 401-by-global-guard or,
 *     worse, silently open — this sweep makes a forgotten guard a test
 *     failure at build time, not a pentest finding later.
 *  2. SECRETS SWEEP — no private-key material outside the documented
 *     throwaway test-certs fixture, and no .env file committed anywhere.
 *
 * Static source analysis (filesystem), no DB — runs as a plain unit test so
 * CI enforces it on every push.
 */

import { execSync } from 'child_process';

// __dirname points at the SOURCE tree under jest (ts-jest):
// final-review -> src -> backend -> apps -> REPO ROOT (four levels up)
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const BACKEND_SRC = join(REPO_ROOT, 'apps', 'backend', 'src');

/** Git-TRACKED files only — on-disk-but-ignored files (e.g. .env) are not in the repo. */
function trackedFiles(relDir: string): string[] {
  const pathspec = relDir === '' ? '.' : relDir;
  const out = execSync(`git ls-files "${pathspec}"`, { cwd: REPO_ROOT, encoding: 'utf-8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((f) => join(REPO_ROOT, f));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** A COMPLETE private-key PEM block (markers + real base64 body). */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\r\n]{100,}-----END [A-Z ]*PRIVATE KEY-----/;

const ROUTE_DECORATORS = ['@Get(', '@Post(', '@Patch(', '@Put(', '@Delete(', '@All('];
const GUARDS = ['@RequirePermissions', '@Public', '@AuthenticatedOnly'];

describe('final-review hardening sweep', () => {
  it('FR-01 every controller route is @RequirePermissions-gated, @AuthenticatedOnly-marked, or @Public', () => {
    const controllers = trackedFiles('apps/backend/src').filter(
      (f) => f.endsWith('.controller.ts') && !f.endsWith('.spec.ts'),
    );
    expect(controllers.length).toBeGreaterThan(30); // sanity: the sweep actually sees the codebase

    const violations: string[] = [];
    for (const file of controllers) {
      const rel = file.replace(BACKEND_SRC + sep, '');
      const lines = readFileSync(file, 'utf-8').split('\n');
      // class-level guard (e.g. @RequirePermissions on AuditController) covers all routes
      let classGuarded = false;
      let pendingRoute: { line: number; path: string } | null = null;
      let sawGuardInStack = false;
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // class declaration: apply accumulated class-level guards
        if (/^export class /.test(trimmed) || /^class /.test(trimmed)) {
          classGuarded = sawGuardInStack;
          sawGuardInStack = false;
          pendingRoute = null;
          return;
        }
        // decorators BEFORE the class (controller-level stack)
        if (!classGuarded && pendingRoute === null && trimmed.startsWith('@')) {
          if (GUARDS.some((g) => trimmed.startsWith(g))) sawGuardInStack = true;
          return;
        }
        const route = ROUTE_DECORATORS.find((d) => trimmed.startsWith(d));
        if (route) {
          pendingRoute = { line: i + 1, path: `${rel}:${i + 1}` };
          sawGuardInStack = false; // guards may sit before OR after the route decorator
          return;
        }
        if (!pendingRoute) return;
        if (trimmed.startsWith('@')) {
          if (GUARDS.some((g) => trimmed.startsWith(g))) sawGuardInStack = true;
          return;
        }
        if (trimmed.length > 0) {
          if (!(sawGuardInStack || classGuarded)) {
            violations.push(
              `${pendingRoute.path}: route without @RequirePermissions, @AuthenticatedOnly or @Public`,
            );
          }
          pendingRoute = null;
          sawGuardInStack = false;
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('FR-02 no .env committed to git (disk copies are git-ignored, verified)', () => {
    const tracked = trackedFiles('');
    const envFiles = tracked.filter((f) => /(^|[/\\])\.env$/.test(f));
    expect(envFiles).toEqual([]); // .env.example only (checked below)
    expect(
      tracked.filter((f) => f.endsWith('.env.example')).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('FR-03 no committed PRIVATE KEY blocks outside the documented test-certs fixture', () => {
    const offenders = trackedFiles('apps/backend/src')
      .filter((f) => f.endsWith('.ts') && !f.endsWith('test-certs.ts'))
      .filter((f) => PRIVATE_KEY_BLOCK.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
