"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { GeneralTab } from "@/components/parties/general-tab";
import { PhonesTab } from "@/components/parties/phones-tab";
import { RolesTab } from "@/components/parties/roles-tab";
import { ContactsTab } from "@/components/parties/contacts-tab";
import { AddressesTab } from "@/components/parties/addresses-tab";
import { ScoreTab } from "@/components/parties/score-tab";
import { FinancialTab } from "@/components/parties/financial-tab";
import { TimelineTab } from "@/components/parties/timeline-tab";
import { RoleBadge, ScoreBadge, StatusBadge, TypeBadge } from "@/components/parties/badges";
import { faDigits, jalali } from "@/lib/format";
import {
  archiveParty,
  fetchParty,
  ownerDisplayName,
  partyErrorMessage,
  restoreParty,
  type PartyDetail,
} from "@/lib/party";

const TABS = [
  { key: "general", label: "عمومی" },
  { key: "phones", label: "تلفن‌ها" },
  { key: "roles", label: "نقش‌ها" },
  { key: "contacts", label: "آشنایان" },
  { key: "addresses", label: "آدرس‌ها" },
  { key: "score", label: "امتیاز" },
  { key: "financial", label: "مسئولیت مالی" },
  { key: "timeline", label: "تایم‌لاین" },
  { key: "files", label: "فایل‌ها" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function PartyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [party, setParty] = useState<PartyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("general");
  const [archiving, setArchiving] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchParty(id);
      setParty(result);
    } catch (err) {
      setError(partyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onChanged = useCallback((updated: PartyDetail) => {
    setParty(updated);
  }, []);

  async function handleArchiveToggle() {
    if (!party || archiving) return;
    setArchiving(true);
    setActionError(null);
    try {
      if (party.archivedAt) {
        const restored = await restoreParty(party.id);
        setParty(restored);
      } else {
        await archiveParty(party.id);
        await load();
      }
    } catch (err) {
      setActionError(partyErrorMessage(err));
    } finally {
      setArchiving(false);
    }
  }

  // Tab keyboard navigation: in RTL, ArrowLeft = next tab, ArrowRight = previous.
  function handleTablistKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = TABS.findIndex((tab) => tab.key === activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex + 1) % TABS.length;
    else if (event.key === "ArrowRight")
      nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveTab(TABS[nextIndex].key);
    tabRefs.current[nextIndex]?.focus();
  }

  if (loading && !party) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="inline-flex items-center gap-2 text-sm text-slate-400">
          <svg className="h-6 w-6 animate-spin text-primary-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          در حال بارگذاری پرونده…
        </span>
      </div>
    );
  }

  if (error && !party) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <p role="alert" className="text-sm text-red-600">{error}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button size="sm" onClick={() => void load()}>تلاش مجدد</Button>
          <Link href="/parties" tabIndex={-1}>
            <Button size="sm" variant="secondary">بازگشت به فهرست</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (!party) return null;

  const activeIndex = TABS.findIndex((tab) => tab.key === activeTab);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-slate-800">{party.nameFa}</h2>
              <TypeBadge type={party.type} />
              <StatusBadge archived={Boolean(party.archivedAt)} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              {party.internalCode && (
                <span>کد داخلی: <span dir="ltr">{faDigits(party.internalCode)}</span></span>
              )}
              <span>مالک: {ownerDisplayName(party.owner)}</span>
              <span>نسخه: {faDigits(party.version)}</span>
              <span>ایجاد: {party.createdAt ? jalali(party.createdAt) : "—"}</span>
              {party.archivedAt && <span>بایگانی: {jalali(party.archivedAt)}</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ScoreBadge score={party.score} level={party.scoreLevel} />
              {party.roles.map((entry) => (
                <RoleBadge key={entry.role} role={entry.role} />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/parties" tabIndex={-1}>
              <Button variant="ghost" size="sm">بازگشت</Button>
            </Link>
            <Button
              variant={party.archivedAt ? "secondary" : "danger"}
              size="sm"
              onClick={handleArchiveToggle}
              disabled={archiving}
            >
              {archiving ? "…" : party.archivedAt ? "بازگردانی از بایگانی" : "بایگانی رکورد"}
            </Button>
          </div>
        </div>
        {actionError && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {actionError}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div
          role="tablist"
          aria-label="بخش‌های پرونده"
          onKeyDown={handleTablistKeyDown}
          className="flex flex-wrap gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/70 px-2 pt-2"
        >
          {TABS.map((tab, index) => {
            const selected = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${tab.key}`}
                aria-selected={selected}
                aria-controls={`panel-${tab.key}`}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => setActiveTab(tab.key)}
                className={`-mb-px rounded-t-md border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  selected
                    ? "border-primary-600 bg-white text-primary-700"
                    : "border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`panel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
          className="p-4"
        >
          {activeTab === "general" && <GeneralTab party={party} onChanged={onChanged} />}
          {activeTab === "phones" && <PhonesTab party={party} onChanged={onChanged} />}
          {activeTab === "roles" && <RolesTab party={party} onChanged={onChanged} />}
          {activeTab === "contacts" && <ContactsTab party={party} onChanged={onChanged} />}
          {activeTab === "addresses" && <AddressesTab party={party} onChanged={onChanged} />}
          {activeTab === "score" && <ScoreTab party={party} onChanged={onChanged} />}
          {activeTab === "financial" && <FinancialTab party={party} />}
          {activeTab === "timeline" && <TimelineTab party={party} />}
          {activeTab === "files" && (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" className="h-10 w-10 text-slate-300"
                aria-hidden="true">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M9 13h6M9 17h4" />
              </svg>
              <p className="mt-3 text-sm font-medium text-slate-500">به‌زودی — Phase 3B</p>
              <p className="mt-1 text-xs text-slate-400">مدیریت فایل‌ها و پیوست‌های پرونده</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
