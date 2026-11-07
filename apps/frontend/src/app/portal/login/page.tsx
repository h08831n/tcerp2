"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  requestOtp,
  verifyOtp,
  selectCompany,
  type PortalApiError,
} from "@/lib/portal";

/**
 * Customer portal login (D-2 Phase 3): mobile → OTP → (company selection)
 * → portal dashboard. The session lives in an HttpOnly cookie set by the
 * backend — this page only orchestrates the flow states.
 */
export default function PortalLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"mobile" | "otp" | "select">("mobile");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [companies, setCompanies] = useState<Array<{ portalAccountId: string; companyName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleMobile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const result = await requestOtp(mobile);
      setChallengeId(result.challengeId);
      setStep("otp");
      setNotice("کد ورود پیامک شد.");
    } catch (e) {
      setError((e as PortalApiError).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const result = await verifyOtp(mobile, challengeId, code);
      if (result.sessionActive) {
        router.push("/portal");
        return;
      }
      setCompanies(result.pendingSelection ?? []);
      setStep("select");
    } catch (e) {
      setError((e as PortalApiError).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelect(portalAccountId: string) {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      await selectCompany(portalAccountId);
      router.push("/portal");
    } catch (e) {
      setError((e as PortalApiError).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="mb-2 text-2xl font-bold text-slate-900">پورتال مشتریان</h1>
        <p className="mb-6 text-sm text-slate-500">ورود با شماره موبایل و کد پیامکی</p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}
        {notice && <div className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

        {step === "mobile" && (
          <form onSubmit={handleMobile} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              شماره موبایل
              <Input
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="09xxxxxxxxx"
                inputMode="tel"
                required
                className="mt-1"
              />
            </label>
            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "در حال ارسال…" : "دریافت کد ورود"}
            </Button>
          </form>
        )}

        {step === "otp" && (
          <form onSubmit={handleOtp} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              کد ۶ رقمی
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="------"
                inputMode="numeric"
                maxLength={6}
                required
                className="mt-1 text-center tracking-[0.5em]"
              />
            </label>
            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "بررسی…" : "ورود"}
            </Button>
          </form>
        )}

        {step === "select" && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">حساب شما در چند شرکت فعال است — یکی را انتخاب کنید:</p>
            {companies.map((c) => (
              <button
                key={c.portalAccountId}
                onClick={() => handleSelect(c.portalAccountId)}
                disabled={loading}
                className="w-full rounded-lg border border-slate-200 p-4 text-right hover:border-slate-900"
              >
                <span className="font-medium text-slate-900">{c.companyName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
