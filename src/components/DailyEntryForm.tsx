import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Pencil, Trash2 } from "lucide-react";
import {
  COMMISSION_CATEGORIES,
  type CatalogItem,
  type CommissionItem,
  type CreditRow,
  type DailyLedgerInput,
  type ExpenseItem,
  type MonthComputed,
  type OwnerBalanceRow
} from "../types/ledger";
import { computeDay } from "../lib/formulaEngine";

type Props = {
  dayNo: number;
  entryYear?: number;
  entryMonth?: number;
  entryDay?: number;
  openingBalance: number;
  dateLabel: string;
  expenseCategories: CatalogItem[];
  commissionCategories: CatalogItem[];
  creditParties: CatalogItem[];
  initial?: DailyLedgerInput;
  disabled?: boolean;
  locked?: boolean;
  canClose?: boolean;
  previousDay?: DailyLedgerInput;
  onSave: (input: DailyLedgerInput, options?: { silent?: boolean }) => Promise<void>;
  onCloseDay: (input: DailyLedgerInput) => Promise<void>;
};

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function LoadingIcon({ label = "Loading" }: { label?: string }) {
  return <LoaderCircle className="h-4 w-4 animate-spin" aria-label={label} />;
}

const emptyExpense = (dayNo: number, category?: CatalogItem): ExpenseItem => ({
  id: `${dayNo}-expense-${crypto.randomUUID()}`,
  name: "",
  description: "",
  amount: 0,
  categoryId: category?.id,
  category: category?.name
});

const emptyCredit = (dayNo: number, party?: CatalogItem): CreditRow => ({
  id: `${dayNo}-credit-${crypto.randomUUID()}`,
  partyId: party?.id,
  partyName: party?.name ?? "",
  opening: 0,
  loan: 0,
  receive: 0
});

const emptyOwner = (dayNo: number): OwnerBalanceRow => ({
  id: `${dayNo}-owner-${crypto.randomUUID()}`,
  opening: 0,
  description: "",
  amount: 0
});

