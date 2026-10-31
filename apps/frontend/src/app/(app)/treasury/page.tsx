"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { faDigits, jalali, jalaliDateTime } from "@/lib/format";
import {
  checkTransition,
  createBankAccount,
  createPayment,
  createReceipt,
  createTransfer,
  fetchBankAccounts,
  fetchBankStatement,
  fetchChecks,
  registerCheck,
  type BankAccountDto,
  type BankStatementRow,
  type CheckDto,
} from "@/lib/treasury";

function money(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return faDigits(new Intl.NumberFormat("fa-IR").format(Math.round(Number(value)))) + " ریال";
}

type Tab = "accounts" | "checks" | "ops";

const CHECK_STATUS_LABELS: Record<CheckDto["status"], string> = {
  REGISTERED: "ثبت‌شده",
  PENDING: "در جریان",
  DEPOSITED: "واریز شده",
  CLEARED: "وصول شده",
  PAID: "پرداخت شده",
  BOUNCED: "برگشتی",
  CANCELLED: "لغو شده",
};

const CHECK_STATUS_BADGES: Record<CheckDto["status"], string> = {
  REGISTERED: "bg-slate-100 text-slate-700",
  PENDING: "bg-amber-100 text-amber-800",
  DEPOSITED: "bg-sky-100 text-sky-800",
  CLEARED: "bg-emerald-100 text-emerald-800",
  PAID: "bg-emerald-100 text-emerald-800",
  BOUNCED: "bg-rose-100 text-rose-800",
  CANCELLED: "bg-slate-100 text-slate-500",
};

