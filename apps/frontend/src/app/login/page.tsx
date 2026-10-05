"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);

    try {
      await apiJson<{ user: unknown; permissions: string[] }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      });
      router.replace("/dashboard");
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "ورود ناموفق بود. دوباره تلاش کنید.",
      );
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-primary-600 shadow-lg shadow-primary-900/40">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-8 w-8 text-white"
              aria-hidden="true"
            >
              <path d="M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">TCERP</h1>
          <p className="mt-1 text-sm text-slate-400">
            سامانه مدیریت آهن و فولاد
          </p>
        </div>

        <div className="rounded-xl border border-slate-700/60 bg-slate-800/80 p-8 shadow-xl">
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <div className="space-y-1.5">
              <label
                htmlFor="identifier"
                className="block text-sm font-medium text-slate-200"
              >
                نام کاربری
              </label>
              <Input
                id="identifier"
                name="identifier"
                autoComplete="username"
                dir="ltr"
                className="text-left"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-slate-200"
              >
                رمز عبور
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                dir="ltr"
                className="text-left"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !identifier || !password}
            >
              {loading ? (
                <>
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  در حال ورود...
                </>
              ) : (
                "ورود"
              )}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          TCERP — سامانه مدیریت آهن و فولاد
        </p>
      </div>
    </main>
  );
}
