import { defineConfig } from "@playwright/test";

/**
 * BUG-001 regression harness — drives the REAL running stack
 * (backend :3001 + frontend :3000) with the system-installed Edge/Chrome
 * (channel — no browser download needed; the repo convention stays
 * dependency-light: @playwright/test is the ONLY test devDependency).
 *
 * Run:  npx playwright test e2e/bug-001-focus.spec.ts
 * Pre:  backend+frontend running (run-local.bat or npm run start in both apps)
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    channel: "msedge",
    baseURL: "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
  },
  webServer: undefined, // the stack must already be running (run-local.bat)
});
