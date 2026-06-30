import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
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
import { computeDay, parseLedgerNumber, resolveCreditClosingBalance } from "../lib/formulaEngine";
import { resolveCreditDescriptions } from "../lib/creditDescriptions";
import { useAutoSaveEntry } from "../shared/hooks/useAutoSaveEntry";

type Props = {
  dayNo: number;
  entryYear?: number;
  entryMonth?: number;
  entryDay?: number;
  openingBalance: number;
  ownerOpeningBalance: number;
  previousOwnerClosingBalance: number;
  dateLabel: string;
  expenseCategories: CatalogItem[];
  commissionCategories: CatalogItem[];
  creditParties: CatalogItem[];
  initial?: DailyLedgerInput;
  disabled?: boolean;
  locked?: boolean;
  canClose?: boolean;
  canReopen?: boolean;
  reopenLabel?: string;
  reopenRequiresTime?: boolean;
  previousDay?: DailyLedgerInput;
  onSave: (input: DailyLedgerInput, options?: { silent?: boolean; awaitRemote?: boolean }) => Promise<void>;
  onCloseDay: (input: DailyLedgerInput) => Promise<void>;
  onSendEmail?: (input: DailyLedgerInput) => Promise<void>;
  onReopenDay?: () => Promise<void>;
  canSendEmail?: boolean;
  canCreateCatalogs?: boolean;
  onCreateCatalog?: (catalog: "expenseCategories" | "creditParties" | "commissionCategories", item: CatalogItem) => Promise<void>;
  onPendingStateChange?: (pending: boolean) => void;
  onManualSaveReady?: (save: (() => Promise<boolean>) | null) => void;
};

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function LoadingIcon({ label = "Loading" }: { label?: string }) {
  return <LoaderCircle className="h-4 w-4 animate-spin" aria-label={label} />;
}

function carryCreditsFromPrevious(dayNo: number, previousDay?: DailyLedgerInput) {
  if (!previousDay) return [];
  return previousDay.credits
    .map((row) => {
      const opening = resolveCreditClosingBalance(row);
      return {
        id: `${dayNo}-credit-${crypto.randomUUID()}`,
        partyId: row.partyId,
        partyName: row.partyName,
        opening,
        loan: 0,
        today: 0,
        receive: 0
      };
    })
    .filter(isCreditMovementRow);
}

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
    sortOrder: index + 1
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

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function mergeCommissionRows(rows: CommissionItem[], options: CatalogItem[]) {
  const merged = new Map<string, CommissionItem>();
  for (const row of rows) {
    const categoryId = row.categoryId ?? options.find((option) => option.name === row.category)?.id;
    const key = categoryId ?? normalizeKey(row.category);
    const current = merged.get(key);
    if (current) {
      current.amount += row.amount;
      continue;
    }
    merged.set(key, {
      ...row,
      categoryId,
      category: row.category
    });
  }
  return sortCommissions([...merged.values()].filter((row) => row.amount !== 0), options);
}

function normalizeOwnerRows(rows: OwnerBalanceRow[]) {
  return rows
    .map((row) => {
      const description = row.description ?? row.label ?? "";
      const expense = row.expense ?? Math.max(row.amount, 0);
      const received = row.received ?? Math.max(-row.amount, 0);
      const amount = expense - received;
      return {
        ...row,
        amount,
        expense,
        received,
        description,
        label: row.label ?? description
      };
    })
    .filter(
      (row) =>
        normalizeKey(row.description ?? row.label ?? "") !== "opening bal" &&
        (row.description || row.label || row.amount !== 0 || row.expense !== 0 || row.received !== 0 || (row.opening ?? 0) !== 0)
    );
}

function isOwnerMovementRow(row: OwnerBalanceRow) {
  return row.amount !== 0 || (row.expense ?? 0) !== 0 || (row.received ?? 0) !== 0;
}

function ownerRowsForEntry(rows: OwnerBalanceRow[]) {
  return normalizeOwnerRows(rows).filter(isOwnerMovementRow);
}

function mergeCreditRows(rows: CreditRow[]) {
  const merged = new Map<string, CreditRow>();
  for (const row of rows) {
    const key = row.partyId ?? normalizeKey(row.partyName);
    const rowLoan = parseLedgerNumber(row.loan ?? row.today);
    const rowReceive = parseLedgerNumber(row.receive);
    const current = merged.get(key);
    if (current) {
      current.loan = parseLedgerNumber(current.loan ?? current.today) + rowLoan;
      current.today = current.loan;
      current.receive = parseLedgerNumber(current.receive) + rowReceive;
      continue;
    }
    merged.set(key, {
      ...row,
      opening: parseLedgerNumber(row.opening),
      loan: rowLoan,
      today: rowLoan,
      receive: rowReceive
    });
  }
  return [...merged.values()].filter(isCreditMovementRow);
}

