import { expect, test, type Page } from "@playwright/test";

/**
 * BUG-001 regression — focus MUST survive every keystroke.
 *
 * Root cause (fixed in components/ui/modal.tsx): the modal's open/close
 * effect depended on the `onClose` prop identity. Pages pass inline arrow
 * handlers, so every keystroke (state lives in the page) re-ran the effect
 * and `panelRef.focus()` stole focus from the input after the FIRST
 * character. The fix holds onClose in a ref and depends only on `open`.
 *
 * These tests type CHARACTER BY CHARACTER (pressSequentially) — a fill()-only
 * test cannot see this bug. The invariant asserted after every character:
 * document.activeElement is still the input under test.
 */

const ADMIN_USER = "admin";
/** Read from the environment — NEVER hardcode credentials. */
const ADMIN_PASSWORD = process.env.TCERP_ADMIN_PASSWORD ?? "";

test.beforeEach(async ({ page }) => {
  if (!ADMIN_PASSWORD) {
    throw new Error("TCERP_ADMIN_PASSWORD env var is required (read it from apps/backend/.env — never commit it)");
  }
  await page.goto("/login");
  await page.getByRole("textbox", { name: "نام کاربری" }).fill(ADMIN_USER);
  await page.getByRole("textbox", { name: "رمز عبور" }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await page.waitForURL("**/dashboard");
});

/**
 * Types `text` one character at a time and asserts after EVERY character:
 *  - document.activeElement is still this input (no focus steal), AND
 *  - the field's real value equals the expected string (cursor/selection
 *    aware — handles append AND selection-replace; no character lost or
 *    reordered under fast typing).
 */
async function typeCharByChar(page: Page, input: ReturnType<Page["getByRole"]>, text: string) {
  const failures: string[] = [];
  for (const ch of Array.from(text)) {
    const before = await input.inputValue();
    const [selStart, selEnd] = await input.evaluate((el) => {
      const i = el as HTMLInputElement | HTMLTextAreaElement;
      return [i.selectionStart ?? i.value.length, i.selectionEnd ?? i.value.length];
    });
    await input.pressSequentially(ch, { delay: 30 });
    const stillFocused = await input.evaluate((el) => document.activeElement === el);
    const actual = await input.inputValue();
    const expected = before.slice(0, selStart) + ch + before.slice(selEnd);
    if (!stillFocused) failures.push(`focus lost after «${ch}»`);
    if (actual !== expected) failures.push(`value mismatch after «${ch}»: [${actual}] != [${expected}]`);
  }
  expect(failures, failures.join("; ")).toEqual([]);
}

test.describe("BUG-001 focus retention", () => {
  test("S1/S2/S6 — continuous Persian + English typing in a MODAL keeps focus after EVERY char", async ({ page }) => {
    await page.goto("/crm/leads");
    await page.getByRole("button", { name: "سرنخ جدید" }).click();
    const name = page.getByRole("textbox", { name: "نام سرنخ" });
    await name.click();

    // The regression invariant: DOM identity must not change either (no remount).
    await name.evaluate((el) => el.setAttribute("data-focus-regression", "original"));

    const persian = "شرکت بازرگانی نمونه البرز";
    await typeCharByChar(page, name, persian);
    await expect(name).toHaveValue(persian);

    // S7: clear and retype (both languages in one modal session).
    await name.fill("");
    const english = "Test Customer Company 123";
    await typeCharByChar(page, name, english);
    await expect(name).toHaveValue(english);

    // Same DOM node the whole time (no remount happened).
    await expect(name).toHaveAttribute("data-focus-regression", "original");
  });

  test("S7/S8/S9 — clear, retype, replace-selection, backspace keep focus", async ({ page }) => {
    await page.goto("/crm/leads");
    await page.getByRole("button", { name: "سرنخ جدید" }).click();
    const name = page.getByRole("textbox", { name: "نام سرنخ" });
    await name.click();
    await name.pressSequentially("پترو تجارت تهران");

    // Replace a selection mid-string.
    await name.evaluate((el) => {
      const input = el as HTMLInputElement;
      input.focus();
      input.setSelectionRange(0, 5);
    });
    await typeCharByChar(page, name, "فولاد");
    const replaced = await name.inputValue();
    expect(replaced.startsWith("فولاد")).toBe(true);

    // Backspace keeps focus.
    await name.press("End");
    await name.press("Backspace");
    expect(await name.evaluate((el) => document.activeElement === el)).toBe(true);
  });

  test("S10 — TEXTAREA typing (notes field in the same modal)", async ({ page }) => {
    await page.goto("/crm/leads");
    await page.getByRole("button", { name: "سرنخ جدید" }).click();
    const notes = page.getByRole("textbox", { name: "یادداشت سرنخ" });
    await notes.click();
    await typeCharByChar(page, notes, "خط اول یادداشت");
    await notes.press("Enter");
    await typeCharByChar(page, notes, "خط دوم");
    expect(await notes.evaluate((el) => document.activeElement === el)).toBe(true);
  });

  test("S12 — Tab moves focus between fields (no focus trap regression)", async ({ page }) => {
    await page.goto("/crm/leads");
    await page.getByRole("button", { name: "سرنخ جدید" }).click();
    const name = page.getByRole("textbox", { name: "نام سرنخ" });
    await name.click();
    await name.press("Tab");
    const next = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName);
    expect(next).not.toBe("نام سرنخ"); // focus actually MOVED
    expect(next).not.toBe("DIV"); // and did NOT collapse onto the dialog panel
  });

  test("S13 — DatePicker text input keeps focus while typing the Jalali date (in a modal)", async ({ page }) => {
    // Party rows open via the row's «مشاهده پرونده …» accessible name (the
    // whole row is the link — there is no <a> per row).
    await page.goto("/parties");
    const row = page.getByRole("row", { name: /مشاهده پرونده/ }).first();
    await row.click();
    // SPA navigation: wait for the party page's tab list to RENDER, not just
    // the document load event.
    const activitiesTab = page.getByRole("tab", { name: "فعالیت‌ها" });
    await activitiesTab.waitFor({ state: "visible", timeout: 15000 });
    await activitiesTab.click();
    await page.getByRole("button", { name: "فعالیت جدید" }).click();
    const dp = page.getByRole("textbox", { name: "موعد فعالیت - تاریخ" });
    await dp.click();
    await typeCharByChar(page, dp, "14030115");
    expect(await dp.evaluate((el) => document.activeElement === el)).toBe(true);
    // The picker displays the typed Jalali digits (۱۴۰۳...) — value non-empty.
    expect((await dp.inputValue()).length).toBeGreaterThan(0);
  });

  test("S14/S15 — page-level form (parties/new) + validation error do NOT steal focus", async ({ page }) => {
    await page.goto("/parties/new");
    const name = page.getByRole("textbox", { name: "نام فارسی *" });
    await name.click();
    await typeCharByChar(page, name, "شرکت تستی برای فوکوس");
    expect(await name.evaluate((el) => document.activeElement === el)).toBe(true);
    // Trigger the save — the CLICK legitimately moves focus to the button;
    // the BUG-001 invariant is about TYPING: after the save attempt (whether
    // a validation error rendered or the save succeeded), focusing the field
    // again and continuing to type must keep focus on every character.
    await page.getByRole("button", { name: "ذخیره" }).click();
    await page.waitForTimeout(600);
    if (await name.isVisible()) {
      await name.click();
      await typeCharByChar(page, name, " ادامه");
    } else {
      expect(page.url()).toContain("/parties/"); // navigated = success path
    }
  });
});

