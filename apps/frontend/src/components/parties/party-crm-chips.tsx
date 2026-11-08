"use client";

/**
 * CR-001 §8 — commercial status chips on the Party form:
 *   «سرنخ» / «دارای فرصت فروش فعال» / «مشتری».
 *
 * NOT an exclusive enum: a party can be BOTH a customer AND hold new
 * opportunities; other roles (SUPPLIER…) are never touched. The chips are
 * derived from real state: the party's roles + its leads + opportunities.
 */

import { useEffect, useState } from "react";
import { fetchLeads, type LeadDto } from "@/lib/crm";

interface PartyRoleLite {
  role: string;
}

export interface PartyCrmChipsProps {
  partyId: string;
  roles: PartyRoleLite[];
  /** Bump when sibling tabs mutate CRM state. */
  refreshToken?: number;
}

export function PartyCrmChips({ partyId, roles, refreshToken = 0 }: PartyCrmChipsProps) {
  const [lead, setLead] = useState<LeadDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLeads({ partyId, pageSize: 20 })
      .then((leads) => {
        if (!cancelled) {
          const open = (leads?.items ?? []).find((l) => l.status !== "LOST");
          setLead(open ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [partyId, refreshToken]);

  const isCustomer = roles.some((r) => r.role === "CUSTOMER");
  const isLead = roles.some((r) => r.role === "LEAD");
  const chips: React.ReactNode[] = [];

  // R2: a lead IS this party — the chip stays on the same page (no separate
  // lead identity). History: the LEAD chip shows even after conversion.
  if (isLead || lead) {
    chips.push(
      <span
        key="lead"
        className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-[11px] font-medium text-sky-700"
      >
        {isCustomer ? "سرنخ (پیشینه)" : "سرنخ"}
      </span>,
    );
  }
  if (isCustomer) {
    chips.push(
      <span
        key="customer"
        className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700"
      >
        مشتری
      </span>,
    );
  }

  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" aria-label="وضعیت تجاری">
      {chips}
    </div>
  );
}

export default PartyCrmChips;