function isCreditMovementRow(row: CreditRow) {
  return (
    parseLedgerNumber(row.opening) !== 0 ||
    parseLedgerNumber(row.loan ?? row.today) !== 0 ||
    parseLedgerNumber(row.receive) !== 0 ||
    Boolean(row.loanDescription?.trim() || row.receiveDescription?.trim() || row.description?.trim())
  );
}

export function DailyEntryForm({
  dayNo,
  entryYear,
  entryMonth,
  entryDay,
  openingBalance,
  ownerOpeningBalance,
  previousOwnerClosingBalance,
  dateLabel,
  expenseCategories,
  commissionCategories,
  creditParties,
  initial,
  disabled,
  locked,
  previousDay,
  onSave,
  canCreateCatalogs,
  onCreateCatalog,
  onPendingStateChange,
  onManualSaveReady
}: Props) {
  const categoryOptions = activeOrFallback(expenseCategories, ["Salary", "Refreshment", "IMSI", "Utilities", "Rent", "General"]);
  const commissionOptions = activeOrFallback(commissionCategories, [...COMMISSION_CATEGORIES]);
  const partyOptions = creditParties.filter((item) => item.active);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [expenses, setExpenses] = useState<ExpenseItem[]>(initial?.expenses ?? []);
  const [ownerBalances, setOwnerBalances] = useState<OwnerBalanceRow[]>(
    () => ownerRowsForEntry(initial?.ownerBalances ?? [])
  );
  const [credits, setCredits] = useState<CreditRow[]>(
    () => mergeCreditRows(initial?.credits?.length ? initial.credits : carryCreditsFromPrevious(dayNo, previousDay))
  );

  const [expenseDraft, setExpenseDraft] = useState<Pick<ExpenseItem, "categoryId" | "category" | "name" | "description" | "amount">>({
    categoryId: categoryOptions[0]?.id,
    category: categoryOptions[0]?.name ?? "",
    name: "",
    description: "",
    amount: 0
  });
  const [ownerDraft, setOwnerDraft] = useState<Pick<OwnerBalanceRow, "description" | "expense" | "received">>({
    description: "",
    expense: 0,
    received: 0
  });
  const [creditDraft, setCreditDraft] = useState<Pick<CreditRow, "partyId" | "partyName" | "loanDescription" | "receiveDescription" | "loan" | "receive">>({
    partyId: partyOptions[0]?.id ?? "",
    partyName: partyOptions[0]?.name ?? "",
    loanDescription: "",
    receiveDescription: "",
    loan: 0,
    receive: 0
  });
  const [commissions, setCommissions] = useState<CommissionItem[]>(() => {
    const rows = (initial?.commissions ?? [])
      .map((item) => {
        const category = normalizeCommissionCategory(item.category);
        const catalog = commissionOptions.find((option) => option.name === category || option.id === item.categoryId);
        return { ...item, category, categoryId: catalog?.id ?? item.categoryId };
      });
    return mergeCommissionRows(rows, commissionOptions);
  });
  const [commissionDraft, setCommissionDraft] = useState<Pick<CommissionItem, "category" | "amount">>({
    category: commissionOptions[0]?.name ?? COMMISSION_CATEGORIES[0],
    amount: 0
  });
  const [editingCommissionId, setEditingCommissionId] = useState<string | null>(null);
  const [editingOwnerId, setEditingOwnerId] = useState<string | null>(null);
  const [editingCreditId, setEditingCreditId] = useState<string | null>(null);
  const [commissionFilter, setCommissionFilter] = useState("all");
  const [, setSaving] = useState(false);
  const [creditVerifyMessage, setCreditVerifyMessage] = useState("");
  const [catalogModal, setCatalogModal] = useState<null | "expense" | "commission" | "credit">(null);
  const [catalogName, setCatalogName] = useState("");
  const [catalogSaving, setCatalogSaving] = useState(false);
  const lastSavedRef = useRef("");
  const disabledRef = useRef(Boolean(disabled));
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [saveBaselineReady, setSaveBaselineReady] = useState(false);

  useEffect(() => {
    disabledRef.current = Boolean(disabled);
  }, [disabled]);

  function previousCreditOpening(partyId: string, partyName: string) {
    if (!previousDay) return 0;
    const previousRow = previousDay.credits.find(
      (row) => row.partyId === partyId || normalizeKey(row.partyName) === normalizeKey(partyName)
    );
    if (!previousRow) return 0;
    return resolveCreditClosingBalance(previousRow);
  }

  function currentCreditOpening(partyId: string, partyName: string, excludeId?: string | null) {
    void excludeId;
    return previousCreditOpening(partyId, partyName);
  }

  function verifyCreditOpeningsFromPreviousDay() {
    if (!previousDay) {
      setCreditVerifyMessage("Previous day checked: none\nRecords found: 0\nNon-zero balances found: 0");
      return;
    }
    let addedCount = 0;
    let updatedCount = 0;
    const previousNonZeroRows = previousDay.credits
      .map((row) => ({ row, opening: resolveCreditClosingBalance(row) }))
      .filter(({ opening }) => opening !== 0);
    const matchedPartyIds = new Set<string>();
    const unmatchedPartyNames = new Set<string>();
    const carriedBalances: string[] = [];
    const existingKeys = new Set(credits.flatMap((row) => [row.partyId, normalizeKey(row.partyName)].filter(Boolean) as string[]));
    const updatedRows = credits.map((row) => {
      const previous = previousNonZeroRows.find(({ row: previousRow }) =>
        (row.partyId && previousRow.partyId === row.partyId) ||
        normalizeKey(previousRow.partyName) === normalizeKey(row.partyName)
      );
      if (!previous) return row;
      if (previous.row.partyId ?? row.partyId) matchedPartyIds.add(previous.row.partyId ?? row.partyId ?? "");
      carriedBalances.push(`${previous.row.partyName}: ${previous.opening.toLocaleString()}`);
      if (parseLedgerNumber(row.opening) === previous.opening) return row;
      updatedCount += 1;
      return { ...row, opening: previous.opening };
    });
    const missingRows = previousNonZeroRows
      .filter(({ row }) => {
        const found = existingKeys.has(row.partyId ?? "") || existingKeys.has(normalizeKey(row.partyName));
        if (!found) unmatchedPartyNames.add(row.partyName);
        return !found;
      })
      .map(({ row, opening }) => {
        carriedBalances.push(`${row.partyName}: ${opening.toLocaleString()}`);
        return {
          id: `${dayNo}-credit-${crypto.randomUUID()}`,
          partyId: row.partyId,
          partyName: row.partyName,
          opening,
          loan: 0,
          today: 0,
          receive: 0
        };
      });
    addedCount = missingRows.length;
    if (missingRows.length || updatedCount) setCredits(mergeCreditRows([...updatedRows, ...missingRows]));
    setCreditVerifyMessage([
      `Previous day checked: Day ${previousDay.dayNo}`,
      `Records found: ${previousDay.credits.length}`,
      `Non-zero balances found: ${previousNonZeroRows.length}`,
      `Matched party IDs: ${matchedPartyIds.size ? [...matchedPartyIds].join(", ") : "none"}`,
      `Unmatched party names: ${unmatchedPartyNames.size ? [...unmatchedPartyNames].join(", ") : "none"}`,
      `Balances carried forward: ${carriedBalances.length ? carriedBalances.join("; ") : "none"}`,
      `Rows updated: ${updatedCount}`,
      `Rows added: ${addedCount}`
    ].join("\n"));
  }

  const derivedOwnerBalances = useMemo(
    () => {
      let runningOpening = previousOwnerClosingBalance;
      return ownerRowsForEntry(ownerBalances).map((row) => {
        const opening = runningOpening;
        const balance = opening + row.amount;
        runningOpening = balance;
        return {
          ...row,
          opening,
          balance
        };
      });
    },
    [ownerBalances, previousOwnerClosingBalance]
  );

  const derivedCredits = useMemo(
    () =>
      mergeCreditRows(credits)
        .map((row) => {
          const opening = previousCreditOpening(row.partyId ?? "", row.partyName);
          const loan = parseLedgerNumber(row.loan ?? row.today);
          const receive = parseLedgerNumber(row.receive);
          return {
            ...row,
            opening,
            loan,
            today: loan,
            receive,
            balance: opening + loan - receive
          };
        })
        .filter(isCreditMovementRow),
    [credits, previousDay]
  );

  useEffect(() => {
    if (!previousDay) return;
    setCredits((rows) => {
      const existingKeys = new Set(rows.map((row) => row.partyId ?? normalizeKey(row.partyName)));
      const missingRows = previousDay.credits
        .filter((row) => !existingKeys.has(row.partyId ?? normalizeKey(row.partyName)) && resolveCreditClosingBalance(row) !== 0)
        .map((row) => ({
          id: `${dayNo}-credit-${crypto.randomUUID()}`,
          partyId: row.partyId,
          partyName: row.partyName,
          opening: resolveCreditClosingBalance(row),
          loan: 0,
          today: 0,
          receive: 0
        }));
      return missingRows.length ? mergeCreditRows([...rows, ...missingRows]) : rows;
    });
  }, [dayNo, previousDay]);

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
      reopenedUntilAt: initial?.reopenedUntilAt,
      reopenedAt: initial?.reopenedAt,
      reopenedBy: initial?.reopenedBy,
      reopenedByRole: initial?.reopenedByRole,
      updatedAt: initial?.updatedAt,
      expenses: expenses.filter((item) => item.name || item.description || item.amount !== 0),
      ownerBalances: derivedOwnerBalances.filter(
        (row) =>
          row.amount !== 0 ||
          (row.expense ?? 0) !== 0 ||
          (row.received ?? 0) !== 0
      ),
      credits: derivedCredits.filter(isCreditMovementRow),
      commissions: sortCommissions(commissions.filter((item) => item.amount !== 0), commissionOptions)
    }),
    [
      commissionOptions,
      commissions,
      dateLabel,
      dayNo,
      derivedCredits,
      derivedOwnerBalances,
      expenses,
      entryDay,
      entryMonth,
      entryYear,
      initial?.lockedAt,
      initial?.lockedBy,
      initial?.lockedByRole,
      initial?.reopenedUntilAt,
      initial?.reopenedAt,
      initial?.reopenedBy,
      initial?.reopenedByRole,
      initial?.updatedAt,
      notes
    ]
  );

  const { hasPendingAutoSave } = useAutoSaveEntry({
    data: payload,
    enabled: true,
    disabled,
    debounceMs: 900,
    resetKey: `${dayNo}-${initial?.lockedAt ?? ""}-${initial?.updatedAt ?? ""}`,
    save: async (nextPayload) => {
      setSaveInFlight(true);
      try {
        await onSave(nextPayload, { silent: true });
        lastSavedRef.current = JSON.stringify(nextPayload);
      } finally {
        setSaveInFlight(false);
      }
    }
  });

  const preview: MonthComputed["days"][number] = computeDay(payload, openingBalance, ownerOpeningBalance);

  const editingOwnerOpening = editingOwnerId
    ? derivedOwnerBalances.find((row) => row.id === editingOwnerId)?.opening
    : undefined;
  const ownerOpeningPreview = editingOwnerOpening ?? derivedOwnerBalances[0]?.opening ?? previousOwnerClosingBalance;
  const ownerClosingPreview = derivedOwnerBalances.at(-1)?.balance ?? previousOwnerClosingBalance;

  const creditOpeningPreview = creditDraft.partyId
    ? currentCreditOpening(creditDraft.partyId, creditDraft.partyName, editingCreditId)
    : 0;

  useEffect(() => {
    lastSavedRef.current = JSON.stringify(payload);
    setSaveInFlight(false);
    setSaveBaselineReady(true);
  }, [dayNo, initial?.lockedAt, initial?.updatedAt]);

  const hasPendingChanges = saveBaselineReady && (
    saveInFlight ||
    hasPendingAutoSave ||
    JSON.stringify(payload) !== lastSavedRef.current
  );

  useEffect(() => {
    onPendingStateChange?.(hasPendingChanges);
  }, [hasPendingChanges, onPendingStateChange]);

  useEffect(() => {
    if (!hasPendingChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasPendingChanges]);

  async function handleManualSave() {
    if (disabledRef.current) return false;
    setSaving(true);
    setSaveInFlight(true);
    try {
      await onSave(payload);
      lastSavedRef.current = JSON.stringify(payload);
      return true;
    } catch {
      return false;
    } finally {
      setSaveInFlight(false);
      setSaving(false);
    }
  }

  const manualSaveRef = useRef<() => Promise<boolean>>(handleManualSave);
  manualSaveRef.current = handleManualSave;

  useEffect(() => {
    if (!onManualSaveReady) return;
    const save = () => manualSaveRef.current();
    onManualSaveReady(save);
    return () => onManualSaveReady(null);
  }, [onManualSaveReady]);

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
    const expense = ownerDraft.expense ?? 0;
    const received = ownerDraft.received ?? 0;
    const amount = expense - received;
    if (!ownerDraft.description.trim() && expense === 0 && received === 0) return;
    const description = ownerDraft.description.trim();
    setOwnerBalances((rows) => {
      if (editingOwnerId) {
        return rows.map((row) =>
          row.id === editingOwnerId
            ? {
                ...row,
                description,
                label: description,
                amount,
                expense,
                received
              }
            : row
        );
      }
      return [
        ...rows,
        {
          id: `${dayNo}-owner-${crypto.randomUUID()}`,
          opening: 0,
          description,
          label: description,
          amount,
          expense,
          received
        }
      ];
    });
    setOwnerDraft({
      description: "",
      expense: 0,
      received: 0
    });
    setEditingOwnerId(null);
  }

  function editOwnerRow(row: OwnerBalanceRow) {
    if (!window.confirm(`Edit franchise owner entry?`)) return;
    setOwnerDraft({
      description: row.description ?? row.label ?? "",
      expense: row.expense ?? Math.max(row.amount, 0),
      received: row.received ?? Math.max(-row.amount, 0)
    });
    setEditingOwnerId(row.id);
  }

  function deleteOwnerRow(row: OwnerBalanceRow) {
    if (!window.confirm(`Delete franchise owner entry for ${row.description || row.label || "this row"}?`)) return;
    setOwnerBalances((rows) => rows.filter((r) => r.id !== row.id));
  }

  function addCredit() {
    if (!creditDraft.partyId) return;
    const opening = currentCreditOpening(creditDraft.partyId, creditDraft.partyName, editingCreditId);
    setCredits((rows) => {
      const editingRow = editingCreditId ? rows.find((row) => row.id === editingCreditId) : undefined;
      const remainingRows = editingCreditId ? rows.filter((row) => row.id !== editingCreditId) : rows;
      const duplicateRow = remainingRows.find(
        (row) =>
          row.partyId === creditDraft.partyId ||
          normalizeKey(row.partyName) === normalizeKey(creditDraft.partyName)
      );
      if (duplicateRow) {
        const existingDescriptions = resolveCreditDescriptions(duplicateRow);
        return remainingRows.map((row) =>
          row.id === duplicateRow.id
            ? {
                ...row,
                partyId: creditDraft.partyId,
                partyName: creditDraft.partyName,
                loanDescription: creditDraft.loanDescription?.trim() || existingDescriptions.loanDescription,
                receiveDescription: creditDraft.receiveDescription?.trim() || existingDescriptions.receiveDescription,
                loan: parseLedgerNumber(row.loan ?? row.today) + parseLedgerNumber(creditDraft.loan),
                today: parseLedgerNumber(row.loan ?? row.today) + parseLedgerNumber(creditDraft.loan),
                receive: parseLedgerNumber(row.receive) + parseLedgerNumber(creditDraft.receive)
              }
            : row
        );
      }
      return [
        ...remainingRows,
        {
          id: editingCreditId ?? `${dayNo}-credit-${crypto.randomUUID()}`,
          partyId: creditDraft.partyId,
          partyName: creditDraft.partyName,
          ...(editingRow?.description !== undefined ? { description: editingRow.description } : {}),
          loanDescription: creditDraft.loanDescription?.trim() ?? "",
          receiveDescription: creditDraft.receiveDescription?.trim() ?? "",
          opening,
          loan: creditDraft.loan,
          receive: creditDraft.receive
        }
      ];
    });
    setCreditDraft({
      partyId: partyOptions[0]?.id ?? "",
      partyName: partyOptions[0]?.name ?? "",
      loanDescription: "",
      receiveDescription: "",
      loan: 0,
      receive: 0
    });
    setEditingCreditId(null);
  }

  function editCredit(row: CreditRow) {
    if (!window.confirm(`Edit credit entry for ${row.partyName}?`)) return;
    const descriptions = resolveCreditDescriptions(row);
    setCreditDraft({
      partyId: row.partyId ?? "",
      partyName: row.partyName ?? "",
      loanDescription: descriptions.loanDescription,
      receiveDescription: descriptions.receiveDescription,
      loan: parseLedgerNumber(row.loan ?? row.today),
      receive: parseLedgerNumber(row.receive)
    });
    setEditingCreditId(row.id);
  }

  function deleteCredit(row: CreditRow) {
    if (!window.confirm(`Delete credit entry for ${row.partyName}?`)) return;
    setCredits((rows) => rows.filter((r) => r.id !== row.id));
  }

  function updateCreditDescription(
    rowId: string,
    field: "loanDescription" | "receiveDescription",
    value: string
  ) {
    setCredits((rows) => rows.map((row) => row.id === rowId ? { ...row, [field]: value } : row));
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
    if (!window.confirm(`Edit ${item.category} commission entry?`)) return;
    setCommissionDraft({ category: item.category, amount: item.amount });
    setEditingCommissionId(item.id);
  }

  function deleteCommission(item: CommissionItem) {
    if (!window.confirm(`Delete ${item.category} commission entry of ${item.amount.toLocaleString()}?`)) return;
    setCommissions((rows) => rows.filter((row) => row.id !== item.id));
  }

  function addCommission() {
    if (commissionDraft.amount === 0) return;
    const categoryId = commissionOptions.find((option) => option.name === commissionDraft.category)?.id;
    setCommissions((rows) => {
      const remainingRows = editingCommissionId ? rows.filter((row) => row.id !== editingCommissionId) : rows;
      const duplicateRow = remainingRows.find((row) => row.category === commissionDraft.category || row.categoryId === categoryId);
      if (duplicateRow) {
        return sortCommissions(
          remainingRows.map((row) =>
            row.id === duplicateRow.id
              ? { ...row, category: commissionDraft.category, categoryId, amount: row.amount + commissionDraft.amount }
              : row
          ),
          commissionOptions
        );
      }
      return sortCommissions([
        ...remainingRows,
        {
          id: editingCommissionId ?? `${dayNo}-commission-${crypto.randomUUID()}`,
          categoryId,
          category: commissionDraft.category,
          amount: commissionDraft.amount
        }
      ], commissionOptions);
    });
    setCommissionDraft((draft) => ({ ...draft, amount: 0 }));
    setEditingCommissionId(null);
  }

  async function createCatalogItem() {
    if (!catalogModal || !onCreateCatalog) return;
    const clean = catalogName.trim();
    if (!clean) return;
    setCatalogSaving(true);
    try {
      const config = {
        expense: {
          catalog: "expenseCategories" as const,
          sortOrder: expenseCategories.length + 1,
          apply: (item: CatalogItem) => setExpenseDraft((draft) => ({ ...draft, categoryId: item.id, category: item.name }))
        },
        commission: {
          catalog: "commissionCategories" as const,
          sortOrder: commissionCategories.length + 1,
          apply: (item: CatalogItem) => setCommissionDraft((draft) => ({ ...draft, category: item.name }))
        },
        credit: {
          catalog: "creditParties" as const,
          sortOrder: creditParties.length + 1,
          apply: (item: CatalogItem) => setCreditDraft((draft) => ({ ...draft, partyId: item.id, partyName: item.name }))
        }
      }[catalogModal];
      const item = { id: slug(clean), name: clean, active: true, sortOrder: config.sortOrder };
      await onCreateCatalog(config.catalog, item);
      config.apply(item);
      setCatalogName("");
      setCatalogModal(null);
    } finally {
      setCatalogSaving(false);
    }
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      {catalogModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 text-slate-100 shadow-2xl shadow-black/40">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">
                  {catalogModal === "expense" ? "Expense Category" : catalogModal === "commission" ? "Commission Category" : "Credit Party"}
                </h3>
              </div>
              <button className="btn-ghost !h-9 !w-9 !px-0" onClick={() => setCatalogModal(null)} title="Close popup">
                <X />
              </button>
            </div>
            <label>
              Name
              <input autoFocus value={catalogName} onChange={(event) => setCatalogName(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter") void createCatalogItem();
              }} />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-secondary" disabled={catalogSaving} onClick={() => setCatalogModal(null)}>Cancel</button>
              <button className="btn-primary" disabled={catalogSaving || !catalogName.trim()} onClick={() => void createCatalogItem()}>
                {catalogSaving && <LoadingIcon label="Saving option" />}
                Add
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="space-y-5">
        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Commission</h3>
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
            <div className="flex items-end gap-2">
              <button className="btn-primary" disabled={disabled || commissionDraft.amount === 0} onClick={addCommission}>
                {editingCommissionId ? "Update Entry" : "Add Entry"}
              </button>
              <button className="btn-secondary !h-10 !w-10 !px-0" disabled={!canCreateCatalogs || !onCreateCatalog} title="Add commission category" onClick={() => setCatalogModal("commission")}>
                <Plus />
              </button>
            </div>
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
          <div className="mobile-card-list md:hidden">
            {visibleCommissions.map((item) => {
              const order = commissionOptions.findIndex((category) => category.name === item.category || category.id === item.categoryId);
              return (
                <article className="mobile-list-card" key={item.id}>
                  <div className="mobile-card-head">
                    <div>
                      <p className="mobile-label">Commission</p>
                      <h3 className="mobile-card-title">{item.category}</h3>
                    </div>
                    <span className="mobile-pill mobile-pill-good">{item.amount.toLocaleString()}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-400">Order {order >= 0 ? order + 1 : "-"}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button className="btn-ghost" disabled={disabled} onClick={() => editCommission(item)}>
                      <Pencil /> Edit
                    </button>
                    <button className="btn-ghost text-rose-200" disabled={disabled} onClick={() => deleteCommission(item)}>
                      <Trash2 /> Delete
                    </button>
                  </div>
                </article>
              );
            })}
            {visibleCommissions.length === 0 && <p className="mobile-empty">No commission entries match this filter.</p>}
          </div>
          <div className="table-wrap hidden md:block">
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
            <div className="flex items-end gap-2">
              <button
                className="btn-primary"
                disabled={disabled || (!expenseDraft.name && !expenseDraft.description && expenseDraft.amount === 0)}
                onClick={addExpense}
              >
                Add Entry
              </button>
              <button className="btn-secondary !h-10 !w-10 !px-0" disabled={!canCreateCatalogs || !onCreateCatalog} title="Add expense category" onClick={() => setCatalogModal("expense")}>
                <Plus />
              </button>
            </div>
          </div>
          <div className="mobile-card-list md:hidden">
            {expenses.map((item) => (
              <article className="mobile-list-card" key={item.id}>
                <div className="mobile-card-head">
                  <div className="min-w-0">
                    <p className="mobile-label">{item.category}</p>
                    <h3 className="mobile-card-title">{item.name || "Expense"}</h3>
                  </div>
                  <span className="mobile-pill mobile-pill-good">{item.amount.toLocaleString()}</span>
                </div>
                {item.description && <p className="mt-2 text-sm text-slate-400">{item.description}</p>}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button className="btn-ghost" disabled={disabled} onClick={() => editExpense(item)}>
                    <Pencil /> Edit
                  </button>
                  <button className="btn-ghost text-rose-200" disabled={disabled} onClick={() => deleteExpense(item)}>
                    <Trash2 /> Delete
                  </button>
                </div>
              </article>
            ))}
            {expenses.length === 0 && <p className="mobile-empty">No expense entries.</p>}
          </div>
          <div className="table-wrap hidden md:block">
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
            </div>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
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
              Expense
              {inputText(ownerDraft.expense ?? 0, (expense) => setOwnerDraft((draft) => ({ ...draft, expense })), disabled)}
            </label>
            <label>
              Received
              {inputText(ownerDraft.received ?? 0, (received) => setOwnerDraft((draft) => ({ ...draft, received })), disabled)}
            </label>
            <label>
              Opening
              <input value={ownerOpeningPreview.toLocaleString()} disabled readOnly />
            </label>
            <label>
              Closing
              <input value={ownerClosingPreview.toLocaleString()} disabled readOnly />
            </label>
            <button
              className="btn-primary self-end"
              disabled={disabled || (!ownerDraft.description.trim() && (ownerDraft.expense ?? 0) === 0 && (ownerDraft.received ?? 0) === 0)}
              onClick={addOwnerRow}
            >
              {editingOwnerId ? "Update Entry" : "Add Entry"}
            </button>
          </div>
          <div className="mobile-card-list md:hidden">
            {derivedOwnerBalances.map((row) => (
              <article className="mobile-list-card" key={row.id}>
                <div className="mobile-card-head">
                  <div className="min-w-0">
                    <p className="mobile-label">Franchise Owner</p>
                    <h3 className="mobile-card-title">{row.description ?? row.label ?? "Owner entry"}</h3>
                  </div>
                  <span className="mobile-pill">{(row.balance ?? (row.opening ?? 0) + row.amount).toLocaleString()}</span>
                </div>
                <dl className="mobile-kv-grid mt-3">
                  <div><dt>Opening</dt><dd>{(row.opening ?? 0).toLocaleString()}</dd></div>
                  <div><dt>Expense</dt><dd>{(row.expense ?? Math.max(row.amount, 0)).toLocaleString()}</dd></div>
                  <div><dt>Received</dt><dd>{(row.received ?? Math.max(-row.amount, 0)).toLocaleString()}</dd></div>
                </dl>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button className="btn-ghost" disabled={disabled} onClick={() => editOwnerRow(row)}>
                    <Pencil /> Edit
                  </button>
                  <button className="btn-ghost text-rose-200" disabled={disabled} onClick={() => deleteOwnerRow(row)}>
                    <Trash2 /> Delete
                  </button>
                </div>
              </article>
            ))}
            {derivedOwnerBalances.length === 0 && <p className="mobile-empty">No owner entries.</p>}
          </div>
          <div className="table-wrap hidden md:block">
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Opening</th>
                  <th>Expense</th>
                  <th>Received</th>
                  <th>Balance</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {derivedOwnerBalances.map((row) => (
                  <tr key={row.id}>
                    <td>{row.description ?? row.label ?? ""}</td>
                    <td>{(row.opening ?? 0).toLocaleString()}</td>
                    <td>{(row.expense ?? Math.max(row.amount, 0)).toLocaleString()}</td>
                    <td>{(row.received ?? Math.max(-row.amount, 0)).toLocaleString()}</td>
                    <td>{(row.balance ?? (row.opening ?? 0) + row.amount).toLocaleString()}</td>
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
                {derivedOwnerBalances.length === 0 && (
                  <tr>
                    <td colSpan={6}>No owner entries.</td>
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
            </div>
            <button
              className="btn-secondary"
              disabled={!previousDay}
              onClick={verifyCreditOpeningsFromPreviousDay}
            >
              Verify Credit Parties
            </button>
          </div>
          {creditVerifyMessage && <pre className="status whitespace-pre-wrap font-sans text-sm">{creditVerifyMessage}</pre>}
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[repeat(6,minmax(0,1fr))_auto]">
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
              <input value={creditOpeningPreview.toLocaleString()} disabled readOnly />
            </label>
            <label>
              Loan Description
              <input
                value={creditDraft.loanDescription ?? ""}
                disabled={disabled || !creditDraft.partyId}
                onChange={(event) => setCreditDraft((draft) => ({ ...draft, loanDescription: event.target.value }))}
                placeholder="Loan reason or reference"
              />
            </label>
            <label>
              Loan
              {inputText(creditDraft.loan ?? 0, (loan) => setCreditDraft((draft) => ({ ...draft, loan })), disabled)}
            </label>
            <label>
              Receive Description
              <input
                value={creditDraft.receiveDescription ?? ""}
                disabled={disabled || !creditDraft.partyId}
                onChange={(event) => setCreditDraft((draft) => ({ ...draft, receiveDescription: event.target.value }))}
                placeholder="Receive reason or reference"
              />
            </label>
            <label>
              Receive
              {inputText(creditDraft.receive, (receive) => setCreditDraft((draft) => ({ ...draft, receive })), disabled)}
            </label>
            <div className="flex items-end gap-2">
              <button
                className="btn-primary"
                disabled={disabled || !creditDraft.partyId}
                onClick={addCredit}
              >
                {editingCreditId ? "Update Entry" : "Add Entry"}
              </button>
              <button className="btn-secondary !h-10 !w-10 !px-0" disabled={!canCreateCatalogs || !onCreateCatalog} title="Add credit party" onClick={() => setCatalogModal("credit")}>
                <Plus />
              </button>
            </div>
          </div>
          <div className="mobile-card-list md:hidden">
            {derivedCredits.map((row) => {
              const balance = resolveCreditClosingBalance(row);
              const descriptions = resolveCreditDescriptions(row);
              return (
                <article className="mobile-list-card" key={row.id}>
                  <div className="mobile-card-head">
                    <div className="min-w-0">
                      <p className="mobile-label">Credit Party</p>
                      <h3 className="mobile-card-title">{row.partyName}</h3>
                    </div>
                    <span className="mobile-pill">{balance.toLocaleString()}</span>
                  </div>
                  <dl className="mobile-kv-grid mt-3">
                    <div><dt>Opening</dt><dd>{row.opening.toLocaleString()}</dd></div>
                    <div>
                      <dt>Loan Description</dt>
                      <dd>
                        <input
                          value={descriptions.loanDescription}
                          disabled={disabled}
                          onChange={(event) => updateCreditDescription(row.id, "loanDescription", event.target.value)}
                          placeholder="-"
                        />
                      </dd>
                    </div>
                    <div><dt>Loan</dt><dd>{(row.loan ?? row.today ?? 0).toLocaleString()}</dd></div>
                    <div>
                      <dt>Receive Description</dt>
                      <dd>
                        <input
                          value={descriptions.receiveDescription}
                          disabled={disabled}
                          onChange={(event) => updateCreditDescription(row.id, "receiveDescription", event.target.value)}
                          placeholder="-"
                        />
                      </dd>
                    </div>
                    <div><dt>Receive</dt><dd>{row.receive.toLocaleString()}</dd></div>
                  </dl>
                  {descriptions.legacyDescription && (
                    <p className="mt-2 text-xs text-amber-300">Legacy description: {descriptions.legacyDescription}</p>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button className="btn-ghost" disabled={disabled} onClick={() => editCredit(row)}>
                      <Pencil /> Edit
                    </button>
                    <button className="btn-ghost text-rose-200" disabled={disabled} onClick={() => deleteCredit(row)}>
                      <Trash2 /> Delete
                    </button>
                  </div>
                </article>
              );
            })}
            {derivedCredits.length === 0 && <p className="mobile-empty">No credit entries.</p>}
          </div>
          <div className="table-wrap hidden md:block">
            <table>
              <thead>
                <tr>
                  <th>Party</th>
                  <th>Opening</th>
                  <th>Loan Description</th>
                  <th>Loan</th>
                  <th>Receive Description</th>
                  <th>Receive</th>
                  <th>Balance</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {derivedCredits.map((row) => {
                  const balance = resolveCreditClosingBalance(row);
                  const descriptions = resolveCreditDescriptions(row);
                  return (
                    <tr key={row.id}>
                      <td>{row.partyName}</td>
                      <td>{row.opening.toLocaleString()}</td>
                      <td>
                        <input
                          value={descriptions.loanDescription}
                          disabled={disabled}
                          onChange={(event) => updateCreditDescription(row.id, "loanDescription", event.target.value)}
                          placeholder="-"
                        />
                        {descriptions.legacyDescription && (
                          <span className="mt-1 block text-xs text-amber-300">Legacy: {descriptions.legacyDescription}</span>
                        )}
                      </td>
                      <td>{(row.loan ?? row.today ?? 0).toLocaleString()}</td>
                      <td>
                        <input
                          value={descriptions.receiveDescription}
                          disabled={disabled}
                          onChange={(event) => updateCreditDescription(row.id, "receiveDescription", event.target.value)}
                          placeholder="-"
                        />
                      </td>
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
                {derivedCredits.length === 0 && (
                  <tr>
                    <td colSpan={8}>No credit entries.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <aside className="hidden space-y-3 xl:sticky xl:top-5 xl:block xl:self-start">
        {[
          ["Opening Balance", preview.openingBalance],
          ["Commission", preview.commissionTotal],
          ["Expense", preview.expenseTotal],
          ["Balance", preview.returnBalance],
          ["Credit", preview.creditTotals.balance]
        ].map(([label, value]) => (
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20" key={label}>
            <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold text-white">{Number(value).toLocaleString()}</p>
          </div>
        ))}
      </aside>
    </section>
  );
}
