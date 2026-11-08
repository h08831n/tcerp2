"use client";

/**
 * CR-001 R2 §6 — Odoo-style Smart Buttons on the Party header.
 *
 * Counts are REAL aggregates from GET /parties/:id/smart-counts (every
 * module that holds a Party-attributable record; quotation vs sales order
 * buckets are status-truthful — no double counting). A button renders ONLY
 * when (a) the count exists and (b) the user may see that module's list;
 * clicking navigates to the REAL filtered list. No fake/placeholder buttons.
 * Mobile/RTL: horizontal scroll strip.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { apiJson } from "@/lib/api";
import { faDigits } from "@/lib/format";

interface SmartCounts {
  quotations: number;
  salesOrders: number;
  salesTaxInvoices: number;
  receipts: number;
  payments: number;
  checks: number;
  purchaseOrders: number;
  purchaseTaxInvoices: number;
  loadings: number;
  priceRequests: number;
  openActivities: number;
}

export interface PartySmartButtonsProps {
  partyId: string;
  /** Bump after sibling mutations so counts refresh (Odoo behavior §6.7). */
  refreshToken?: number;
  /** When provided, the فعالیت button switches to the in-page tab instead of navigating. */
  onOpenActivities?: () => void;
}

export function PartySmartButtons({ partyId, refreshToken = 0, onOpenActivities }: PartySmartButtonsProps) {
  const { permissions } = useAuth();
  const [counts, setCounts] = useState<SmartCounts | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    apiJson<SmartCounts>(`/parties/${partyId}/smart-counts`)
      .then((c) => {
        if (!cancelled) {
          setCounts(c);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [partyId]);

  useEffect(() => load(), [load, refreshToken]);

  if (failed || counts === null) return null;
  if (permissions.length === 0) return null;

  const can = (code: string) => permissions.includes(code);

  // [label, count, href, requiredViewPermission]
  const buttons: Array<{ label: string; n: number | null; href: string; perm: string; onClick?: () => void }> = [];
  // R2 §5 step 2: «پیش‌فاکتور جدید» from the Party page — the quotation form
  // opens with THIS party prefilled (conversion happens server-side on save).
  if (can("sales.create")) {
    buttons.push({ label: "+ پیش‌فاکتور جدید", n: null, href: `/sales/new?partyId=${partyId}`, perm: "sales.create" });
  }
  if (can("crm.view") || can("sales.view")) {
    if (counts.quotations > 0)
      buttons.push({ label: "پیش‌فاکتورها", n: counts.quotations, href: `/sales?customerPartyId=${partyId}`, perm: "sales.view" });
    if (counts.salesOrders > 0)
      buttons.push({ label: "سفارش‌های فروش", n: counts.salesOrders, href: `/sales?customerPartyId=${partyId}`, perm: "sales.view" });
  }
  if (can("tax.view") && counts.salesTaxInvoices > 0)
    buttons.push({ label: "فاکتورهای فروش", n: counts.salesTaxInvoices, href: `/tax-invoices`, perm: "tax.view" });
  if (can("treasury.view") && counts.receipts > 0)
    // receipts list = the ops tab (a party-filtered receipts list is a next-phase item)
    buttons.push({ label: "دریافت‌ها", n: counts.receipts, href: `/treasury?tab=ops`, perm: "treasury.view" });
  if (can("treasury.view") && counts.payments > 0)
    buttons.push({ label: "پرداخت‌ها", n: counts.payments, href: `/treasury?tab=ops`, perm: "treasury.view" });
  if (can("treasury.view") && counts.checks > 0)
    buttons.push({ label: "تسویه‌ها (چک)", n: counts.checks, href: `/treasury?tab=checks&partyId=${partyId}`, perm: "treasury.view" });
  if (can("purchases.view") && counts.purchaseOrders > 0)
    buttons.push({ label: "سفارش‌های خرید", n: counts.purchaseOrders, href: `/purchases?supplierPartyId=${partyId}`, perm: "purchase.view" });
  if (can("tax.view") && counts.purchaseTaxInvoices > 0)
    buttons.push({ label: "فاکتورهای خرید", n: counts.purchaseTaxInvoices, href: `/tax-invoices`, perm: "tax.view" });
  if (can("loadings.view") && counts.loadings > 0)
    buttons.push({ label: "بارگیری‌ها", n: counts.loadings, href: `/loadings`, perm: "loadings.view" });
  if (can("price_request.view") && counts.priceRequests > 0)
    buttons.push({ label: "درخواست قیمت", n: counts.priceRequests, href: `/price-requests`, perm: "price_request.view" });
  if (can("activities.view") && counts.openActivities > 0) {
    buttons.push({
      label: "فعالیت‌های باز",
      n: counts.openActivities,
      href: "#activities",
      perm: "activities.view",
      onClick: onOpenActivities,
    });
  }

  if (buttons.length === 0) return null;

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="شمارنده‌های مرتبط (Smart Buttons)">
      {buttons.map((b) =>
        b.onClick ? (
          <button
            key={b.label}
            type="button"
            onClick={b.onClick}
            className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-center transition-colors hover:border-primary-300 hover:bg-primary-50"
          >
            <span className="block text-sm font-bold text-primary-700">{b.n === null ? "" : faDigits(b.n)}</span>
            <span className="block text-[10px] text-slate-500">{b.label}</span>
          </button>
        ) : (
          <Link
            key={b.label}
            href={b.href}
            className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-center transition-colors hover:border-primary-300 hover:bg-primary-50"
          >
            <span className="block text-sm font-bold text-primary-700">{b.n === null ? "" : faDigits(b.n)}</span>
            <span className="block text-[10px] text-slate-500">{b.label}</span>
          </Link>
        ),
      )}
    </div>
  );
}

export default PartySmartButtons;
