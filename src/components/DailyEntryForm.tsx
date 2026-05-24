import { useMemo, useState } from "react";
import {
  COMMISSION_CATEGORIES,
  type CommissionCategory,
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
  initial?: DailyLedgerInput;
  disabled?: boolean;
  previousDay?: DailyLedgerInput;
  onSave: (input: DailyLedgerInput) => Promise<void>;
};

const emptyExpense = (dayNo: number): ExpenseItem => ({
  id: `${dayNo}-expense-${crypto.randomUUID()}`,
  name: "",
  description: "",
  amount: 0
});

const emptyCredit = (dayNo: number): CreditRow => ({
  id: `${dayNo}-credit-${crypto.randomUUID()}`,
  partyName: "",
  opening: 0,
  today: 0,
  receive: 0
});

const emptyOwner = (dayNo: number): OwnerBalanceRow => ({
  id: `${dayNo}-owner-${crypto.randomUUID()}`,
  label: "",
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

export function DailyEntryForm({ dayNo, openingBalance, initial, disabled, previousDay, onSave }: Props) {
  const [date, setDate] = useState(initial?.date ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [expenses, setExpenses] = useState<ExpenseItem[]>(
    initial?.expenses.length ? initial.expenses : [emptyExpense(dayNo)]
  );
  const [ownerBalances, setOwnerBalances] = useState<OwnerBalanceRow[]>(
    initial?.ownerBalances.length ? initial.ownerBalances : [emptyOwner(dayNo)]
  );
  const [credits, setCredits] = useState<CreditRow[]>(
    initial?.credits.length ? initial.credits : [emptyCredit(dayNo)]
  );
  const [commissions, setCommissions] = useState<Record<CommissionCategory, number>>(() => {
    const values = COMMISSION_CATEGORIES.reduce(
      (acc, category) => ({ ...acc, [category]: 0 }),
      {} as Record<CommissionCategory, number>
    );
    for (const item of initial?.commissions ?? []) values[item.category] = item.amount;
    return values;
  });
  const [saving, setSaving] = useState(false);

  const payload = useMemo<DailyLedgerInput>(
    () => ({
      dayNo,
      date,
      notes,
      expenses: expenses.filter((item) => item.name || item.description || item.amount !== 0),
      ownerBalances: ownerBalances.filter((row) => row.label || row.amount !== 0),
      credits: credits.filter(
        (row) => row.partyName || row.opening !== 0 || row.today !== 0 || row.receive !== 0
      ),
      commissions: COMMISSION_CATEGORIES.map((category, index) => ({
        id: `${dayNo}-commission-${index}`,
        category,
        amount: commissions[category] ?? 0
      })).filter((item) => item.amount !== 0)
    }),
    [commissions, credits, date, dayNo, expenses, notes, ownerBalances]
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
      previousDay.credits.map((row) => ({
        ...row,
        id: `${dayNo}-credit-${crypto.randomUUID()}`,
        opening: row.balance ?? row.opening + row.today - row.receive,
        today: 0,
        receive: 0
      }))
    );
  }

  function addQuickExpense(description: string, category: string) {
    setExpenses((rows) => [
      ...rows,
      {
        ...emptyExpense(dayNo),
        description,
        category
      }
    ]);
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>Day {dayNo} Entry</h2>
          <p>Opening {preview.openingBalance.toLocaleString()}</p>
        </div>
        <button className="btn-primary" disabled={disabled || saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save Day"}
        </button>
      </div>

      <div className="grid two">
        <label>
          Date label
          <input value={date} disabled={disabled} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label>
          Notes
          <input value={notes} disabled={disabled} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>

      <h3>Expenses</h3>
      <div className="quick-actions">
        <button className="btn-ghost" type="button" disabled={disabled} onClick={() => addQuickExpense("Salary", "Salary")}>
          Salary
        </button>
        <button className="btn-ghost" type="button" disabled={disabled} onClick={() => addQuickExpense("Refreshment", "Refreshment")}>
          Refreshment
        </button>
        <button className="btn-ghost" type="button" disabled={disabled} onClick={() => addQuickExpense("IMSI", "IMSI")}>
          IMSI
        </button>
        <button className="btn-ghost" type="button" disabled={disabled} onClick={() => addQuickExpense("Utilities", "Utilities")}>
          Utilities
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Category</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((item, index) => (
              <tr key={item.id}>
                <td>
                  <input
                    value={item.name}
                    disabled={disabled}
                    onChange={(event) =>
                      setExpenses((rows) =>
                        rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row))
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    value={item.description}
                    disabled={disabled}
                    onChange={(event) =>
                      setExpenses((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, description: event.target.value } : row
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    value={item.category ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      setExpenses((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, category: event.target.value } : row
                        )
                      )
                    }
                  />
                </td>
                <td>
                  {inputNumber(
                    item.amount,
                    (amount) =>
                      setExpenses((rows) =>
                        rows.map((row, i) => (i === index ? { ...row, amount } : row))
                      ),
                    disabled
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn-secondary" disabled={disabled} onClick={() => setExpenses((rows) => [...rows, emptyExpense(dayNo)])}>
        Add Expense
      </button>

      <h3>Commissions</h3>
      <div className="grid compact">
        {COMMISSION_CATEGORIES.map((category) => (
          <label key={category}>
            {category}
            {inputNumber(
              commissions[category] ?? 0,
              (amount) => setCommissions((prev) => ({ ...prev, [category]: amount })),
              disabled
            )}
          </label>
        ))}
      </div>

      <h3>Franchise Owner / Cash</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {ownerBalances.map((row, index) => (
              <tr key={row.id}>
                <td>
                  <input
                    value={row.label}
                    disabled={disabled}
                    onChange={(event) =>
                      setOwnerBalances((rows) =>
                        rows.map((item, i) => (i === index ? { ...item, label: event.target.value } : item))
                      )
                    }
                  />
                </td>
                <td>
                  {inputNumber(
                    row.amount,
                    (amount) =>
                      setOwnerBalances((rows) =>
                        rows.map((item, i) => (i === index ? { ...item, amount } : item))
                      ),
                    disabled
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn-secondary" disabled={disabled} onClick={() => setOwnerBalances((rows) => [...rows, emptyOwner(dayNo)])}>
        Add Owner/Cash Row
      </button>

      <h3>Credit Parties</h3>
      <div className="quick-actions">
        <button className="btn-ghost" type="button" disabled={disabled || !previousDay} onClick={copyCreditsFromPrevious}>
          Carry Previous Credit Balances
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Party</th>
              <th>Opening</th>
              <th>Today</th>
              <th>Receive</th>
            </tr>
          </thead>
          <tbody>
            {credits.map((row, index) => (
              <tr key={row.id}>
                <td>
                  <input
                    value={row.partyName}
                    disabled={disabled}
                    onChange={(event) =>
                      setCredits((rows) =>
                        rows.map((item, i) =>
                          i === index ? { ...item, partyName: event.target.value } : item
                        )
                      )
                    }
                  />
                </td>
                <td>
                  {inputNumber(
                    row.opening,
                    (opening) =>
                      setCredits((rows) =>
                        rows.map((item, i) => (i === index ? { ...item, opening } : item))
                      ),
                    disabled
                  )}
                </td>
                <td>
                  {inputNumber(
                    row.today,
                    (today) =>
                      setCredits((rows) =>
                        rows.map((item, i) => (i === index ? { ...item, today } : item))
                      ),
                    disabled
                  )}
                </td>
                <td>
                  {inputNumber(
                    row.receive,
                    (receive) =>
                      setCredits((rows) =>
                        rows.map((item, i) => (i === index ? { ...item, receive } : item))
                      ),
                    disabled
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn-secondary" disabled={disabled} onClick={() => setCredits((rows) => [...rows, emptyCredit(dayNo)])}>
        Add Credit Party
      </button>

      <div className="metric-row">
        <strong>Issue {preview.issueBalance.toLocaleString()}</strong>
        <strong>Expense {preview.expenseTotal.toLocaleString()}</strong>
        <strong>Return {preview.returnBalance.toLocaleString()}</strong>
        <strong>Credit {preview.creditTotals.balance.toLocaleString()}</strong>
      </div>
    </section>
  );
}
