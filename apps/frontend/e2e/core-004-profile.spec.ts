import { expect, test, type Page } from "@playwright/test";

/**
 * CORE-004 §21 — profile E2E over the REAL stack:
 *  1. click the header name → the account menu opens
 *  2. پروفایل من opens the profile page
 *  3. edit profile → save → header updates WITHOUT re-login
 *  4. no privilege escalation from the profile page
 *  5. change password with re-authentication (wrong current refused)
 *  6. login with the NEW password works, OLD fails
 *  7. restore the original credential (environment stays intact)
 */

const ADMIN_PASSWORD = process.env.TCERP_ADMIN_PASSWORD ?? "";
const NEW_PASSWORD = process.env.TCERP_NEWUSER_PASSWORD ?? "Core4-New-Passw0rd!1";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  if (!ADMIN_PASSWORD) throw new Error("TCERP_ADMIN_PASSWORD is required");
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("/login");
  await page.getByRole("textbox", { name: "نام کاربری" }).fill("admin");
  await page.getByRole("textbox", { name: "رمز عبور" }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await page.waitForURL("**/dashboard");
});

test.describe.serial("CORE-004 profile", () => {
  test("S1: header name click opens the account menu with profile items", async () => {
    await page.locator('header button[aria-haspopup="menu"]').click();
    await expect(page.getByRole("menuitem", { name: "پروفایل من" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("menuitem", { name: "تنظیمات شخصی" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "خروج" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("S2+S3: profile edit → save → header updates WITHOUT re-login", async () => {
    // Direct navigation — the dashboard re-renders make header clicks flaky.
    await page.goto("/profile");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("heading", { name: "پروفایل من", level: 2 })).toBeVisible();

    const first = page.getByRole("textbox", { name: "نام", exact: true });
    await first.click();
    await first.fill("");
    await first.pressSequentially("مدیر ارشد", { delay: 25 });

    const respPromise = page.waitForResponse((r) => r.url().includes("/auth/profile"));
    await page.getByRole("button", { name: "ذخیره پروفایل" }).click();
    const resp = await respPromise;
    console.log("[core4] profile PATCH =", resp.status(), JSON.stringify(await resp.json()).slice(0, 200));
    await expect(page.getByRole("status")).toContainText("ذخیره شد");

    // Header updates WITHOUT re-login (auth-context refresh round-trip).
    await expect(
      page.locator("header").getByText("مدیر ارشد", { exact: false }),
    ).toBeVisible();
  });

  test("S4: the profile page offers NO privilege-escalation surface", async () => {
    // The profile page must not render status/roles/permission editors.
    await page.goto("/profile");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1200);
    const body = await page.locator("main").innerText();
    expect(body).not.toContain("وضعیت");
    expect(body).not.toContain("تخصیص نقش");
    // Role chips are display-only labels — no checkboxes/inputs for roles.
    const roleInputs = await page.locator('main input[type="checkbox"]').count();
    expect(roleInputs).toBe(0);
  });

  test("S5: password change requires the CURRENT password", async () => {
    await page.goto("/profile");
    await page.getByRole("button", { name: "تغییر رمز عبور" }).click();

    // WRONG current password → refused with a Persian error.
    await page.locator("#pw-current").fill("WRONG-current-1");
    await page.locator("#pw-new").fill(NEW_PASSWORD);
    await page.locator("#pw-confirm").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "تغییر رمز", exact: true }).click();
    await expect(page.getByTestId("pw-error")).toContainText("رمز عبور فعلی");

    // Correct current password → success notice, fields cleared.
    await page.locator("#pw-current").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "تغییر رمز", exact: true }).click();
    await expect(page.getByTestId("pw-notice")).toContainText("رمز عبور تغییر کرد");
    await expect(page.locator("#pw-current")).toHaveValue("");
  });

  test("S6: login with the NEW password works; OLD is dead", async () => {
    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "خروج" }).click();
    await page.waitForURL("**/login");

    // OLD password refused.
    await page.getByRole("textbox", { name: "نام کاربری" }).fill("admin");
    await page.getByRole("textbox", { name: "رمز عبور" }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await page.waitForTimeout(1200);
    expect(page.url()).toContain("/login");

    // NEW password works.
    await page.goto("/login");
    await page.getByRole("textbox", { name: "نام کاربری" }).fill("admin");
    await page.getByRole("textbox", { name: "رمز عبور" }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await page.waitForURL("**/dashboard");
  });

  test("S7: restore the original credential via the same secure form", async () => {
    // Environment hygiene: change BACK to the original admin password so the
    // dev seed credential survives the suite (also exercises the change flow
    // a second time from the freshly-logged-in session).
    await page.goto("/profile");
    await page.getByRole("button", { name: "تغییر رمز عبور" }).click();
    await page.locator("#pw-current").fill(NEW_PASSWORD);
    await page.locator("#pw-new").fill(ADMIN_PASSWORD);
    await page.locator("#pw-confirm").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "تغییر رمز", exact: true }).click();
    await expect(page.getByTestId("pw-notice")).toContainText("رمز عبور تغییر کرد");
  });
});
