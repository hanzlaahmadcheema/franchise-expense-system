import { useMemo, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  COMMISSION_CATEGORIES,
  type CatalogItem,
  type CommissionCategory,
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
  openingBalance: number;
  dateLabel: string;
  liveClock: string;
  expenseCategories: CatalogItem[];
  creditParties: CatalogItem[];
  initial?: DailyLedgerInput;
  disabled?: boolean;
  previousDay?: DailyLedgerInput;
  onSave: (input: DailyLedgerInput) => Promise<void>;
};

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

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

function inputNumber(value: number, onChange: (value: number) => void, disabled?: boolean) {
  return (
    <input
      type="number"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
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

function normalizeCommissionCategory(category: string): CommissionCategory | null {
  if (category === "Jazz Cash") return "JazzCash";
  if (category === "Jazz Load") return "JazzLoad";
  return COMMISSION_CATEGORIES.find((item) => item === category) ?? null;
}

const commissionOrder = new Map(COMMISSION_CATEGORIES.map((category, index) => [category, index]));

function sortCommissions(rows: CommissionItem[]) {
  return [...rows].sort(
    (a, b) =>
      (commissionOrder.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
      (commissionOrder.get(b.category) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function DailyEntryForm({
  dayNo,
  openingBalance,
  dateLabel,
  liveClock,
  expenseCategories,
  creditParties,
  initial,
  disabled,
  previousDay,
  onSave
}: Props) {
  const categoryOptions = activeOrFallback(expenseCategories, ["Salary", "Refreshment", "IMSI", "Utilities", "Rent", "General"]);
  const partyOptions = creditParties.filter((item) => item.active);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [expenses, setExpenses] = useState<ExpenseItem[]>(
    initial?.expenses.length ? initial.expenses : [emptyExpense(dayNo, categoryOptions[0])]
  );
  const [ownerBalances, setOwnerBalances] = useState<OwnerBalanceRow[]>(
    initial?.ownerBalances.length ? initial.ownerBalances : [emptyOwner(dayNo)]
  );
  const [credits, setCredits] = useState<CreditRow[]>(
    initial?.credits.length ? initial.credits : [emptyCredit(dayNo, partyOptions[0])]
  );
  const [commissions, setCommissions] = useState<CommissionItem[]>(() => {
    const rows = (initial?.commissions ?? [])
      .map((item) => {
        const category = normalizeCommissionCategory(item.category);
        return category ? { ...item, category } : null;
      })
      .filter((item): item is CommissionItem => Boolean(item))
      .filter((item) => item.amount !== 0);
    return sortCommissions(rows);
  });
  const [commissionDraft, setCommissionDraft] = useState<Pick<CommissionItem, "category" | "amount">>({
    category: COMMISSION_CATEGORIES[0],
    amount: 0
  });
  const [commissionFilter, setCommissionFilter] = useState<"all" | CommissionCategory>("all");
  const [saving, setSaving] = useState(false);

  const payload = useMemo<DailyLedgerInput>(
    () => ({
      dayNo,
      date: dateLabel,
      label: dayNo === 32 ? "FINAL" : `Day ${dayNo}`,
      notes,
      expenses: expenses.filter((item) => item.name || item.description || item.amount !== 0),
      ownerBalances: ownerBalances.filter(
        (row) => row.description || row.label || row.amount !== 0 || (row.opening ?? 0) !== 0
      ),
      credits: credits.filter(
        (row) => row.partyName || row.opening !== 0 || (row.loan ?? row.today ?? 0) !== 0 || row.receive !== 0
      ),
      commissions: sortCommissions(commissions.filter((item) => item.amount !== 0))
    }),
    [commissions, credits, dateLabel, dayNo, expenses, notes, ownerBalances]
  );

  const preview: MonthComputed["days"][number] = computeDay(payload, openingBalance);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(payload);
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

  function chooseExpenseCategory(index: number, categoryId: string) {
    const category = categoryOptions.find((item) => item.id === categoryId);
    setExpenses((rows) =>
      rows.map((row, i) => (i === index ? { ...row, categoryId, category: category?.name ?? "" } : row))
    );
  }

  function chooseCreditParty(index: number, partyId: string) {
    const party = partyOptions.find((item) => item.id === partyId);
    setCredits((rows) =>
      rows.map((row, i) => (i === index ? { ...row, partyId, partyName: party?.name ?? "" } : row))
    );
  }

  const visibleCommissions = sortCommissions(
    commissions.filter((item) => item.amount !== 0 && (commissionFilter === "all" || item.category === commissionFilter))
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
          category: commissionDraft.category,
          amount: commissionDraft.amount
        }
      ])
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
              <p>{dateLabel} · {liveClock}</p>
            </div>
            <button className="btn-primary" disabled={disabled || saving} onClick={handleSave}>
              {saving ? "Saving..." : "Save Day"}
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
              <select disabled={disabled} value={commissionDraft.category} onChange={(event) => setCommissionDraft((draft) => ({ ...draft, category: event.target.value as CommissionCategory }))}>
                {COMMISSION_CATEGORIES.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </label>
            <label>
              Amount
              {inputNumber(commissionDraft.amount, (amount) => setCommissionDraft((draft) => ({ ...draft, amount })), disabled)}
            </label>
            <button className="btn-primary self-end" disabled={disabled || commissionDraft.amount === 0} onClick={addCommission}>
              Add Entry
            </button>
          </div>
          <div className="mb-4 max-w-xs">
            <label>
              Filter
              <select value={commissionFilter} onChange={(event) => setCommissionFilter(event.target.value as "all" | CommissionCategory)}>
                <option value="all">All non-zero</option>
                {COMMISSION_CATEGORIES.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </label>
          </div>
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
                  return (
                    <tr key={item.id}>
                      <td>{(commissionOrder.get(item.category) ?? 0) + 1}</td>
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
              <p>Categories are managed separately and selected here</p>
            </div>
            <button className="btn-secondary" disabled={disabled} onClick={() => setExpenses((rows) => [...rows, emptyExpense(dayNo, categoryOptions[0])])}>
              Add Expense
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
                </tr>
              </thead>
              <tbody>
                {expenses.map((item, index) => (
                  <tr key={item.id}>
                    <td>
                      <select value={item.categoryId ?? slug(item.category ?? categoryOptions[0]?.name ?? "")} disabled={disabled} onChange={(event) => chooseExpenseCategory(index, event.target.value)}>
                        {categoryOptions.map((category) => (
                          <option key={category.id} value={category.id}>{category.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input value={item.name} disabled={disabled} onChange={(event) => setExpenses((rows) => rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))} />
                    </td>
                    <td>
                      <input value={item.description} disabled={disabled} onChange={(event) => setExpenses((rows) => rows.map((row, i) => (i === index ? { ...row, description: event.target.value } : row)))} />
                    </td>
                    <td>{inputNumber(item.amount, (amount) => setExpenses((rows) => rows.map((row, i) => (i === index ? { ...row, amount } : row))), disabled)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Franchise Owner</h3>
              <p>Opening, description, amount, and calculated balance</p>
            </div>
            <button className="btn-secondary" disabled={disabled} onClick={() => setOwnerBalances((rows) => [...rows, emptyOwner(dayNo)])}>
              Add Owner Row
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
                </tr>
              </thead>
              <tbody>
                {ownerBalances.map((row, index) => (
                  <tr key={row.id}>
                    <td>{inputNumber(row.opening ?? 0, (opening) => setOwnerBalances((rows) => rows.map((item, i) => (i === index ? { ...item, opening } : item))), disabled)}</td>
                    <td><input value={row.description ?? row.label ?? ""} disabled={disabled} onChange={(event) => setOwnerBalances((rows) => rows.map((item, i) => (i === index ? { ...item, description: event.target.value, label: event.target.value } : item)))} /></td>
                    <td>{inputNumber(row.amount, (amount) => setOwnerBalances((rows) => rows.map((item, i) => (i === index ? { ...item, amount } : item))), disabled)}</td>
                    <td><input value={((row.opening ?? 0) + row.amount).toLocaleString()} disabled readOnly /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Credit Parties</h3>
              <p>Balances carry by party ID</p>
            </div>
            <div className="quick-actions">
              <button className="btn-ghost" type="button" disabled={disabled || !previousDay} onClick={copyCreditsFromPrevious}>
                Carry Previous
              </button>
              <button className="btn-secondary" disabled={disabled} onClick={() => setCredits((rows) => [...rows, emptyCredit(dayNo, partyOptions[0])])}>
                Add Party
              </button>
            </div>
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
                </tr>
              </thead>
              <tbody>
                {credits.map((row, index) => {
                  const balance = row.opening + (row.loan ?? row.today ?? 0) - row.receive;
                  return (
                    <tr key={row.id}>
                      <td>
                        <select value={row.partyId ?? ""} disabled={disabled || partyOptions.length === 0} onChange={(event) => chooseCreditParty(index, event.target.value)}>
                          <option value="">{partyOptions.length ? "Select party" : "Create party first"}</option>
                          {partyOptions.map((party) => (
                            <option key={party.id} value={party.id}>{party.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>{inputNumber(row.opening, (opening) => setCredits((rows) => rows.map((item, i) => (i === index ? { ...item, opening } : item))), disabled)}</td>
                      <td>{inputNumber(row.loan ?? row.today ?? 0, (loan) => setCredits((rows) => rows.map((item, i) => (i === index ? { ...item, loan, today: loan } : item))), disabled)}</td>
                      <td>{inputNumber(row.receive, (receive) => setCredits((rows) => rows.map((item, i) => (i === index ? { ...item, receive } : item))), disabled)}</td>
                      <td><input value={balance.toLocaleString()} disabled readOnly /></td>
                    </tr>
                  );
                })}
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
