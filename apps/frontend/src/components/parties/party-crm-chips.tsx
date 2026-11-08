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
import Link from "next/link";
import { fetchLeads, fetchOpportunities, type LeadDto, type OpportunityDto } from "@/lib/crm";

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
  const [activeOpps, setActiveOpps] = useState<OpportunityDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Wide slice for the chips; detail lives in the CRM pages.
    Promise.all([
      fetchLeads({ partyId, pageSize: 20 }).catch(() => null),
      fetchOpportunities({ customerPartyId: partyId, pageSize: 50 }).catch(() => null),
    ])
      .then(([leads, opps]) => {
        if (cancelled) return;
        const openLeads = (leads?.items ?? []).filter((l) => l.status !== "LOST");
        setLead(openLeads[0] ?? null);
        setActiveOpps((opps?.items ?? []).filter((o) => o.status !== "WON" && o.status !== "LOST"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [partyId, refreshToken]);

  const isCustomer = roles.some((r) => r.role === "CUSTOMER");
  const chips: React.ReactNode[] = [];

  if (lead) {
    chips.push(
      <Link
        key="lead"
        href={`/crm/leads/${lead.id}`}
        className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-[11px] font-medium text-sky-700 hover:underline"
      >
        سرنخ: {lead.name} ↗
      </Link>,
    );
  }
  if (activeOpps !== null && activeOpps.length > 0) {
    chips.push(
      <span
        key="opps"
        className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700"
      >
        دارای {activeOpps.length === 1 ? "فرصت فروش فعال" : `${activeOpps.length} فرصت فروش فعال`}
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