export default function TreasuryPage() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<BankAccountDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [checks, setChecks] = useState<CheckDto[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);
  const [checkStatus, setCheckStatus] = useState("");
  const [checkDirection, setCheckDirection] = useState("");

  const [statement, setStatement] = useState<BankStatementRow[] | null>(null);
  const [statementAccount, setStatementAccount] = useState<BankAccountDto | null>(null);

  // create modals
  const [accountOpen, setAccountOpen] = useState(false);
  const [accName, setAccName] = useState("");
  const [accBank, setAccBank] = useState("");
  const [accNumber, setAccNumber] = useState("");
  const [accIban, setAccIban] = useState("");
  const [savingAccount, setSavingAccount] = useState(false);

  const [opsOpen, setOpsOpen] = useState<null | "receipt" | "payment" | "transfer">(null);
  const [opsAccount, setOpsAccount] = useState("");
  const [opsAccount2, setOpsAccount2] = useState("");
  const [opsAmount, setOpsAmount] = useState("");
  const [opsDesc, setOpsDesc] = useState("");
  const [opsDate, setOpsDate] = useState("");
  const [opsFee, setOpsFee] = useState("");
  const [savingOps, setSavingOps] = useState(false);

  const [checkOpen, setCheckOpen] = useState<null | "INCOMING" | "OUTGOING">(null);
  const [chkNumber, setChkNumber] = useState("");
  const [chkAmount, setChkAmount] = useState("");
  const [chkDue, setChkDue] = useState("");
  const [chkIssue, setChkIssue] = useState("");
  const [chkBank, setChkBank] = useState("");
  const [chkDesc, setChkDesc] = useState("");
  const [savingCheck, setSavingCheck] = useState(false);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAccounts(await fetchBankAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChecks = useCallback(async () => {
    setChecksLoading(true);
    setError(null);
    try {
      setChecks(
        await fetchChecks({
          status: checkStatus || undefined,
          direction: checkDirection || undefined,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecksLoading(false);
    }
  }, [checkStatus, checkDirection]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    if (tab === "checks") void loadChecks();
  }, [tab, loadChecks]);

  const openStatement = async (account: BankAccountDto) => {
    setError(null);
    try {
      setStatementAccount(account);
      setStatement(await fetchBankStatement(account.id));
      setTab("accounts");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitAccount = async () => {
    setSavingAccount(true);
    setError(null);
    try {
      await createBankAccount({
        name: accName.trim(),
        bankName: accBank.trim(),
        ...(accNumber.trim() ? { accountNumber: accNumber.trim() } : {}),
        ...(accIban.trim() ? { iban: accIban.trim() } : {}),
      });
      setAccountOpen(false);
      setAccName("");
      setAccBank("");
      setAccNumber("");
      setAccIban("");
      setNotice("حساب بانکی ایجاد شد.");
      await loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingAccount(false);
    }
  };

  const submitOps = async () => {
    if (!opsOpen) return;
    setSavingOps(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        bankAccountId: opsOpen === "transfer" ? opsAccount : opsAccount,
        ...(opsOpen === "transfer" ? { destinationBankAccountId: opsAccount2 } : {}),
        amount: Number(opsAmount),
        ...(opsDate ? { date: opsDate } : {}),
        ...(opsOpen === "transfer" && opsFee ? { fee: Number(opsFee) } : {}),
        ...(opsDesc.trim() ? { description: opsDesc.trim() } : {}),
      };
      if (opsOpen === "receipt") await createReceipt(body);
      else if (opsOpen === "payment") await createPayment(body);
      else await createTransfer(body as never);
      setOpsOpen(null);
      setOpsAmount("");
      setOpsDesc("");
      setOpsDate("");
      setOpsFee("");
      setNotice("عملیات خزانه ثبت و سند حسابداری صادر شد.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingOps(false);
    }
  };

  const submitCheck = async () => {
    if (!checkOpen) return;
    setSavingCheck(true);
    setError(null);
    setNotice(null);
    try {
      await registerCheck(
        checkOpen,
        {
          checkNumber: chkNumber.trim(),
          amount: Number(chkAmount),
          dueDate: chkDue,
          ...(chkIssue ? { issueDate: chkIssue } : {}),
          ...(chkBank.trim() ? { bankName: chkBank.trim() } : {}),
          ...(chkDesc.trim() ? { description: chkDesc.trim() } : {}),
        },
      );
      setCheckOpen(null);
      setChkNumber("");
      setChkAmount("");
      setChkDue("");
      setChkIssue("");
      setChkBank("");
      setChkDesc("");
      setNotice("چک ثبت شد.");
      await loadChecks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingCheck(false);
    }
  };

  const transition = async (c: CheckDto, action: "pending" | "deposit" | "clear" | "pay" | "bounce" | "cancel") => {
    setError(null);
    try {
      await checkTransition(c.id, action, c.status === "DEPOSITED" || c.status === "BOUNCED" ? undefined : undefined);
      setNotice("وضعیت چک تغییر کرد.");
      await loadChecks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const accountColumns: DataTableColumn<BankAccountDto>[] = [
    { key: "name", header: "نام حساب", render: (r) => <span className="text-sm font-medium">{r.name}</span> },
    { key: "bank", header: "بانک", render: (r) => <span className="text-sm">{r.bankName}</span> },
    { key: "number", header: "شماره حساب", render: (r) => <span dir="ltr" className="font-mono text-xs">{r.accountNumber ?? "—"}</span> },
    { key: "iban", header: "شبا", render: (r) => <span dir="ltr" className="font-mono text-[10px]">{r.iban ?? "—"}</span> },
    {
      key: "active",
      header: "وضعیت",
      align: "center",
      render: (r) =>
        r.isActive ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">فعال</span>
        ) : (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">غیرفعال</span>
        ),
    },
    {
      key: "statement",
      header: "صورت‌حساب",
      align: "center",
      render: (r) => (
        <Button size="sm" variant="ghost" onClick={() => void openStatement(r)}>
          صورت‌حساب
        </Button>
      ),
    },
  ];

  const checkColumns: DataTableColumn<CheckDto>[] = [
    { key: "number", header: "شماره چک", render: (c) => <span dir="ltr" className="font-mono text-xs">{c.checkNumber}</span> },
    { key: "amount", header: "مبلغ", render: (c) => <span className="text-xs tabular-nums">{money(c.amount)}</span> },
    {
      key: "dir",
      header: "نوع",
      align: "center",
      render: (c) => (
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${c.direction === "INCOMING" ? "bg-sky-50 text-sky-700" : "bg-orange-50 text-orange-700"}`}>
          {c.direction === "INCOMING" ? "دریافتی" : "پرداختی"}
        </span>
      ),
    },
    { key: "due", header: "سررسید", render: (c) => <span className="text-xs tabular-nums text-slate-600">{jalali(c.dueDate)}</span> },
    {
      key: "status",
      header: "وضعیت",
      align: "center",
      render: (c) => (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${CHECK_STATUS_BADGES[c.status]}`}>
          {CHECK_STATUS_LABELS[c.status]}
        </span>
      ),
    },
    {
      key: "actions",
      header: "اقدام",
      align: "center",
      render: (c) => {
        const actions: Array<[string, "pending" | "deposit" | "clear" | "pay" | "bounce" | "cancel"]> = [];
        if (c.direction === "INCOMING") {
          if (c.status === "REGISTERED") actions.push(["واریز به بانک", "deposit"]);
          if (c.status === "DEPOSITED" || c.status === "PENDING") actions.push(["وصول", "clear"]);
          if (c.status === "DEPOSITED") actions.push(["برگشت", "bounce"]);
        } else {
          if (c.status === "REGISTERED") actions.push(["آماده پرداخت", "pending"]);
          if (c.status === "PENDING") actions.push(["پرداخت", "pay"]);
        }
        if (c.status === "REGISTERED" || c.status === "PENDING") actions.push(["لغو", "cancel"]);
        if (actions.length === 0) return <span className="text-xs text-slate-300">—</span>;
        return (
          <div className="flex flex-wrap justify-center gap-1">
            {actions.map(([label, action]) => (
              <Button key={action + label} size="sm" variant="ghost" onClick={() => void transition(c, action)}>
                {label}
              </Button>
            ))}
          </div>
        );
      },
    },
  ];

  const statementColumns: DataTableColumn<BankStatementRow>[] = useMemo(
    () => [
      { key: "date", header: "تاریخ", render: (r) => <span className="text-xs tabular-nums">{jalaliDateTime(String(r.date))}</span> },
      { key: "desc", header: "شرح", render: (r) => <span className="text-xs">{r.description ?? "—"}</span> },
      { key: "debit", header: "بدهکار", align: "center", render: (r) => <span className="text-xs tabular-nums">{r.debit != null ? money(r.debit) : "—"}</span> },
      { key: "credit", header: "بستانکار", align: "center", render: (r) => <span className="text-xs tabular-nums">{r.credit != null ? money(r.credit) : "—"}</span> },
      { key: "balance", header: "مانده", align: "center", render: (r) => <span className="text-xs tabular-nums font-bold">{r.balance != null ? money(r.balance) : "—"}</span> },
    ],
    [],
  );

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "accounts", label: "حساب‌های بانکی" },
    { key: "checks", label: "چک‌ها" },
    { key: "ops", label: "دریافت و پرداخت" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-800">خزانه</h1>
        <div className="flex gap-2">
          {tab === "accounts" && (
            <Button size="sm" onClick={() => setAccountOpen(true)}>
              حساب بانکی جدید
            </Button>
          )}
          {tab === "checks" && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setCheckOpen("INCOMING")}>
                ثبت چک دریافتی
              </Button>
              <Button size="sm" onClick={() => setCheckOpen("OUTGOING")}>
                ثبت چک پرداختی
              </Button>
            </>
          )}
          {tab === "ops" && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setOpsOpen("receipt")}>
                دریافت وجه
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setOpsOpen("payment")}>
                پرداخت وجه
              </Button>
              <Button size="sm" onClick={() => setOpsOpen("transfer")}>
                انتقال بین بانک‌ها
              </Button>
            </>
          )}
        </div>
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

      {tab === "accounts" && statement === null && (
        <DataTable columns={accountColumns} rows={accounts} rowKey={(r) => r.id} loading={loading} emptyMessage="حساب بانکی ثبت نشده است" />
      )}

      {tab === "accounts" && statement !== null && statementAccount && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-700">صورت‌حساب — {statementAccount.name}</h2>
            <Button size="sm" variant="ghost" onClick={() => { setStatement(null); setStatementAccount(null); }}>
              بازگشت
            </Button>
          </div>
          <DataTable columns={statementColumns} rows={statement} rowKey={(r) => String(r.id)} emptyMessage="گردشی ثبت نشده است" />
        </div>
      )}

      {tab === "checks" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={checkStatus} onChange={(e) => setCheckStatus(e.target.value)}>
              <option value="">همه وضعیت‌ها</option>
              {Object.entries(CHECK_STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <select className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={checkDirection} onChange={(e) => setCheckDirection(e.target.value)}>
              <option value="">هر دو نوع</option>
              <option value="INCOMING">دریافتی</option>
              <option value="OUTGOING">پرداختی</option>
            </select>
          </div>
          <DataTable columns={checkColumns} rows={checks} rowKey={(c) => c.id} loading={checksLoading} emptyMessage="چکی ثبت نشده است" />
        </div>
      )}

      {tab === "ops" && (
        <div className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-600">
          دریافت/پرداخت وجه و انتقال بین بانک‌ها از دکمه‌های بالا ثبت می‌شود — هر عملیات
          سند حسابداری متوازن خود را تولید می‌کند و در Audit ثبت می‌شود.
          چک‌ها از تب «چک‌ها» مدیریت می‌شوند.
        </div>
      )}

      {/* bank account modal */}
      <Modal open={accountOpen} title="حساب بانکی جدید" onClose={() => setAccountOpen(false)} small>
        <div className="space-y-3">
          <label className="block text-xs text-slate-600">
            نام حساب
            <Input value={accName} onChange={(e) => setAccName(e.target.value)} placeholder="حساب جاری اصلی" />
          </label>
          <label className="block text-xs text-slate-600">
            نام بانک
            <Input value={accBank} onChange={(e) => setAccBank(e.target.value)} placeholder="ملت" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              شماره حساب
              <Input value={accNumber} onChange={(e) => setAccNumber(e.target.value)} dir="ltr" />
            </label>
            <label className="text-xs text-slate-600">
              شبا (بدون IR)
              <Input value={accIban} onChange={(e) => setAccIban(e.target.value)} dir="ltr" />
            </label>
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setAccountOpen(false)}>انصراف</Button>
            <Button size="sm" disabled={savingAccount || !accName.trim() || !accBank.trim()} onClick={() => void submitAccount()}>
              {savingAccount ? "…" : "ایجاد"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* receipt/payment/transfer modal */}
      <Modal
        open={opsOpen !== null}
        title={opsOpen === "receipt" ? "دریافت وجه" : opsOpen === "payment" ? "پرداخت وجه" : "انتقال بین بانک‌ها"}
        onClose={() => setOpsOpen(null)}
        small
      >
        <div className="space-y-3">
          {opsOpen === "transfer" ? (
            <>
              <label className="block text-xs text-slate-600">
                از حساب
                <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={opsAccount} onChange={(e) => setOpsAccount(e.target.value)}>
                  <option value="">—</option>
                  {accounts.filter((a) => a.isActive).map((a) => (
                    <option key={a.id} value={a.id}>{a.name} — {a.bankName}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-slate-600">
                به حساب
                <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={opsAccount2} onChange={(e) => setOpsAccount2(e.target.value)}>
                  <option value="">—</option>
                  {accounts.filter((a) => a.isActive).map((a) => (
                    <option key={a.id} value={a.id}>{a.name} — {a.bankName}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-slate-600">
                کارمزد (اختیاری)
                <Input value={opsFee} onChange={(e) => setOpsFee(e.target.value)} dir="ltr" inputMode="decimal" />
              </label>
            </>
          ) : (
            <label className="block text-xs text-slate-600">
              حساب بانکی
              <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={opsAccount} onChange={(e) => setOpsAccount(e.target.value)}>
                <option value="">—</option>
                {accounts.filter((a) => a.isActive).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} — {a.bankName}</option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs text-slate-600">
            مبلغ (ریال)
            <Input value={opsAmount} onChange={(e) => setOpsAmount(e.target.value)} dir="ltr" inputMode="numeric" />
          </label>
          <label className="block text-xs text-slate-600">
            تاریخ (اختیاری — پیش‌فرض امروز)
            <Input type="date" value={opsDate} onChange={(e) => setOpsDate(e.target.value)} />
          </label>
          <label className="block text-xs text-slate-600">
            شرح
            <Input value={opsDesc} onChange={(e) => setOpsDesc(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setOpsOpen(null)}>انصراف</Button>
            <Button
              size="sm"
              disabled={savingOps || !opsAccount || !opsAmount.trim() || (opsOpen === "transfer" && !opsAccount2)}
              onClick={() => void submitOps()}
            >
              {savingOps ? "…" : "ثبت و صدور سند"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* register check modal */}
      <Modal
        open={checkOpen !== null}
        title={checkOpen === "INCOMING" ? "ثبت چک دریافتی" : "ثبت چک پرداختی"}
        onClose={() => setCheckOpen(null)}
        small
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              شماره چک
              <Input value={chkNumber} onChange={(e) => setChkNumber(e.target.value)} dir="ltr" />
            </label>
            <label className="text-xs text-slate-600">
              مبلغ (ریال)
              <Input value={chkAmount} onChange={(e) => setChkAmount(e.target.value)} dir="ltr" inputMode="numeric" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              سررسید
              <Input type="date" value={chkDue} onChange={(e) => setChkDue(e.target.value)} />
            </label>
            <label className="text-xs text-slate-600">
              تاریخ صدور (اختیاری)
              <Input type="date" value={chkIssue} onChange={(e) => setChkIssue(e.target.value)} />
            </label>
          </div>
          <label className="block text-xs text-slate-600">
            بانک (اختیاری)
            <Input value={chkBank} onChange={(e) => setChkBank(e.target.value)} />
          </label>
          <label className="block text-xs text-slate-600">
            شرح
            <Input value={chkDesc} onChange={(e) => setChkDesc(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setCheckOpen(null)}>انصراف</Button>
            <Button
              size="sm"
              disabled={savingCheck || !chkNumber.trim() || !chkAmount.trim() || !chkDue}
              onClick={() => void submitCheck()}
            >
              {savingCheck ? "…" : "ثبت چک"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
