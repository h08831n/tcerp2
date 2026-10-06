"use client";

import { useEffect, useState } from "react";
import { faDigits, faMoney } from "@/lib/format";
import {
  fetchFinancialResponsibility,
  partyErrorMessage,
  type FinancialResponsibilityResponse,
  type PartyDetail,
} from "@/lib/party";

interface FinancialTabProps {
  party: PartyDetail;
}

export function FinancialTab({ party }: FinancialTabProps) {
  const [data, setData] = useState<FinancialResponsibilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchFinancialResponsibility(party.id)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(partyErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [party.id, party.version]);

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-400 shadow-sm">
        در حال بارگذاری مسئولیت مالی…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 shadow-sm">
        {error}
      </div>
    );
  }

  if (!data || (!data.group && data.members.length === 0)) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400 shadow-sm">
        این شخص در گروه مسئولیت مالی قرار ندارد.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.group && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800">گروه مسئولیت مالی</h3>
          <p className="mt-2 text-sm text-slate-600">
            مسئول گروه:{" "}
            <span className="font-bold text-primary-700">{data.group.name}</span>
            {data.group.responsiblePartyId === party.id && (
              <span className="ms-2 rounded border border-primary-200 bg-primary-50 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">
                همین رکورد
              </span>
            )}
          </p>
          {data.consolidated !== null && (
            <div className="mt-3 inline-flex flex-col rounded-lg border border-slate-100 bg-slate-50 px-4 py-2">
              <span className="text-[11px] text-slate-400">مانده تلفیقی گروه</span>
              <span
                className={`text-base font-bold ${data.consolidated < 0 ? "text-red-600" : "text-emerald-700"}`}
              >
                {faMoney(data.consolidated)}
              </span>
            </div>
          )}
        </div>
      )}

      {data.members.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold text-slate-700">
            اعضای گروه
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 text-start font-semibold">نام</th>
                <th scope="col" className="px-4 py-2 text-center font-semibold">امتیاز</th>
                <th scope="col" className="px-4 py-2 text-end font-semibold">مانده حساب</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.members.map((member) => (
                <tr
                  key={member.partyId}
                  className={member.partyId === party.id ? "bg-primary-50/50" : ""}
                >
                  <td className="px-4 py-2">
                    <span className="font-medium text-slate-800">{member.nameFa}</span>
                    {member.partyId === party.id && (
                      <span className="ms-2 rounded border border-primary-200 bg-primary-50 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">
                        همین رکورد
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {member.score !== null ? faDigits(member.score) : "—"}
                  </td>
                  <td
                    className={`px-4 py-2 text-end font-bold tabular-nums ${
                      (member.balance ?? 0) < 0 ? "text-red-600" : "text-slate-700"
                    }`}
                  >
                    {faMoney(member.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
