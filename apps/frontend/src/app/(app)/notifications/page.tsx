"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  createSmsTemplate,
  deleteSmsTemplate,
  deleteNotificationRule,
  fetchNotificationRules,
  fetchNotifications,
  fetchSmsMessages,
  fetchSmsTemplates,
  markAllNotificationsRead,
  markNotificationRead,
  resendSms,
  sendSms,
  updateNotificationRule,
  updateSmsTemplate,
  type NotificationDto,
  type NotificationRuleDto,
  type SmsMessageDto,
  type SmsTemplateDto,
} from "@/lib/notifications";

// ───────────────────────── labels ─────────────────────────

const SMS_STATUS_LABELS: Record<SmsMessageDto["status"], string> = {
  QUEUED: "در صف",
  SENT: "ارسال‌شده",
  FAILED: "ناموفق",
};

const SMS_STATUS_BADGES: Record<SmsMessageDto["status"], string> = {
  QUEUED: "bg-amber-100 text-amber-800",
  SENT: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-rose-100 text-rose-800",
};

const SOURCE_LABELS: Record<SmsMessageDto["source"], string> = {
  AUTOMATION: "خودکارسازی",
  NOTIFICATION_RULE: "قاعده اعلان",
  MANUAL: "دستی",
};

const CHANNEL_LABELS: Record<string, string> = {
  IN_APP: "درون‌برنامه",
  SMS: "پیامک",
};

type Tab = "inbox" | "sms" | "rules";

