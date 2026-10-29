"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { faDigits, jalali, jalaliMonthLength, toGregorian, toJalali } from "@/lib/format";
import {
  ACTIVITY_PRIORITY_CLASSES,
  ACTIVITY_PRIORITY_LABELS,
  activityErrorMessage,
  createActivity,
  fetchActivityTypes,
  fetchCalendarRange,
  type ActivityRow,
  type CalendarLayerEvent,
} from "@/lib/activities";

const JALALI_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];

const WEEK_DAYS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

/** تقویم مرکزی (REQUIREMENTS §56) — نمای ماه جلالی با لایه‌های قابل
 *  خاموش/روشن، ایجاد فعالیت از تقویم و کلیک روی رویداد برای ویرایش.
 *  تاریخ‌ها در Backend به‌صورت UTC instant ذخیره می‌شوند؛ نمایش جلالی
 *  صرفاً لایه نمایش است و تاریخ واقعی را تغییر نمی‌دهد. */
export default function CalendarPage() {
  const today = new Date();
  const [todayJ] = useState(() => toJalali(today.getFullYear(), today.getMonth() + 1, today.getDate()));
  const [viewJy, setViewJy] = useState(todayJ[0]);
  const [viewJm, setViewJm] = useState(todayJ[1]);
  const [selectedDay, setSelectedDay] = useState<number | null>(todayJ[2]);
  const [layerFilters, setLayerFilters] = useState<Record<string, boolean>>({
    activities: true,
    checks: true,
    payments: true,
    approvals: true,
  });
  const [events, setEvents] = useState<CalendarLayerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // create-from-calendar dialog
  const [calendarTypeCode, setCalendarTypeCode] = useState("GENERAL");
  const [createDay, setCreateDay] = useState<number | null>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [createEntityType, setCreateEntityType] = useState("party");
  const [createEntityId, setCreateEntityId] = useState("");
  const [creating, setCreating] = useState(false);

  // edit dialog
  const [editActivity, setEditActivity] = useState<ActivityRow | null>(null);

  const monthLength = jalaliMonthLength(viewJy, viewJm);
  const [gStartYear, gStartMonth, gStartDay] = toGregorian(viewJy, viewJm, 1);
  const monthStart = useMemo(
    () => new Date(Date.UTC(gStartYear, gStartMonth - 1, gStartDay, 0, 0, 0)),
    [gStartYear, gStartMonth, gStartDay],
  );
  const [gEndYear, gEndMonth, gEndDay] = toGregorian(viewJy, viewJm, monthLength);
  const monthEnd = useMemo(
    () => new Date(Date.UTC(gEndYear, gEndMonth - 1, gEndDay, 23, 59, 59)),
    [gEndYear, gEndMonth, gEndDay],
  );
  // first weekday of the month (Saturday-first grid, Iran convention)
  const startWeekday = (monthStart.getUTCDay() + 1) % 7;

  const loadRange = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const from = monthStart.toISOString();
      const to = monthEnd.toISOString();
      const layers = Object.entries(layerFilters)
        .filter(([, on]) => on)
        .map(([k]) => k);
      const result = await fetchCalendarRange({ from, to, layers });
      const merged: CalendarLayerEvent[] = [];
      for (const [kind, items] of Object.entries(result.layers)) {
        for (const raw of items as unknown as Record<string, unknown>[]) {
          if (kind === "activities") {
            merged.push({
              id: String(raw.id),
              kind: "activity",
              title: String(raw.title),
              date: String(raw.dueDate ?? raw.scheduledDate ?? ""),
              status: String(raw.status),
              entityId: String(raw.relatedEntityId),
              entityType: String(raw.relatedEntityType),
              extra: { priority: raw.priority, overdue: raw.overdue, type: raw.type },
            });
          } else if (kind === "checks") {
            merged.push({
              id: String(raw.id),
              kind: "check",
              title: `چک ${String(raw.checkNumber)}`,
              date: String(raw.dueDate),
              status: String(raw.status),
              entityId: String(raw.id),
              entityType: "check",
              extra: { amount: raw.amount, direction: raw.direction },
            });
          } else if (kind === "payments") {
            merged.push({
              id: String(raw.id),
              kind: "payment",
              title: `پرداخت ${String(raw.paymentNumber)}`,
              date: String(raw.paymentDate),
              status: "—",
              entityId: String(raw.id),
              entityType: "payment",
              extra: { amount: raw.amount },
            });
          } else if (kind === "approvals") {
            merged.push({
              id: String(raw.id),
              kind: "approval",
              title: `درخواست تأیید ${String(raw.approvalType)}`,
              date: String(raw.createdAt),
              status: "PENDING",
              entityId: String(raw.entityId),
              entityType: String(raw.entityType),
              extra: {},
            });
          }
        }
      }
      setEvents(merged);
    } catch (e) {
      setError(activityErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [monthStart, monthEnd, layerFilters]);

  useEffect(() => {
    void loadRange();
  }, [loadRange]);

  useEffect(() => {
    fetchActivityTypes()
      .then((t) => setCalendarTypeCode(t[0]?.code ?? "GENERAL"))
      .catch(() => undefined);
  }, []);

  const eventsForDay = useCallback(
    (day: number) => {
      const [gy, gm, gd] = toGregorian(viewJy, viewJm, day);
      const dayIso = `${gy}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
      return events.filter((e) => e.date.slice(0, 10) === dayIso);
    },
    [events, viewJy, viewJm],
  );

  const selectedEvents = useMemo(() => {
    if (selectedDay === null) return [];
    return eventsForDay(selectedDay);
  }, [selectedDay, eventsForDay]);

  function shiftMonth(delta: number) {
    let jm = viewJm + delta;
    let jy = viewJy;
    if (jm > 12) {
      jm = 1;
      jy += 1;
    }
    if (jm < 1) {
      jm = 12;
      jy -= 1;
    }
    setViewJy(jy);
    setViewJm(jm);
    setSelectedDay(null);
  }

  async function handleCreateFromCalendar() {
    if (createDay === null || !createTitle.trim() || !createEntityId.trim()) return;
    const [gy, gm, gd] = toGregorian(viewJy, viewJm, createDay);
    setCreating(true);
    setError(null);
    try {
      await createActivity({
        typeCode: calendarTypeCode,
        title: createTitle.trim(),
        relatedEntityType: createEntityType,
        relatedEntityId: createEntityId.trim(),
        dueDate: new Date(Date.UTC(gy, gm - 1, gd, 9, 0, 0)).toISOString(),
      });
      setCreateDay(null);
      setCreateTitle("");
      setCreateEntityId("");
      setNotice(`فعالیت برای ${faDigits(createDay)} ${JALALI_MONTHS[viewJm - 1]} ساخته شد.`);
      await loadRange();
    } catch (e) {
      setError(activityErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  const cells: (number | null)[] = [
    ...Array.from({ length: startWeekday }, () => null),
    ...Array.from({ length: monthLength }, (_, i) => i + 1),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">تقویم مرکزی</h1>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => shiftMonth(-1)}>
            ماه قبل
          </Button>
          <span className="text-lg font-semibold">
            {JALALI_MONTHS[viewJm - 1]} {faDigits(viewJy)}
          </span>
          <Button variant="secondary" onClick={() => shiftMonth(1)}>
            ماه بعد
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setViewJy(todayJ[0]);
              setViewJm(todayJ[1]);
              setSelectedDay(todayJ[2]);
            }}
          >
            امروز
          </Button>
        </div>
      </div>

      {/* layer toggles */}
      <div className="flex flex-wrap gap-3 text-sm">
        {[
          ["activities", "فعالیت‌ها"],
          ["checks", "چک‌ها"],
          ["payments", "پرداخت‌ها"],
          ["approvals", "مهلت تأییدها"],
        ].map(([key, label]) => (
          <label key={key} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!!layerFilters[key]}
              onChange={(e) => setLayerFilters((f) => ({ ...f, [key]: e.target.checked }))}
            />
            {label}
          </label>
        ))}
      </div>

      {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-700">{notice}</div>}

      {/* month grid */}
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {WEEK_DAYS.map((d) => (
          <div key={d} className="rounded bg-slate-100 py-1 font-medium text-slate-600">
            {d}
          </div>
        ))}
        {cells.map((day, idx) => (
          <div
            key={idx}
            className={`min-h-24 rounded border p-1 text-right ${
              day === selectedDay ? "border-blue-400 bg-blue-50" : "border-slate-200"
            } ${day === null ? "bg-slate-50" : "bg-white"}`}
          >
            {day !== null && (
              <div
                className="cursor-pointer"
                onClick={() => {
                  setSelectedDay(day);
                  setCreateDay(day);
                }}
              >
                <div className={`text-xs ${day === todayJ[2] && viewJm === todayJ[1] && viewJy === todayJ[0] ? "font-bold text-blue-700" : ""}`}>
                  {faDigits(day)}
                </div>
                <div className="mt-1 space-y-0.5">
                  {eventsForDay(day).slice(0, 3).map((e) => (
                    <div
                      key={e.kind + e.id}
                      className={`truncate rounded px-1 py-0.5 text-[10px] ${
                        e.kind === "activity"
                          ? "bg-blue-100 text-blue-800"
                          : e.kind === "check"
                            ? "bg-purple-100 text-purple-800"
                            : e.kind === "payment"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-orange-100 text-orange-800"
                      }`}
                    >
                      {e.title}
                    </div>
                  ))}
                  {eventsForDay(day).length > 3 && (
                    <div className="text-[10px] text-slate-400">+{faDigits(eventsForDay(day).length - 3)}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* agenda for the selected day */}
      <div className="rounded-lg border border-slate-200 p-3">
        <h2 className="mb-2 text-sm font-semibold">
          {selectedDay === null ? "رویدادها" : `${faDigits(selectedDay)} ${JALALI_MONTHS[viewJm - 1]}`}
        </h2>
        {loading && <div className="text-sm text-slate-500">در حال بارگذاری…</div>}
        {!loading && selectedEvents.length === 0 && (
          <div className="text-sm text-slate-400">رویدادی برای این روز ثبت نشده است.</div>
        )}
        <ul className="space-y-2">
          {selectedEvents.map((e) => (
            <li key={e.kind + e.id} className="flex items-center justify-between rounded border border-slate-200 p-2 text-sm">
              <div>
                <div className="font-medium">{e.title}</div>
                <div className="text-xs text-slate-500">
                  {e.kind === "activity" && e.extra.priority ? ACTIVITY_PRIORITY_LABELS[e.extra.priority as never] : ""}{" "}
                  {e.status}
                </div>
              </div>
              {e.kind === "activity" && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const row = e as unknown as ActivityRow;
                    setEditActivity({
                      id: row.id,
                      title: e.title,
                      description: null,
                      relatedEntityType: e.entityType ?? "unknown",
                      relatedEntityId: e.entityId,
                      assignedTo: null,
                      priority: (e.extra.priority as never) ?? "NORMAL",
                      scheduledDate: null,
                      dueDate: e.date,
                      status: e.status as never,
                      completedAt: null,
                      overdue: false,
                      type: { code: "", nameFa: "", color: null },
                    });
                  }}
                >
                  ویرایش
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* create-from-calendar dialog */}
      <Modal open={createDay !== null} onClose={() => setCreateDay(null)} title={`فعالیت جدید — ${faDigits(createDay ?? 0)} ${JALALI_MONTHS[viewJm - 1]}`}>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">عنوان</label>
            <Input value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs text-slate-500">نوع موجودیت</label>
              <select
                value={createEntityType}
                onChange={(e) => setCreateEntityType(e.target.value)}
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
              >
                <option value="party">طرف حساب</option>
                <option value="price_request">درخواست قیمت</option>
                <option value="sales_document">سند فروش</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">شناسه موجودیت (UUID)</label>
              <Input value={createEntityId} onChange={(e) => setCreateEntityId(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateDay(null)}>
              انصراف
            </Button>
            <Button disabled={creating} onClick={() => void handleCreateFromCalendar()}>
              {creating ? "در حال ثبت…" : "ثبت فعالیت"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* edit-activity dialog */}
      <Modal open={!!editActivity} onClose={() => setEditActivity(null)} title="ویرایش فعالیت">
        <div className="text-sm text-slate-600">
          ویرایش از تقویم: {editActivity?.title}
          {editActivity && (
            <div className="mt-2 rounded border border-slate-200 p-2 text-xs">
              وضعیت: {editActivity.status} • موعد: {editActivity.dueDate ? jalali(editActivity.dueDate) : "—"}
            </div>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" onClick={() => setEditActivity(null)}>
            بستن
          </Button>
        </div>
      </Modal>
    </div>
  );
}