test.describe("BUG-001 — modal lifecycle & more modals (R2 verification round)", () => {
  test("Escape closes the lead modal AND returns focus to the opener button", async ({ page }) => {
    await page.goto("/crm/leads");
    const opener = page.getByRole("button", { name: "سرنخ جدید" });
    await opener.click();
    const name = page.getByRole("textbox", { name: "نام سرنخ" });
    await name.click();
    await typeCharByChar(page, name, "تست بستن");
    // Escape — focus must return to the element that OPENED the modal.
    await name.press("Escape");
    await expect(page.getByRole("dialog", { name: "ثبت سرنخ جدید" })).toHaveCount(0);
    expect(await opener.evaluate((el) => document.activeElement === el)).toBe(true);
  });

  test("Activity modal — Persian title typing + value assertion after every char", async ({ page }) => {
    await page.goto("/parties");
    const row = page.getByRole("row", { name: /مشاهده پرونده/ }).first();
    await row.click();
    const activitiesTab = page.getByRole("tab", { name: "فعالیت‌ها" });
    await activitiesTab.waitFor({ state: "visible", timeout: 15000 });
    await activitiesTab.click();
    await page.getByRole("button", { name: "فعالیت جدید" }).click();
    const title = page.getByRole("textbox", { name: "عنوان *" });
    await title.click();
    await typeCharByChar(page, title, "تماس پیگیری سفارش");
    await expect(title).toHaveValue("تماس پیگیری سفارش");
  });

  test("Paste into the lead-modal notes keeps focus and value", async ({ page }) => {
    await page.goto("/crm/leads");
    await page.getByRole("button", { name: "سرنخ جدید" }).click();
    const notes = page.getByRole("textbox", { name: "یادداشت سرنخ" });
    await notes.click();
    await notes.pressSequentially("پیش‌متن ");
    const pasted = await notes.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return document.execCommand("insertText", false, "متن Paste‌شده");
    });
    expect(pasted).toBe(true);
    await expect(notes).toHaveValue("پیش‌متن متن Paste‌شده");
    expect(await notes.evaluate((el) => document.activeElement === el)).toBe(true);
  });

  test("Sales document line inputs (page-level production form) keep focus", async ({ page }) => {
    // Self-sufficient: create a fresh DRAFT via the real UI flow, then type
    // into the line inputs (no dependency on leftover DB state).
    await page.goto("/sales/new");
    const customer = page.getByRole("combobox", { name: "انتخاب مشتری" });
    await customer.click();
    await customer.pressSequentially("شرکت", { delay: 40 });
    await page.waitForTimeout(900);
    await page.getByRole("listbox").first().getByRole("option").first().click();
    await page.getByRole("button", { name: /ایجاد پیش‌نویس سند/ }).click();
    await page.waitForTimeout(2000);
    const goButton = page.getByRole("button", { name: "رفتن به صفحه سند" });
    await goButton.waitFor({ state: "visible", timeout: 15000 });
    await goButton.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1200);

    // Product → variant → qty → price, asserting focus after every char.
    const product = page.getByRole("combobox", { name: "انتخاب محصول" });
    await product.click();
    await product.pressSequentially("میلگرد", { delay: 40 });
    await page.waitForTimeout(900);
    await page.getByRole("option").first().click();
    const variant = page.getByRole("combobox", { name: "انتخاب variant محصول" });
    await variant.selectOption({ index: 1 });

    const qty = page.getByRole("textbox", { name: "تعداد خط جدید" });
    await qty.click();
    await typeCharByChar(page, qty, "25");
    expect(await qty.evaluate((el) => document.activeElement === el)).toBe(true);
    const price = page.getByRole("textbox", { name: "قیمت واحد خط جدید" });
    await price.click();
    await typeCharByChar(page, price, "1500000");
    expect(await price.evaluate((el) => document.activeElement === el)).toBe(true);
  });
});
