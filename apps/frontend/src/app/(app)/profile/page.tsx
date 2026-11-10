"use client";

/**
 * CORE-004 §6 — پروفایل من: self-service profile editing.
 *
 * Only whitelisted self-service fields are editable (name/email/mobile/
 * language/timezone/avatar). Roles, permissions, status and company scope
 * are READ-ONLY here — the user cannot self-promote. Password change is a
 * separate secure form (current password re-authentication).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiJson, apiFetch, apiOriginUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { faDigits } from "@/lib/format";

export default function ProfilePage() {
  const { user, permissions, refresh } = useAuth();

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    mobile: "",
    language: "fa",
    timezone: "Asia/Tehran",
    avatarUrl: "",
  });
  const [version, setVersion] = useState(0);
  void version;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);

  // password form
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  // avatar upload/replace/remove (real Files/MinIO backend: POST /auth/avatar)
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarV, setAvatarV] = useState(0); // preview cache-buster
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Internal avatar paths (/api/auth/avatar/:id) must hit the API origin;
  // external http(s) URLs render as-is.
  const avatarSrc = form.avatarUrl
    ? form.avatarUrl.startsWith("/")
      ? `${apiOriginUrl(form.avatarUrl)}?v=${avatarV}`
      : form.avatarUrl
    : null;

  function avatarErrorMessage(msg: string): string {
    if (msg.includes("AVATAR_TOO_LARGE")) return "حجم تصویر حداکثر ۲ مگابایت است.";
    if (msg.includes("AVATAR_INVALID_TYPE")) return "فقط تصویر PNG، JPEG یا WebP مجاز است.";
    return msg;
  }

  async function handleAvatarFile(file: File) {
    setAvatarError(null);
    setProfileNotice(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setAvatarError("فقط تصویر PNG، JPEG یا WebP مجاز است.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAvatarError("حجم تصویر حداکثر ۲ مگابایت است.");
      return;
    }
    setAvatarBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch("/auth/avatar", { method: "POST", body: fd });
      const data = (await res.json()) as { avatarUrl?: string };
      setForm((f) => ({ ...f, avatarUrl: data.avatarUrl ?? "" }));
      setAvatarV((v) => v + 1);
      await refresh(); // Header updates IMMEDIATELY (no re-login)
      setProfileNotice("تصویر پروفایل به‌روزرسانی شد و در Header نمایش داده شد.");
    } catch (err) {
      setAvatarError(avatarErrorMessage(err instanceof Error ? err.message : "خطا در بارگذاری تصویر"));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleAvatarRemove() {
    setAvatarError(null);
    setProfileNotice(null);
    setAvatarBusy(true);
    try {
      await apiFetch("/auth/avatar", { method: "DELETE" });
      setForm((f) => ({ ...f, avatarUrl: "" }));
      await refresh();
      setProfileNotice("تصویر پروفایل حذف شد.");
    } catch (err) {
      setAvatarError(avatarErrorMessage(err instanceof Error ? err.message : "خطا در حذف تصویر"));
    } finally {
      setAvatarBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiJson<{
      username: string;
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
      mobile?: string | null;
      language?: string;
      timezone?: string;
      avatarUrl?: string | null;
      version?: number;
      rolesPerCompany?: { roles: { code: string; nameFa: string }[] }[];
      permissions?: string[];
    }>("/auth/me")
      .then((me) => {
        if (cancelled) return;
        setForm({
          firstName: me.firstName ?? "",
          lastName: me.lastName ?? "",
          email: me.email ?? "",
          mobile: me.mobile ?? "",
          language: me.language ?? "fa",
          timezone: me.timezone ?? "Asia/Tehran",
          avatarUrl: me.avatarUrl ?? "",
        });
        setVersion(me.version ?? 0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "خطا");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Roles are READ-ONLY on the profile page (IAM-001: no self-promotion).
  const [rolesChips, setRolesChips] = useState<string[]>([]);
  useEffect(() => {
    apiJson<{ rolesPerCompany?: { roles: { code: string; nameFa: string }[] }[] }>("/auth/me")
      .then((me) => {
        const chips = new Set<string>();
        for (const rpc of me.rolesPerCompany ?? []) {
          for (const r of rpc.roles) chips.add(r.nameFa || r.code);
        }
        setRolesChips(Array.from(chips));
      })
      .catch(() => undefined);
  }, []);

  async function handleSaveProfile() {
    setSaving(true);
    setProfileError(null);
    setProfileNotice(null);
    try {
      await apiJson("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({
          firstName: form.firstName.trim() || undefined,
          lastName: form.lastName.trim() || undefined,
          email: form.email.trim() || undefined,
          mobile: form.mobile.trim() || undefined,
          language: form.language,
          timezone: form.timezone.trim() || undefined,
          avatarUrl: form.avatarUrl.trim() || undefined,
        }),
      });
      await refresh(); // Header updates WITHOUT re-login (CORE-004 §6).
      setProfileNotice("پروفایل ذخیره شد و در Header به‌روزرسانی شد.");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "خطا در ذخیره پروفایل");
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword() {
    setPwError(null);
    setPwNotice(null);
    if (newPassword !== confirmPassword) {
      setPwError("تکرار رمز عبور مطابقت ندارد.");
      return;
    }
    setPwSaving(true);
    try {
      await apiJson("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      // Keep the form open so the success notice is visible next to it.
      setPwNotice("رمز عبور تغییر کرد. از این پس با رمز جدید وارد شوید.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "خطا در تغییر رمز";
      setPwError(
        msg.includes("CURRENT_PASSWORD_INCORRECT")
          ? "رمز عبور فعلی نادرست است."
          : msg,
      );
    } finally {
      setPwSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400">در حال بارگذاری…</p>;

  const avatarBlock = (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        {avatarSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarSrc} alt="آواتار" className="h-16 w-16 rounded-full object-cover" />
        ) : (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-100 text-xl font-bold text-primary-700">
            {(user?.username ?? "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        {avatarBusy && (
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-white/70 text-[10px] text-slate-600">
            …
          </span>
        )}
      </div>
      <div className="flex gap-1">
        <button
          type="button"
          data-testid="avatar-change"
          disabled={avatarBusy}
          onClick={() => avatarInputRef.current?.click()}
          className="rounded border border-slate-300 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {form.avatarUrl ? "تعویض تصویر" : "بارگذاری تصویر"}
        </button>
        {form.avatarUrl && (
          <button
            type="button"
            data-testid="avatar-remove"
            disabled={avatarBusy}
            onClick={() => void handleAvatarRemove()}
            className="rounded border border-red-200 px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            حذف
          </button>
        )}
      </div>
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (file) void handleAvatarFile(file);
        }}
      />
      {avatarError && (
        <div role="alert" data-testid="avatar-error" className="max-w-48 text-center text-[10px] text-red-600">
          {avatarError}
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Identity header */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-bold text-slate-800">پروفایل من</h2>
        <div className="flex items-center gap-4">
          {avatarBlock}
          <div>
            <h2 className="text-lg font-bold text-slate-800">
              {[form.firstName, form.lastName].filter(Boolean).join(" ") || user?.username}
            </h2>
            <p className="text-xs text-slate-500" dir="ltr">
              {user?.username}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rolesChips.map((c) => (
                <span key={c} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                  {c}
                </span>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-500">
          نقش‌ها و مجوزها فقط برای مشاهده هستند و توسط مدیر سیستم تخصیص داده می‌شوند — کاربر نمی‌تواند
          دسترسی خود را تغییر دهد.
        </p>
      </section>

      {/* Profile form */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-slate-800">اطلاعات پروفایل</h3>
        {profileError && (
          <div role="alert" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {profileError}
          </div>
        )}
        {profileNotice && (
          <div role="status" className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {profileNotice}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="pf-first" className="mb-1 block text-xs font-medium text-slate-600">نام</label>
            <Input id="pf-first" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pf-last" className="mb-1 block text-xs font-medium text-slate-600">نام خانوادگی</label>
            <Input id="pf-last" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pf-email" className="mb-1 block text-xs font-medium text-slate-600">ایمیل</label>
            <Input id="pf-email" dir="ltr" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pf-mobile" className="mb-1 block text-xs font-medium text-slate-600">موبایل</label>
            <Input id="pf-mobile" dir="ltr" value={form.mobile} onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pf-lang" className="mb-1 block text-xs font-medium text-slate-600">زبان</label>
            <select
              id="pf-lang"
              value={form.language}
              onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}
              className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="fa">فارسی</option>
              <option value="en">English</option>
            </select>
          </div>
          <div>
            <label htmlFor="pf-tz" className="mb-1 block text-xs font-medium text-slate-600">منطقه زمانی</label>
            <Input id="pf-tz" dir="ltr" value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="pf-avatar" className="mb-1 block text-xs font-medium text-slate-600">
              تصویر پروفایل (آدرس تصویر)
            </label>
            <Input id="pf-avatar" dir="ltr" value={form.avatarUrl} onChange={(e) => setForm((f) => ({ ...f, avatarUrl: e.target.value }))} placeholder="https://…" />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={() => void handleSaveProfile()} disabled={saving}>
            {saving ? "در حال ذخیره…" : "ذخیره پروفایل"}
          </Button>
        </div>
      </section>

      {/* Password change */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-slate-800">تغییر رمز عبور</h3>
        {!pwOpen ? (
          <Button variant="secondary" onClick={() => setPwOpen(true)}>
            تغییر رمز عبور
          </Button>
        ) : (
          <div className="space-y-3">
            {pwError && (
              <div role="alert" data-testid="pw-error" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {pwError}
              </div>
            )}
            {pwNotice && (
              <div role="status" data-testid="pw-notice" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {pwNotice}
              </div>
            )}
            <div>
              <label htmlFor="pw-current" className="mb-1 block text-xs font-medium text-slate-600">رمز عبور فعلی *</label>
              <Input id="pw-current" type="password" dir="ltr" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="pw-new" className="mb-1 block text-xs font-medium text-slate-600">رمز جدید (حداقل ۸ نویسه) *</label>
                <Input id="pw-new" type="password" dir="ltr" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div>
                <label htmlFor="pw-confirm" className="mb-1 block text-xs font-medium text-slate-600">تکرار رمز جدید *</label>
                <Input id="pw-confirm" type="password" dir="ltr" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setPwOpen(false); setPwError(null); }}>
                انصراف
              </Button>
              <Button size="sm" onClick={() => void handleChangePassword()} disabled={pwSaving}>
                {pwSaving ? "…" : "تغییر رمز"}
              </Button>
            </div>
            <p className="text-[11px] text-slate-400">
              با تغییر رمز، سایر دستگاه‌ها از حساب خارج می‌شوند؛ نشست فعلی حفظ می‌شود.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