export default function NotificationsPage() {
  const [tab, setTab] = useState<Tab>("inbox");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── inbox ──
  const [inbox, setInbox] = useState<NotificationDto[]>([]);
  const [inboxTotal, setInboxTotal] = useState(0);
  const [inboxPage, setInboxPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [inboxLoading, setInboxLoading] = useState(true);

  // ── SMS log ──
  const [messages, setMessages] = useState<SmsMessageDto[]>([]);
  const [smsTotal, setSmsTotal] = useState(0);
  const [smsPage, setSmsPage] = useState(1);
  const [smsStatus, setSmsStatus] = useState("");
  const [smsLoading, setSmsLoading] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendText, setSendText] = useState("");
  const [sendTemplateCode, setSendTemplateCode] = useState("");
  const [sendVars, setSendVars] = useState("");
  const [sending, setSending] = useState(false);

  // ── templates ──
  const [templates, setTemplates] = useState<SmsTemplateDto[]>([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [tplCode, setTplCode] = useState("");
  const [tplName, setTplName] = useState("");
  const [tplBody, setTplBody] = useState("");
  const [tplSaving, setTplSaving] = useState(false);

  // ── rules ──
  const [rules, setRules] = useState<NotificationRuleDto[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    setInboxLoading(true);
    setError(null);
    try {
      const res = await fetchNotifications({ status: unreadOnly ? "UNREAD" : undefined, page: inboxPage });
      setInbox(res.items);
      setInboxTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInboxLoading(false);
    }
  }, [inboxPage, unreadOnly]);

  const loadSms = useCallback(async () => {
    setSmsLoading(true);
    setError(null);
    try {
      const [log, tpls] = await Promise.all([
        fetchSmsMessages({ status: smsStatus || undefined, page: smsPage }),
        fetchSmsTemplates(),
      ]);
      setMessages(log.items);
      setSmsTotal(log.total);
      setTemplates(tpls);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSmsLoading(false);
    }
  }, [smsPage, smsStatus]);

  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    setError(null);
    try {
      setRules(await fetchNotificationRules());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRulesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "inbox") void loadInbox();
    if (tab === "sms") void loadSms();
    if (tab === "rules") void loadRules();
  }, [tab, loadInbox, loadSms, loadRules]);

  // ── inbox actions ──
  const readOne = async (id: string) => {
    setError(null);
    try {
      await markNotificationRead(id);
      await loadInbox();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const readAll = async () => {
    setError(null);
    try {
      const res = await markAllNotificationsRead();
      setNotice(`${faDigits(res.marked)} اعلان خوانده شد.`);
      await loadInbox();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── SMS actions ──
  const submitSend = async () => {
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const vars = sendVars.trim() ? (JSON.parse(sendVars) as Record<string, unknown>) : undefined;
      const res = await sendSms({
        to: sendTo.trim(),
        ...(sendTemplateCode ? { templateCode: sendTemplateCode } : { text: sendText }),
        ...(vars ? { vars } : {}),
      });
      setSendOpen(false);
      setSendTo("");
      setSendText("");
      setSendVars("");
      setNotice(res.created ? "پیامک در صف ارسال قرار گرفت." : "این پیام قبلاً ثبت شده بود (idempotent).");
      await loadSms();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const resendOne = async (id: string) => {
    setError(null);
    try {
      await resendSms(id);
      setNotice("ارسال مجدد در صف قرار گرفت.");
      await loadSms();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitTemplate = async () => {
    setTplSaving(true);
    setError(null);
    try {
      await createSmsTemplate({ code: tplCode.trim(), nameFa: tplName.trim(), bodyTemplate: tplBody });
      setTemplateOpen(false);
      setTplCode("");
      setTplName("");
      setTplBody("");
      setNotice("قالب ذخیره شد.");
      await loadSms();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTplSaving(false);
    }
  };

  const toggleTemplate = async (t: SmsTemplateDto) => {
    setError(null);
    try {
      await updateSmsTemplate(t.id, { isActive: !t.isActive });
      await loadSms();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeTemplate = async (t: SmsTemplateDto) => {
    setError(null);
    try {
      await deleteSmsTemplate(t.id);
      await loadSms();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── rule actions ──
  const toggleRule = async (rule: NotificationRuleDto) => {
    setTogglingId(rule.id);
    setError(null);
    try {
      await updateNotificationRule(rule.id, { enabled: !rule.enabled });
      await loadRules();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingId(null);
    }
  };

  const removeRule = async (rule: NotificationRuleDto) => {
    setError(null);
    try {
      await deleteNotificationRule(rule.id);
      await loadRules();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── table columns ──
  const inboxColumns: DataTableColumn<NotificationDto>[] = [
    {
      key: "title",
      header: "عنوان",
      render: (n) => (
        <div>
          <p className={`text-sm ${n.status === "UNREAD" ? "font-bold text-slate-900" : "text-slate-700"}`}>{n.title}</p>
          {n.body && <p className="mt-0.5 text-xs text-slate-500">{n.body}</p>}
        </div>
      ),
    },
    {
      key: "createdAt",
      header: "زمان",
      render: (n) => <span className="text-xs tabular-nums text-slate-600">{jalaliDateTime(n.createdAt)}</span>,
    },
    {
      key: "priority",
      header: "اولویت",
      align: "center",
      render: (n) =>
        n.priority === "HIGH" || n.priority === "CRITICAL" ? (
          <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-700">فوری</span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: "status",
      header: "وضعیت",
      align: "center",
      render: (n) =>
        n.status === "UNREAD" ? (
          <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800">خوانده‌نشده</span>
        ) : (
          <span className="text-xs text-slate-400">خوانده‌شده</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "center",
      render: (n) =>
        n.status === "UNREAD" ? (
          <Button size="sm" variant="ghost" onClick={() => void readOne(n.id)}>
            خواندم
          </Button>
        ) : null,
    },
  ];

  const smsColumns: DataTableColumn<SmsMessageDto>[] = [
    { key: "to", header: "شماره", render: (m) => <span dir="ltr" className="font-mono text-xs">{m.to}</span> },
    { key: "text", header: "متن", render: (m) => <span className="text-xs text-slate-700">{m.text}</span> },
    {
      key: "source",
      header: "مبدأ",
      render: (m) => <span className="text-xs text-slate-600">{SOURCE_LABELS[m.source]}</span>,
    },
    {
      key: "createdAt",
      header: "زمان",
      render: (m) => <span className="text-xs tabular-nums text-slate-600">{jalaliDateTime(m.createdAt)}</span>,
    },
    {
      key: "status",
      header: "وضعیت",
      align: "center",
      render: (m) => (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${SMS_STATUS_BADGES[m.status]}`}>
          {SMS_STATUS_LABELS[m.status]}
        </span>
      ),
    },
    {
      key: "error",
      header: "خطا",
      render: (m) =>
        m.error ? (
          <span dir="ltr" className="block max-w-40 truncate font-mono text-[10px] text-rose-600" title={m.error}>
            {m.error}
          </span>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "center",
      render: (m) =>
        m.status === "FAILED" ? (
          <Button size="sm" variant="ghost" onClick={() => void resendOne(m.id)}>
            ارسال مجدد
          </Button>
        ) : null,
    },
  ];

  const ruleColumns: DataTableColumn<NotificationRuleDto>[] = [
    { key: "event", header: "رویداد", render: (r) => <span dir="ltr" className="font-mono text-xs">{r.event}</span> },
    { key: "code", header: "کد", render: (r) => <span className="text-xs">{r.code}</span> },
    {
      key: "channels",
      header: "کانال‌ها",
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {(Array.isArray(r.channels) ? r.channels : []).map((c) => (
            <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-700">
              {CHANNEL_LABELS[c] ?? c}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: "delay",
      header: "تأخیر",
      align: "center",
      render: (r) =>
        r.delayConfig?.delayMinutes ? (
          <span className="text-xs tabular-nums">{faDigits(r.delayConfig.delayMinutes)} دقیقه</span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: "enabled",
      header: "وضعیت",
      align: "center",
      render: (r) =>
        r.enabled ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">فعال</span>
        ) : (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">غیرفعال</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "center",
      render: (r) => (
        <div className="flex justify-center gap-1">
          <Button size="sm" variant="ghost" disabled={togglingId === r.id} onClick={() => void toggleRule(r)}>
            {r.enabled ? "غیرفعال" : "فعال"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void removeRule(r)}>
            حذف
          </Button>
        </div>
      ),
    },
  ];

  const inboxPages = Math.max(1, Math.ceil(inboxTotal / 20));
  const smsPages = Math.max(1, Math.ceil(smsTotal / 20));

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "inbox", label: `اعلان‌ها${inboxTotal ? ` (${faDigits(inboxTotal)})` : ""}` },
    { key: "sms", label: "پیامک‌ها" },
    { key: "rules", label: "قواعد اعلان" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-800">مرکز اعلان‌ها</h1>
        {tab === "inbox" && (
          <Button variant="secondary" size="sm" onClick={() => void readAll()}>
            خواندن همه
          </Button>
        )}
        {tab === "sms" && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setTemplateOpen(true)}>
              قالب جدید
            </Button>
            <Button size="sm" onClick={() => setSendOpen(true)}>
              ارسال پیامک
            </Button>
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-t-md px-3 py-1.5 text-sm ${
              tab === t.key ? "border-b-2 border-primary-600 font-bold text-primary-700" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      {tab === "inbox" && (
        <div className="space-y-3">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => { setInboxPage(1); setUnreadOnly(e.target.checked); }} className="h-4 w-4 accent-primary-600" />
            فقط خوانده‌نشده‌ها
          </label>
          <DataTable columns={inboxColumns} rows={inbox} rowKey={(n) => n.id} loading={inboxLoading} emptyMessage="اعلانی وجود ندارد" />
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              مجموع {faDigits(inboxTotal)} — صفحه {faDigits(inboxPage)} از {faDigits(inboxPages)}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={inboxPage <= 1} onClick={() => setInboxPage((p) => p - 1)}>
                قبلی
              </Button>
              <Button variant="ghost" size="sm" disabled={inboxPage >= inboxPages} onClick={() => setInboxPage((p) => p + 1)}>
                بعدی
              </Button>
            </div>
          </div>
        </div>
      )}

      {tab === "sms" && (
        <div className="space-y-5">
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={smsStatus}
                onChange={(e) => {
                  setSmsPage(1);
                  setSmsStatus(e.target.value);
                }}
              >
                <option value="">همه وضعیت‌ها</option>
                {Object.entries(SMS_STATUS_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <DataTable columns={smsColumns} rows={messages} rowKey={(m) => m.id} loading={smsLoading} emptyMessage="پیامکی ثبت نشده است" />
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>
                مجموع {faDigits(smsTotal)} — صفحه {faDigits(smsPage)} از {faDigits(smsPages)}
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={smsPage <= 1} onClick={() => setSmsPage((p) => p - 1)}>
                  قبلی
                </Button>
                <Button variant="ghost" size="sm" disabled={smsPage >= smsPages} onClick={() => setSmsPage((p) => p + 1)}>
                  بعدی
                </Button>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-bold text-slate-700">قالب‌های پیامک</h2>
            <div className="grid gap-2 md:grid-cols-2">
              {templates.length === 0 && <p className="text-xs text-slate-500">قالبی ثبت نشده است.</p>}
              {templates.map((t) => (
                <div key={t.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-800">{t.nameFa}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${t.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                      {t.isActive ? "فعال" : "غیرفعال"}
                    </span>
                  </div>
                  <p dir="ltr" className="mt-1 font-mono text-[10px] text-slate-400">{t.code}</p>
                  <p className="mt-1 text-xs text-slate-600">{t.bodyTemplate}</p>
                  <div className="mt-2 flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void toggleTemplate(t)}>
                      {t.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void removeTemplate(t)}>
                      حذف
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "rules" && (
        <DataTable columns={ruleColumns} rows={rules} rowKey={(r) => r.id} loading={rulesLoading} emptyMessage="قاعده‌ای ثبت نشده است" />
      )}

      {/* send SMS modal */}
      <Modal open={sendOpen} title="ارسال پیامک" onClose={() => setSendOpen(false)} small>
        <div className="space-y-3">
          <label className="block text-xs text-slate-600">
            شماره موبایل
            <Input value={sendTo} onChange={(e) => setSendTo(e.target.value)} dir="ltr" placeholder="09121234567" />
          </label>
          <label className="block text-xs text-slate-600">
            قالب (اختیاری)
            <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={sendTemplateCode} onChange={(e) => setSendTemplateCode(e.target.value)}>
              <option value="">— متن آزاد —</option>
              {templates.filter((t) => t.isActive).map((t) => (
                <option key={t.id} value={t.code}>
                  {t.nameFa}
                </option>
              ))}
            </select>
          </label>
          {!sendTemplateCode && (
            <label className="block text-xs text-slate-600">
              متن پیام
              <textarea className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" rows={3} value={sendText} onChange={(e) => setSendText(e.target.value)} />
            </label>
          )}
          {sendTemplateCode && (
            <label className="block text-xs text-slate-600">
              متغیرها (JSON)
              <Input value={sendVars} onChange={(e) => setSendVars(e.target.value)} dir="ltr" placeholder='{"partyName": "شرکت فولاد"}' />
            </label>
          )}
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setSendOpen(false)}>
              انصراف
            </Button>
            <Button size="sm" disabled={sending || !sendTo.trim() || (!sendTemplateCode && !sendText.trim())} onClick={() => void submitSend()}>
              {sending ? "…" : "ثبت در صف ارسال"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* new template modal */}
      <Modal open={templateOpen} title="قالب پیامک جدید" onClose={() => setTemplateOpen(false)} small>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              کد
              <Input value={tplCode} onChange={(e) => setTplCode(e.target.value)} dir="ltr" placeholder="WELCOME" />
            </label>
            <label className="text-xs text-slate-600">
              نام
              <Input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="خوش‌آمد" />
            </label>
          </div>
          <label className="block text-xs text-slate-600">
            متن قالب (متغیرها با آکولاد: {"{partyName}"})
            <textarea className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" rows={3} value={tplBody} onChange={(e) => setTplBody(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setTemplateOpen(false)}>
              انصراف
            </Button>
            <Button size="sm" disabled={tplSaving || !tplCode.trim() || !tplName.trim() || !tplBody.trim()} onClick={() => void submitTemplate()}>
              {tplSaving ? "…" : "ذخیره قالب"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