function InputText({
  value,
  onChange,
  disabled
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [localVal, setLocalVal] = useState(value === 0 ? "" : value.toString());

  useEffect(() => {
    if (Number(localVal) !== value) {
      setLocalVal(value === 0 ? "" : value.toString());
    }
  }, [value]);

  return (
    <input
      type="text"
      value={localVal}
      disabled={disabled}
      onChange={(event) => {
        const val = event.target.value;
        if (/^-?\d*\.?\d*$/.test(val)) {
          setLocalVal(val);
          const parsed = Number(val);
          if (!isNaN(parsed)) {
            onChange(parsed);
          }
        }
      }}
      onBlur={() => {
        if (localVal === "" || isNaN(Number(localVal))) {
          setLocalVal("");
          onChange(0);
        } else {
          setLocalVal(Number(localVal).toString());
          onChange(Number(localVal));
        }
      }}
    />
  );
}

function inputText(value: number, onChange: (value: number) => void, disabled?: boolean) {
  return <InputText value={value} onChange={onChange} disabled={disabled} />;
}

function activeOrFallback(items: CatalogItem[], fallback: string[]) {
  const active = items.filter((item) => item.active);
  if (active.length) return active;
  return fallback.map((name, index) => ({
    id: slug(name),
    name,
    active: true,
    sortOrder: index
  }));
}

function normalizeCommissionCategory(category: string): string {
  if (category === "Jazz Cash") return "JazzCash";
  if (category === "Jazz Load") return "JazzLoad";
  return category;
}

function sortCommissions(rows: CommissionItem[], options: CatalogItem[]) {
  const commissionOrder = new Map(options.map((category, index) => [category.name, index]));
  return [...rows].sort(
    (a, b) =>
      (commissionOrder.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
      (commissionOrder.get(b.category) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function DailyEntryForm({
  dayNo,
  entryYear,
  entryMonth,
  entryDay,
  openingBalance,
  dateLabel,
  expenseCategories,
  commissionCategories,
  creditParties,
  initial,
  disabled,
  locked,
  canClose,
  previousDay,
  onSave,
  onCloseDay
}: Props) {
  const categoryOptions = activeOrFallback(expenseCategories, ["Salary", "Refreshment", "IMSI", "Utilities", "Rent", "General"]);
  const commissionOptions = activeOrFallback(commissionCategories, [...COMMISSION_CATEGORIES]);
  const partyOptions = creditParties.filter((item) => item.active);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [expenses, setExpenses] = useState<ExpenseItem[]>(initial?.expenses ?? []);
  const [ownerBalances, setOwnerBalances] = useState<OwnerBalanceRow[]>(initial?.ownerBalances ?? []);
  const [credits, setCredits] = useState<CreditRow[]>(initial?.credits ?? []);

  const [expenseDraft, setExpenseDraft] = useState<Pick<ExpenseItem, "categoryId" | "category" | "name" | "description" | "amount">>({
    categoryId: categoryOptions[0]?.id,
    category: categoryOptions[0]?.name ?? "",
    name: "",
    description: "",
    amount: 0
  });
  const [ownerDraft, setOwnerDraft] = useState<Pick<OwnerBalanceRow, "opening" | "description" | "amount">>({
    opening: 0,
    description: "",
    amount: 0
  });
  const [creditDraft, setCreditDraft] = useState<Pick<CreditRow, "partyId" | "partyName" | "opening" | "loan" | "receive">>({
    partyId: partyOptions[0]?.id ?? "",
    partyName: partyOptions[0]?.name ?? "",
    opening: 0,
    loan: 0,
    receive: 0
  });
  const [commissions, setCommissions] = useState<CommissionItem[]>(() => {
    const rows = (initial?.commissions ?? [])
      .map((item) => {
        const category = normalizeCommissionCategory(item.category);
        const catalog = commissionOptions.find((option) => option.name === category || option.id === item.categoryId);
        return { ...item, category, categoryId: catalog?.id ?? item.categoryId };
      })
      .filter((item) => item.amount !== 0);
    return sortCommissions(rows, commissionOptions);
  });
  const [commissionDraft, setCommissionDraft] = useState<Pick<CommissionItem, "category" | "amount">>({
    category: commissionOptions[0]?.name ?? COMMISSION_CATEGORIES[0],
    amount: 0
  });
  const [commissionFilter, setCommissionFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [autoSaveState, setAutoSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveInFlightRef = useRef(false);
  const lastSavedRef = useRef("");

  const payload = useMemo<DailyLedgerInput>(
    () => ({
      dayNo,
      date: dateLabel,
      label: dayNo === 32 ? "FINAL" : `Day ${dayNo}`,
      notes,
      entryYear,
      entryMonth,
      entryDay,
      lockedAt: initial?.lockedAt,
      lockedBy: initial?.lockedBy,
      lockedByRole: initial?.lockedByRole,
      updatedAt: initial?.updatedAt,
      expenses: expenses.filter((item) => item.name || item.description || item.amount !== 0),
      ownerBalances: ownerBalances.filter(
        (row) => row.description || row.label || row.amount !== 0 || (row.opening ?? 0) !== 0
      ),
      credits: credits.filter(
        (row) => row.partyName || row.opening !== 0 || (row.loan ?? row.today ?? 0) !== 0 || row.receive !== 0
      ),
      commissions: sortCommissions(commissions.filter((item) => item.amount !== 0), commissionOptions)
    }),
    [
      commissionOptions,
      commissions,
      credits,
      dateLabel,
      dayNo,
      expenses,
      entryDay,
      entryMonth,
      entryYear,
      initial?.lockedAt,
      initial?.lockedBy,
      initial?.lockedByRole,
      initial?.updatedAt,
      notes,
      ownerBalances
    ]
  );

  const preview: MonthComputed["days"][number] = computeDay(payload, openingBalance);

  useEffect(() => {
    lastSavedRef.current = JSON.stringify(payload);
    setAutoSaveState("saved");
  }, [dayNo, initial?.lockedAt, initial?.updatedAt]);

  useEffect(() => {
    if (disabled) return;
    const timer = window.setInterval(async () => {
      const signature = JSON.stringify(payload);
      if (signature === lastSavedRef.current || saveInFlightRef.current) return;
      saveInFlightRef.current = true;
      setAutoSaveState("saving");
      try {
        await onSave(payload, { silent: true });
        lastSavedRef.current = signature;
        setAutoSaveState("saved");
      } catch {
        setAutoSaveState("error");
      } finally {
        saveInFlightRef.current = false;
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [disabled, onSave, payload]);

  async function handleCloseDay() {
    if (!window.confirm(`Close ${payload.label ?? `Day ${dayNo}`}? Admin users will only be able to view it after closing.`)) return;
    setSaving(true);
    try {
      await onCloseDay(payload);
      lastSavedRef.current = JSON.stringify({ ...payload, lockedAt: payload.lockedAt ?? Date.now() });
      setAutoSaveState("saved");
    } finally {
      setSaving(false);
    }
  }

  function copyCreditsFromPrevious() {
    if (!previousDay) return;
    setCredits(
      previousDay.credits.map((row) => {
        const loan = row.loan ?? row.today ?? 0;
        return {
          ...row,
          id: `${dayNo}-credit-${crypto.randomUUID()}`,
          opening: row.balance ?? row.opening + loan - row.receive,
          loan: 0,
          today: 0,
          receive: 0
        };
      })
    );
  }

  function addExpense() {
    if (!expenseDraft.name && !expenseDraft.description && expenseDraft.amount === 0) return;
    setExpenses((rows) => [
      ...rows,
      {
        id: `${dayNo}-expense-${crypto.randomUUID()}`,
        ...expenseDraft
      }
    ]);
    setExpenseDraft({
      categoryId: categoryOptions[0]?.id,
      category: categoryOptions[0]?.name ?? "",
      name: "",
      description: "",
      amount: 0
    });
  }

  function editExpense(item: ExpenseItem) {
    if (!window.confirm(`Edit ${item.name || "unnamed"} expense entry? It will move back to the entry controls.`)) return;
    setExpenseDraft({
      categoryId: item.categoryId ?? categoryOptions[0]?.id,
      category: item.category ?? categoryOptions[0]?.name ?? "",
      name: item.name,
      description: item.description,
      amount: item.amount
    });
    setExpenses((rows) => rows.filter((row) => row.id !== item.id));
  }

  function deleteExpense(item: ExpenseItem) {
    if (!window.confirm(`Delete ${item.name || "unnamed"} expense of ${item.amount.toLocaleString()}?`)) return;
    setExpenses((rows) => rows.filter((row) => row.id !== item.id));
  }

  function addOwnerRow() {
    if (ownerDraft.opening === 0 && !ownerDraft.description && ownerDraft.amount === 0) return;
    setOwnerBalances((rows) => [
      ...rows,
      {
        id: `${dayNo}-owner-${crypto.randomUUID()}`,
        opening: ownerDraft.opening,
        description: ownerDraft.description,
        label: ownerDraft.description,
        amount: ownerDraft.amount
      }
    ]);
    setOwnerDraft({
      opening: 0,
      description: "",
      amount: 0
    });
  }

  function editOwnerRow(row: OwnerBalanceRow) {
    if (!window.confirm(`Edit franchise owner entry? It will move back to the entry controls.`)) return;
    setOwnerDraft({
      opening: row.opening ?? 0,
      description: row.description ?? row.label ?? "",
      amount: row.amount
    });
    setOwnerBalances((rows) => rows.filter((r) => r.id !== row.id));
  }

  function deleteOwnerRow(row: OwnerBalanceRow) {
    if (!window.confirm(`Delete franchise owner entry of ${row.amount.toLocaleString()}?`)) return;
    setOwnerBalances((rows) => rows.filter((r) => r.id !== row.id));
  }

  function addCredit() {
    if (!creditDraft.partyId) return;
    setCredits((rows) => [
      ...rows,
      {
        id: `${dayNo}-credit-${crypto.randomUUID()}`,
        ...creditDraft
      }
    ]);
    setCreditDraft({
      partyId: partyOptions[0]?.id ?? "",
      partyName: partyOptions[0]?.name ?? "",
      opening: 0,
      loan: 0,
      receive: 0
    });
  }

  function editCredit(row: CreditRow) {
    if (!window.confirm(`Edit credit entry for ${row.partyName}? It will move back to the entry controls.`)) return;
    setCreditDraft({
      partyId: row.partyId ?? "",
      partyName: row.partyName ?? "",
      opening: row.opening,
      loan: row.loan ?? row.today ?? 0,
      receive: row.receive
    });
    setCredits((rows) => rows.filter((r) => r.id !== row.id));
  }

  function deleteCredit(row: CreditRow) {
    if (!window.confirm(`Delete credit entry for ${row.partyName}?`)) return;
    setCredits((rows) => rows.filter((r) => r.id !== row.id));
  }

  const visibleCommissions = sortCommissions(
    commissions.filter((item) => {
      if (item.amount === 0) return false;
      if (commissionFilter === "all") return true;
      const selected = commissionOptions.find((category) => category.id === commissionFilter);
      return item.categoryId === commissionFilter || item.category === selected?.name;
    }),
    commissionOptions
  );

  function editCommission(item: CommissionItem) {
    if (!window.confirm(`Edit ${item.category} commission entry? It will move back to the entry controls.`)) return;
    setCommissionDraft({ category: item.category, amount: item.amount });
    setCommissions((rows) => rows.filter((row) => row.id !== item.id));
  }

  function deleteCommission(item: CommissionItem) {
    if (!window.confirm(`Delete ${item.category} commission entry of ${item.amount.toLocaleString()}?`)) return;
    setCommissions((rows) => rows.filter((row) => row.id !== item.id));
  }

  function addCommission() {
    if (commissionDraft.amount === 0) return;
    setCommissions((rows) =>
      sortCommissions([
        ...rows,
        {
          id: `${dayNo}-commission-${crypto.randomUUID()}`,
          categoryId: commissionOptions.find((option) => option.name === commissionDraft.category)?.id,
          category: commissionDraft.category,
          amount: commissionDraft.amount
        }
      ], commissionOptions)
    );
    setCommissionDraft((draft) => ({ ...draft, amount: 0 }));
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-5">
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>{dayNo === 32 ? "FINAL Entry" : `Day ${dayNo} Entry`}</h2>
              <p className="flex flex-wrap items-center gap-1.5">
                <span>{dateLabel} ·</span>
                {autoSaveState === "saving" && <LoadingIcon label="Autosaving" />}
                <span>{locked && disabled ? "closed" : autoSaveState === "saving" ? "autosaving" : autoSaveState === "error" ? "autosave failed" : "autosaved"}</span>
              </p>
            </div>
            <button className="btn-primary" disabled={!canClose || saving} onClick={handleCloseDay}>
              {saving && <LoadingIcon label="Closing day" />}
              {saving ? "Closing..." : locked ? "Day Closed" : "Close Day"}
            </button>
          </div>
          <div className="grid two">
            <label>
              Opening Balance
              <input value={preview.openingBalance.toLocaleString()} disabled readOnly />
            </label>
            <label>
              Notes
              <input value={notes} disabled={disabled} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Commission</h3>
              <p>Add amount entries, then review them in fixed order</p>
            </div>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
            <label>
              Category
              <select disabled={disabled} value={commissionDraft.category} onChange={(event) => setCommissionDraft((draft) => ({ ...draft, category: event.target.value }))}>
                {commissionOptions.map((category) => (
                  <option key={category.id} value={category.name}>{category.name}</option>
                ))}
              </select>
            </label>
            <label>
              Amount
              {inputText(commissionDraft.amount, (amount) => setCommissionDraft((draft) => ({ ...draft, amount })), disabled)}
            </label>
            <button className="btn-primary self-end" disabled={disabled || commissionDraft.amount === 0} onClick={addCommission}>
              Add Entry
            </button>
          </div>
          {/* <div className="mb-4 max-w-xs">
            <label>
              Filter
              <select value={commissionFilter} onChange={(event) => setCommissionFilter(event.target.value)}>
                <option value="all">All non-zero</option>
                {commissionOptions.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </label>
          </div> */}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Category</th>
                  <th>Amount</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleCommissions.map((item) => {
                  const order = commissionOptions.findIndex((category) => category.name === item.category || category.id === item.categoryId);
                  return (
                    <tr key={item.id}>
                      <td>{order >= 0 ? order + 1 : "-"}</td>
                      <td>{item.category}</td>
                      <td>{item.amount.toLocaleString()}</td>
                      <td>
                        <div className="inline-flex items-center gap-2">
                          <button
                            className="btn-ghost !h-9 !w-9 !px-0"
                            disabled={disabled}
                            title="Edit commission entry"
                            onClick={() => editCommission(item)}
                          >
                            <Pencil />
                          </button>
                          <button
                            className="btn-ghost !h-9 !w-9 !px-0 text-rose-200"
                            disabled={disabled}
                            title="Delete commission entry"
                            onClick={() => deleteCommission(item)}
                          >
                            <Trash2 />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visibleCommissions.length === 0 && (
                  <tr>
                    <td colSpan={4}>No commission entries match this filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Expense</h3>
              <p>Add expense entries, then review them in list</p>
            </div>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_2fr_1fr_auto]">
            <label>
              Category
              <select
                disabled={disabled}
                value={expenseDraft.categoryId}
                onChange={(event) => {
                  const catId = event.target.value;
                  const cat = categoryOptions.find((c) => c.id === catId);
                  setExpenseDraft((draft) => ({ ...draft, categoryId: catId, category: cat?.name ?? "" }));
                }}
              >
                {categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input
                type="text"
                value={expenseDraft.name}
                disabled={disabled}
                onChange={(event) => setExpenseDraft((draft) => ({ ...draft, name: event.target.value }))}
              />
            </label>
            <label>
              Description
              <input
                type="text"
                value={expenseDraft.description}
                disabled={disabled}
                onChange={(event) => setExpenseDraft((draft) => ({ ...draft, description: event.target.value }))}
              />
            </label>
            <label>
              Amount
              {inputText(expenseDraft.amount, (amount) => setExpenseDraft((draft) => ({ ...draft, amount })), disabled)}
            </label>
            <button
              className="btn-primary self-end"
              disabled={disabled || (!expenseDraft.name && !expenseDraft.description && expenseDraft.amount === 0)}
              onClick={addExpense}
            >
              Add Entry
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((item) => (
                  <tr key={item.id}>
                    <td>{item.category}</td>
                    <td>{item.name}</td>
                    <td>{item.description}</td>
                    <td>{item.amount.toLocaleString()}</td>
                    <td>
                      <div className="inline-flex items-center gap-2">
                        <button
                          className="btn-ghost !h-9 !w-9 !px-0"
                          disabled={disabled}
                          title="Edit expense entry"
                          onClick={() => editExpense(item)}
                        >
                          <Pencil />
                        </button>
                        <button
                          className="btn-ghost !h-9 !w-9 !px-0 text-rose-200"
                          disabled={disabled}
                          title="Delete expense entry"
                          onClick={() => deleteExpense(item)}
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {expenses.length === 0 && (
                  <tr>
                    <td colSpan={5}>No expense entries.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Franchise Owner</h3>
              <p>Add owner balance entries, then review them in list</p>
            </div>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr_1fr_auto]">
            <label>
              Opening
              {inputText(ownerDraft.opening ?? 0, (opening) => setOwnerDraft((draft) => ({ ...draft, opening })), disabled)}
            </label>
            <label>
              Description
              <input
                type="text"
                value={ownerDraft.description}
                disabled={disabled}
                onChange={(event) => setOwnerDraft((draft) => ({ ...draft, description: event.target.value }))}
              />
            </label>
            <label>
              Amount
              {inputText(ownerDraft.amount, (amount) => setOwnerDraft((draft) => ({ ...draft, amount })), disabled)}
            </label>
            <button
              className="btn-primary self-end"
              disabled={disabled || (ownerDraft.opening === 0 && !ownerDraft.description && ownerDraft.amount === 0)}
              onClick={addOwnerRow}
            >
              Add Entry
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Opening</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Balance</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {ownerBalances.map((row) => (
                  <tr key={row.id}>
                    <td>{(row.opening ?? 0).toLocaleString()}</td>
                    <td>{row.description ?? row.label ?? ""}</td>
                    <td>{row.amount.toLocaleString()}</td>
                    <td>{((row.opening ?? 0) + row.amount).toLocaleString()}</td>
                    <td>
                      <div className="inline-flex items-center gap-2">
                        <button
                          className="btn-ghost !h-9 !w-9 !px-0"
                          disabled={disabled}
                          title="Edit owner entry"
                          onClick={() => editOwnerRow(row)}
                        >
                          <Pencil />
                        </button>
                        <button
                          className="btn-ghost !h-9 !w-9 !px-0 text-rose-200"
                          disabled={disabled}
                          title="Delete owner entry"
                          onClick={() => deleteOwnerRow(row)}
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {ownerBalances.length === 0 && (
                  <tr>
                    <td colSpan={5}>No owner entries.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Credit Parties</h3>
              <p>Add party credit/debit entries, then review them in list</p>
            </div>
            <div className="quick-actions">
              <button className="btn-ghost" type="button" disabled={disabled || !previousDay} onClick={copyCreditsFromPrevious}>
                Carry Previous
              </button>
            </div>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
            <label>
              Party
              <select
                disabled={disabled || partyOptions.length === 0}
                value={creditDraft.partyId}
                onChange={(event) => {
                  const pId = event.target.value;
                  const party = partyOptions.find((p) => p.id === pId);
                  setCreditDraft((draft) => ({ ...draft, partyId: pId, partyName: party?.name ?? "" }));
                }}
              >
                <option value="">{partyOptions.length ? "Select party" : "Create party first"}</option>
                {partyOptions.map((party) => (
                  <option key={party.id} value={party.id}>{party.name}</option>
                ))}
              </select>
            </label>
            <label>
              Opening
              {inputText(creditDraft.opening, (opening) => setCreditDraft((draft) => ({ ...draft, opening })), disabled)}
            </label>
            <label>
              Loan
              {inputText(creditDraft.loan ?? 0, (loan) => setCreditDraft((draft) => ({ ...draft, loan })), disabled)}
            </label>
            <label>
              Receive
              {inputText(creditDraft.receive, (receive) => setCreditDraft((draft) => ({ ...draft, receive })), disabled)}
            </label>
            <button
              className="btn-primary self-end"
              disabled={disabled || !creditDraft.partyId}
              onClick={addCredit}
            >
              Add Entry
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Party</th>
                  <th>Opening</th>
                  <th>Loan</th>
                  <th>Receive</th>
                  <th>Balance</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {credits.map((row) => {
                  const balance = row.opening + (row.loan ?? row.today ?? 0) - row.receive;
                  return (
                    <tr key={row.id}>
                      <td>{row.partyName}</td>
                      <td>{row.opening.toLocaleString()}</td>
                      <td>{(row.loan ?? row.today ?? 0).toLocaleString()}</td>
                      <td>{row.receive.toLocaleString()}</td>
                      <td>{balance.toLocaleString()}</td>
                      <td>
                        <div className="inline-flex items-center gap-2">
                          <button
                            className="btn-ghost !h-9 !w-9 !px-0"
                            disabled={disabled}
                            title="Edit credit entry"
                            onClick={() => editCredit(row)}
                          >
                            <Pencil />
                          </button>
                          <button
                            className="btn-ghost !h-9 !w-9 !px-0 text-rose-200"
                            disabled={disabled}
                            title="Delete credit entry"
                            onClick={() => deleteCredit(row)}
                          >
                            <Trash2 />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {credits.length === 0 && (
                  <tr>
                    <td colSpan={6}>No credit entries.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <aside className="space-y-3 xl:sticky xl:top-5 xl:self-start">
        {[
          ["Opening Balance", preview.openingBalance],
          ["Commission", preview.commissionTotal],
          ["Expense", preview.expenseTotal],
          ["Balance", preview.returnBalance],
          ["Credit", preview.creditTotals.balance]
        ].map(([label, value]) => (
          <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl shadow-black/20" key={label}>
            <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold text-white">{Number(value).toLocaleString()}</p>
          </div>
        ))}
      </aside>
    </section>
  );
}
