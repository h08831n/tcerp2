import { expect, test, type Page } from "@playwright/test";

/**
 * CORE-004 — profile E2E over the REAL stack, run against an ISOLATED test
 * user (§6 test-method correction): the OPERATIONAL admin credential is
 * NEVER changed by this suite. The test user is created via the users API
 * at the start and DELETED in cleanup; cleanup runs even when tests fail.
 *
 * 8 scenarios = 8 serial tests (S1-S8). In the FIRST delivery the report
 * listed 7 scenarios in 6 tests because the profile-edit + header-update
 * scenario (S2+S3 there) was one test block; the avatar round added its
 * own scenarios and every scenario now owns exactly one test.
 *  S2  /profile: identity header, read-only roles, NO escalation surface
 *  S3  profile edit → save → header updates WITHOUT re-login
 *  S4  avatar upload (real file → MinIO) → header shows the image IMMEDIATELY
 *  S5  avatar remove → header falls back to the initial letter
 *  S6  password change: wrong current refused; correct → success
 *  S7  logout → OLD password dead → NEW password works
 *  S8  cleanup: admin login with the ORIGINAL password + test user deleted
 */

const ADMIN_PASSWORD = process.env.TCERP_ADMIN_PASSWORD ?? "";
const USER_PASSWORD = "Core4-User-Passw0rd!1";
const NEW_PASSWORD = "Core4-User-NewPassw0rd!2";
const MARKER = `core4e2e${Date.now()}`;
const USERNAME = `core4-e2e-${MARKER}`;
const API = "http://localhost:3001/api";

test.describe.configure({ mode: "serial" });

let page: Page;
let testUserId = "";

/** Admin token for API-side setup/cleanup (fresh each call, never UI-bound). */
async function adminToken(): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "admin", password: ADMIN_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

test.beforeAll(async ({ browser }) => {
  if (!ADMIN_PASSWORD) throw new Error("TCERP_ADMIN_PASSWORD is required");
  // ISOLATED fixture: a dedicated user for the password/avatar flows.
  const token = await adminToken();
  const create = await fetch(`${API}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username: USERNAME,
      password: USER_PASSWORD,
      firstName: "کاربر",
      lastName: "آزمون CORE-004",
    }),
  });
  expect(create.status).toBe(201);
  const created = (await create.json()) as { id: string };
  testUserId = created.id;

  // Company membership — avatars are stored as company-scoped file
  // attachments, so a memberless user would be refused at upload. Assigning
  // a role implies the membership (IAM-001 §11); an empty roleIds list does
  // NOT create one (verified against the DB), so pick a real non-admin role.
  const me = (await (
    await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { companies?: { id: string }[] };
  const companyId = me.companies?.[0]?.id;
  expect(companyId, "admin has a default company").toBeTruthy();
  const roles = (await (
    await fetch(`${API}/roles?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { items?: { id: string; code: string }[] };
  const role =
    roles.items?.find((r) => r.code === "viewer") ?? roles.items?.find((r) => r.code !== "admin");
  expect(role, "a grantable role exists").toBeTruthy();
  const member = await fetch(`${API}/users/${testUserId}/companies/${companyId}/roles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ roleIds: [role.id] }),
  });
  expect(member.status).toBe(200);

  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
});

test.afterAll(async () => {
  // SAFE CLEANUP — always runs: admin logs in via API (independent of any UI
  // state) and deletes the test user. The admin credential is untouched.
  try {
    if (testUserId) {
      const token = await adminToken();
      await fetch(`${API}/users/${testUserId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch (err) {
    console.error("[core4] cleanup failed:", err);
  }
  await page?.close();
});

test.describe.serial("CORE-004 profile (isolated test user)", () => {
  test("S1: admin logs out; the TEST USER logs in", async () => {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "نام کاربری" }).fill("admin");
    await page.getByRole("textbox", { name: "رمز عبور" }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await page.waitForURL("**/dashboard");

    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "خروج" }).click();
    await page.waitForURL("**/login");

    await page.getByRole("textbox", { name: "نام کاربری" }).fill(USERNAME);
    await page.getByRole("textbox", { name: "رمز عبور" }).fill(USER_PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await page.waitForURL("**/dashboard");
  });

  test("S2: the profile page offers NO privilege-escalation surface", async () => {
    await page.goto("/profile");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1200);
    const body = await page.locator("main").innerText();
    expect(body).not.toContain("وضعیت");
    expect(body).not.toContain("تخصیص نقش");
    // Role chips are display-only labels — no checkbox/input editors.
    expect(await page.locator('main input[type="checkbox"]').count()).toBe(0);
  });

  test("S3: profile edit → save → header updates WITHOUT re-login", async () => {
    const first = page.getByRole("textbox", { name: "نام", exact: true });
    await first.click();
    await first.fill("");
    await first.pressSequentially("کاربر ارشد", { delay: 25 });

    const respPromise = page.waitForResponse((r) => r.url().includes("/auth/profile"));
    await page.getByRole("button", { name: "ذخیره پروفایل" }).click();
    const resp = await respPromise;
    expect(resp.status()).toBe(200);
    await expect(page.getByRole("status")).toContainText("ذخیره شد");

    // Header updates WITHOUT re-login (auth-context refresh round-trip).
    await expect(
      page.locator("header").getByText("کاربر ارشد", { exact: false }),
    ).toBeVisible();

    // Survives a full reload (persisted server-side).
    await page.reload();
    await page.waitForTimeout(1200);
    await expect(
      page.locator("header").getByText("کاربر ارشد", { exact: false }),
    ).toBeVisible();
  });

  test("S4: avatar upload — real file to MinIO, header shows it IMMEDIATELY", async () => {
    // 1x1 red PNG (real image bytes).
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080200000090775" +
        "3de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082",
      "hex",
    );
    await page.setInputFiles('input[type="file"]', {
      name: "avatar.png",
      mimeType: "image/png",
      buffer: png,
    });

    await expect(page.getByTestId("avatar-change")).toHaveText("تعویض تصویر", { timeout: 10000 });
    // The header avatar is now an <img> served by the authenticated route.
    await expect(page.locator("header img[alt]:not([alt=''])").first()).toBeVisible();
    const headerSrc = await page.locator("header img").first().getAttribute("src");
    expect(headerSrc).toContain("/api/auth/avatar/");

    // Byte-level proof: the API serves exactly the uploaded image.
    const token = await adminToken();
    const served = await fetch(`${API}/auth/avatar/${testUserId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

    // Refresh keeps the avatar (persisted).
    await page.reload();
    await page.waitForTimeout(1200);
    await expect(page.locator("header img").first()).toBeVisible();
  });

  test("S5: avatar remove — header falls back to the initial letter", async () => {
    await page.goto("/profile");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.getByTestId("avatar-remove").click();
    await expect(page.getByTestId("avatar-change")).toHaveText("بارگذاری تصویر", { timeout: 10000 });
    await expect(page.locator("header img").first()).toHaveCount(0);
  });

  test("S6: password change — wrong current refused; correct succeeds", async () => {
    await page.goto("/profile");
    await page.getByRole("button", { name: "تغییر رمز عبور" }).click();

    // WRONG current password → Persian error, nothing changes.
    await page.locator("#pw-current").fill("WRONG-current-1");
    await page.locator("#pw-new").fill(NEW_PASSWORD);
    await page.locator("#pw-confirm").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "تغییر رمز", exact: true }).click();
    await expect(page.getByTestId("pw-error")).toContainText("رمز عبور فعلی");

    // Correct current → success notice; the login password is now NEW.
    await page.locator("#pw-current").fill(USER_PASSWORD);
    await page.getByRole("button", { name: "تغییر رمز", exact: true }).click();
    await expect(page.getByTestId("pw-notice")).toContainText("رمز عبور تغییر کرد");
  });

  test("S7: logout → OLD password dead → NEW password works", async () => {
    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "خروج" }).click();
    await page.waitForURL("**/login");

    await page.getByRole("textbox", { name: "نام کاربری" }).fill(USERNAME);
    await page.getByRole("textbox", { name: "رمز عبور" }).fill(USER_PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await page.waitForTimeout(1200);
    expect(page.url()).toContain("/login");

    await page.goto("/login");
    await page.getByRole("textbox", { name: "نام کاربری" }).fill(USERNAME);
    await page.getByRole("textbox", { name: "رمز عبور" }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await page.waitForURL("**/dashboard");
  });

  test("S8: cleanup — admin password UNTOUCHED; test user deleted", async () => {
    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "خروج" }).click();
    await page.waitForURL("**/login");

    // The operational admin credential still works (was NEVER changed).
    await page.getByRole("textbox", { name: "نام کاربری" }).fill("admin");
    await page.getByRole("textbox", { name: "رمز عبور" }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await page.waitForURL("**/dashboard");

    // Delete the isolated test user via the users API.
    const token = await adminToken();
    const del = await fetch(`${API}/users/${testUserId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 204]).toContain(del.status);

    // The deleted (soft-disabled) user can no longer log in — removal is a
    // DISABLE by design (IAM-001: no hard user-row deletes, audit preserved).
    const dead = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: USERNAME, password: NEW_PASSWORD }),
    });
    expect(dead.status).toBe(403); // ForbiddenError: Account is disabled
  });
});
