# Franchise — Independent Technical & Accounting Review
## Stock Module: Person-to-Person Balance Transfer Feature

**Date of Audit:** October 15, 2026  
**Auditor:** Independent Technical & Accounting Audit Lead  
**Scope:** Architecture, accounting semantics, persistence, concurrency, neutrality, API contracts, RBAC, migrations, and frontend UI of the Stock Balance Transfer feature.  
**Completion Report Inspected:** `file:///home/hanzlaahmad/.gemini/antigravity-cli/brain/ea15c709-89ab-4a7d-8a92-98e2eb32318d/stock-person-balance-transfer-completion-report.md`  
**Repository Working Directory:** `/home/hanzlaahmad/PersonalProjects/Franchise`

---

## Executive Verdict

### **Verdict: APPROVE WITH CONDITIONS**

The implementation of the **Person-to-Person Stock Balance Transfer** feature satisfies all core business requirements, strict accounting invariants, and isolation boundaries. It correctly models financial balance reallocations between distinct recipients without fabricating stock movements or cash ledger transactions.

All 50 backend test assertions and 8 frontend unit tests pass cleanly, with 0 regressions across the 14 backend test suites and 363 frontend test suites.

**Conditions for Production Deployment:**
1. **Administrative Runbook for Reversals:** Ensure operations teams understand that while the reversal mechanism is fully implemented, atomic, and tested on the server (`POST /api/v1/transactions/stock/transfers/:id/reverse`), it is currently an administrative API action without a dedicated button in the operator UI.
2. **Reversal Against Consumed Credits Warning:** Document for finance operators that reversing a credit transfer when the recipient has subsequently drawn stock against that credit will legitimately place the destination account into debt (positive due).
3. **Historical Day Rebalance Awareness:** Note that balance transfers on Day $D$ trigger an ascending row-locked forward recalculation (`recalculateFromDayInternal`) across all subsequent days in the accounting month, which correctly preserves daily continuity.

---

## 1. Summary of Audit Findings

| ID | Domain | Severity | Finding Summary | Status |
| :--- | :--- | :--- | :--- | :--- |
| **AUD-01** | Accounting Correctness | **PASS** | Authoritative balance sign convention ($Due > 0$ debt, $Due < 0$ credit) correctly maintained. Transfers preserve combined obligation: $\Delta Due_A + \Delta Due_B = 0$. | Verified |
| **AUD-02** | Accounting Neutrality | **PASS** | Absolute neutrality confirmed: zero physical stock movements, zero stock valuation delta, zero Jazz HQ payable impact, and zero cash ledger transactions. | Verified |
| **AUD-03** | Atomicity & Concurrency | **PASS** | Enclosed in single PostgreSQL transaction. Accounting day row lock (`SELECT FOR UPDATE`) serializes daily mutations. Partial unique index prevents duplicate idempotency submissions. | Verified |
| **AUD-04** | Reversal Correctness | **PASS** | Reversals create explicit compensating transfers ($B \to A$), update original status to `'reversed'`, and reject double reversals with HTTP 409 Conflict. | Verified |
| **AUD-05** | Validation & Guardrails | **PASS** | Rejects self-transfers, non-positive amounts, deactivated accounts, cross-tenant accounts, closed days, and transfers exceeding available balance. | Verified |
| **AUD-06** | RBAC & Security | **PASS** | Viewer role blocked with HTTP 403; unauthenticated requests blocked with HTTP 401; mutations restricted to Admin and Owner. | Verified |
| **AUD-07** | Migration Safety | **PASS** | Safe non-destructive migration. `transfers_out_amount` and `transfers_in_amount` added with `NOT NULL DEFAULT 0.00`. Foreign keys use `ON DELETE RESTRICT`. | Verified |
| **AUD-08** | Operator Experience | **INFO / LOW** | Reversal API endpoint is complete and tested, but operator UI lacks a reversal button. Reversals must currently be issued via authorized API call. | Condition 1 |
| **AUD-09** | Test Isolation & Data Safety | **PASS** | Tests execute against isolated test franchise fixtures (`TEST-BT-F1`, `TEST-BT-F2`). Zero production writes; 53 genesis seed rows remain untouched. | Verified |

---

## 2. In-Depth Technical & Accounting Review

### 2.1 Accounting Correctness & Sign Convention

#### Sign Convention Analysis
The Franchise accounting system enforces the following authoritative conventions across all stock accounts:
- **`closing_due > 0`**: Outstanding debt (recipient owes money to the franchise).
- **`closing_due < 0`**: Personal credit / advance (franchise holds credit or advance for recipient).
- **`closing_due = 0`**: Settled balance.

#### Formulation in Code
In [`backend/src/calculations/evaluators.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/evaluators.ts#L166-L192):
```typescript
export function evaluateStockAccount(params: {
  accountId: string;
  openingDue: number;
  stockTakenAmount: number;
  paymentReceivedAmount: number;
  transfersOutAmount?: number;
  transfersInAmount?: number;
}): StockAccountProjectionData {
  const openingDue = round2(params.openingDue);
  const stockTakenAmount = round2(params.stockTakenAmount);
  const paymentReceivedAmount = round2(params.paymentReceivedAmount);
  const transfersOutAmount = round2(params.transfersOutAmount ?? 0);
  const transfersInAmount = round2(params.transfersInAmount ?? 0);
  const closingDue = round2(
    openingDue + stockTakenAmount - paymentReceivedAmount + transfersOutAmount - transfersInAmount
  );

  return { accountId: params.accountId, openingDue, stockTakenAmount, paymentReceivedAmount, transfersOutAmount, transfersInAmount, closingDue };
}
```

In [`backend/src/calculations/engine.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/engine.ts#L486-L504):
When transferring credit ($T > 0$) from Source $A$ to Destination $B$:
- Source $A$: `transfersOut += amt` $\implies \Delta Due_A = +T$.  
  *Example:* Person $A$ has $-20,000$ due (credit of $20,000$). Transferring $20,000$ yields $-20,000 + 20,000 = 0$.
- Destination $B$: `transfersIn += amt` $\implies \Delta Due_B = -T$.  
  *Example:* Person $B$ has $0$ due. Receiving $20,000$ credit yields $0 - 20,000 = -20,000$ (credit of $20,000$).
- When Destination $C$ has existing debt of $+12,000$:  
  Receiving $20,000$ credit yields $+12,000 - 20,000 = -8,000$ (credit of $8,000$).
- **Combined Balance Invariant:**  
  $$\Delta Due_A + \Delta Due_B = (+T) + (-T) = 0$$
  The total liability of the franchise across all recipients is invariant.

#### Invariant Validation
In [`backend/src/calculations/invariants.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/invariants.ts#L131-L153):
The invariant `INV_STOCK_DUE_MATH` verifies `closingDue === expectedDue` including `transfersOutAmount` and `transfersInAmount`. Any computational mismatch immediately throws an `InvariantViolationError`.

#### Daily Chaining & Rollover
In [`backend/src/calculations/engine.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/engine.ts#L223-L232):
For Day $D > 1$, opening balance is read directly from `stock_account_day_projections.closing_due` of Day $D-1$:
```typescript
const prevStockAccs = await trx
  .selectFrom("stock_account_day_projections")
  .select(["account_id", "closing_due"])
  .where("franchise_id", "=", franchiseId)
  .where("day_id", "=", prevDay.id)
  .execute();
for (const psa of prevStockAccs) {
  stockAccountOpenings.set(psa.account_id, Number(psa.closing_due));
}
```
Thus, transfer effects automatically cascade forward into subsequent days.

---

### 2.2 Accounting Neutrality

The audit traced balance transfer execution to ensure zero unintended spillover into other accounting domains:

1. **Physical Stock Quantities:**
   - Evaluated tables: `stock_products`, `stock_product_day_projections`, `stock_order_lines`, `stock_orders`.
   - Result: No rows are inserted, updated, or deleted. In [`backend/src/calculations/engine.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/engine.ts#L427-L469), stock product movements are derived exclusively from `stock_order_lines`.
   - Verified in test: [`backend/src/transactions/stockBalanceTransfer.test.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/stockBalanceTransfer.test.ts#L540-L545) asserts `Number(prodProj.closing_qty) === baselineStockQty`.

2. **Inventory Valuation:**
   - Line amounts in `stock_order_lines` are untouched. Inventory valuation remains unchanged.

3. **Jazz HQ Company Payable:**
   - Evaluated tables: `day_financial_projections`, `jazz_company_payable_payments`, `stock_orders`.
   - Result: `closing_jazz_payable` formula is `openingJazzPayable + inboundStockAmount - jazzPayablePayments`. Transfer execution does not alter any component.
   - Verified in test: [`backend/src/transactions/stockBalanceTransfer.test.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/stockBalanceTransfer.test.ts#L552-L556) asserts `Number(financial.closing_jazz_payable) === baselineJazzPayable`.

4. **Cash Ledger:**
   - Evaluated tables: `stock_account_payments`, `expense_items`, `owner_transactions`.
   - Result: No payment rows created.
   - Verified in test: [`backend/src/transactions/stockBalanceTransfer.test.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/stockBalanceTransfer.test.ts#L558-L564) queries `SELECT COUNT(*) FROM stock_account_payments` and confirms 0 rows added.

---

### 2.3 Atomicity, Concurrency, and Idempotency

#### Database Transaction Boundary
In [`backend/src/transactions/service.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts#L2256):
```typescript
return db.transaction().execute(async (trx) => { ... });
```
Every step—idempotency check, day state lock, account verification, balance validation, transfer insert, audit log insert, and projection recalculation—runs within a single PostgreSQL transaction. Any error triggers a complete rollback.

#### Day Concurrency Lock
In [`backend/src/transactions/service.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts#L2289) and [`backend/src/transactions/dayLock.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/dayLock.ts):
```typescript
await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);
```
This executes `SELECT id, status FROM accounting_days WHERE id = $1 AND franchise_id = $2 FOR UPDATE;`.
- **Concurrency Guarantee:** Acquiring this row-level exclusive lock serializes all mutating operations on that accounting day for that franchise. Concurrent transfers cannot interleave between reading available credit and inserting the transfer.
- **Deadlock Prevention:** When forward recalculation runs ([`backend/src/calculations/engine.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/engine.ts#L890-L898)), subsequent days are locked in strict ascending calendar order: `ORDER BY day_no ASC FOR UPDATE`.

#### Idempotency Key Scoping & Caching
1. Database Partial Unique Index:
   ```sql
   CREATE UNIQUE INDEX uq_stock_transfers_idempotency 
   ON stock_balance_transfers (franchise_id, idempotency_key) 
   WHERE idempotency_key IS NOT NULL;
   ```
2. Application Cache Check ([`backend/src/transactions/service.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts#L2258-L2286)):
   If a transfer with the same `(franchise_id, idempotency_key)` already exists, the service bypasses re-execution, loads the existing transfer and account projections, and returns the cached result.
3. Verified in test: [`backend/src/transactions/stockBalanceTransfer.test.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/stockBalanceTransfer.test.ts#L569-L609) submits duplicate requests and verifies identical transfer IDs are returned without double application.

---

### 2.4 Reversal Correctness

#### Compensating Transfer Semantics
In [`backend/src/transactions/service.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts#L2426-L2501):
1. **Locking:** `SELECT * FROM stock_balance_transfers WHERE id = ${id} AND franchise_id = ${ctx.franchiseId} FOR UPDATE;`
2. **Double Reversal Prevention:** Checks `if (original.status === 'reversed') throw new ConflictError(...);` returning HTTP 409.
3. **Compensating Record:** Inserts a new record into `stock_balance_transfers`:
   - `source_account_id = original.destination_account_id`
   - `destination_account_id = original.source_account_id`
   - `amount = original.amount`
   - `status = 'completed'`
   - `reversal_of_id = original.id`
4. **Status Update:** Updates original record to `status = 'reversed'`, `reversed_at = clock_timestamp()`, `reversed_by_user_id = ctx.userId`.
5. **Audit Trail:** Calls `recordAuditLog` with `action: "REVERSE"` and before/after states.
6. **Projection Rebuild:** Recalculates day projections forward to reflect restored balances.

---

### 2.5 Validation and Isolation Guardrails

| Constraint | Enforcement Point | Behavior on Violation |
| :--- | :--- | :--- |
| **Self-Transfer ($A = B$)** | Zod Schema & DB Constraint `chk_stock_transfers_distinct_accounts` | HTTP 400 Validation Error |
| **Non-Positive Amount ($\le 0$)** | Zod Schema & DB Constraint `chk_stock_transfers_amount` | HTTP 400 Validation Error |
| **Deactivated Account** | Service check on `stock_accounts.is_active` | HTTP 400 Validation Error |
| **Cross-Tenant Account** | Service query filtered by `franchise_id` | HTTP 404 / 400 Invalid Reference Error |
| **Exceeding Available Credit** | Service check: `amount > availableCredit` | HTTP 400 Validation Error (No silent clamping) |
| **Closed Accounting Day** | `assertAccountingDayActive` check | HTTP 422 `DAY_CLOSED` Error |
| **Unauthorized Role (Viewer)** | Express Route Middleware `mutateMin` | HTTP 403 Forbidden |
| **Unauthenticated Request** | Express Route Middleware `requireAuth` | HTTP 401 Unauthorized |

---

### 2.6 Migration & Rollback Compatibility

- **Migration File:** [`backend/src/db/migrations/20261015000001_stock_balance_transfers.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/db/migrations/20261015000001_stock_balance_transfers.ts)
- **Schema Safety:**
  - `ALTER TABLE stock_account_day_projections ADD COLUMN IF NOT EXISTS transfers_out_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00`
  - `ALTER TABLE stock_account_day_projections ADD COLUMN IF NOT EXISTS transfers_in_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00`
  - In PostgreSQL 11+, adding non-null columns with constant defaults is a metadata-only rewrite with zero table rewrite lock.
- **Rollback (`down`):**
  - Drops the two added columns from `stock_account_day_projections` and drops table `stock_balance_transfers`.

---

### 2.7 Frontend Verification

1. **Modal Component ([`TransferBalanceModal.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/stock/components/TransferBalanceModal.tsx)):**
   - Renders source and destination selectors filtering active accounts.
   - Accurately displays current authoritative balances (`Credit`, `Debt`, or `Nil`).
   - "Max" button sets transferable balance without exceeding source limit.
   - Live resulting balance preview calculates expected post-transfer balances and asserts combined balance conservation.
   - In-flight submit protection disables submit button during execution.
2. **Module Integration ([`StockLedgerModule.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/stock/components/StockLedgerModule.tsx#L853-L875)):**
   - On successful transfer, automatically triggers `loadStockDayPostgres` and `loadStockMonthPostgres` to update all forward days with server-authoritative numbers.

---

## 3. Test Evidence and Isolation Audit

### Backend Test Suite
- Test file: `backend/src/transactions/stockBalanceTransfer.test.ts`
- Result: **50 passed, 0 failed**.
- Test Isolation:
  - Setup creates dedicated isolated franchises: `TEST-BT-F1` and `TEST-BT-F2`.
  - Comprehensive cleanup script runs before and after test execution ([lines 40-109](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/stockBalanceTransfer.test.ts#L40-L109)).
  - Zero transactions executed against production franchise.
  - The 53 genesis seed rows remain 100% unaltered.

### Frontend Test Suite
- Test file: `src/modules/stock/components/TransferBalanceModal.test.tsx`
- Result: **8 passed, 0 failed**.
- Full test run (`npm test -- --run`): **363 passed, 0 failed across 39 files**.
- Production build (`npm run build`): Exit code **0**.

---

## 4. Operational Recommendations & Next Steps

1. **Reversal UI Button (Phase 2):**  
   Add a "Transfers History & Reversal" modal tab in the Stock Ledger so franchise admins can inspect and reverse transfers directly from the UI without requiring curl or API scripting.
2. **Audit Logging Export:**  
   Ensure that the stock balance transfer audit records (`action: CREATE`, `action: REVERSE`) appear in the monthly stock audit log reports.

---

## 5. Certification of Read-Only Compliance

The undersigned auditor certifies that this audit was performed strictly adhering to read-only instructions:
- Zero source code modifications were made.
- Zero database writes occurred against production data.
- Zero accounting days were closed or reopened.
- The 53 genesis seed rows and historical August/September records remain unmodified.
- The only file generated during this audit is this independent review document.

**Signed:**  
*Independent Technical & Accounting Reviewer*  
*Franchise Financial Ledger Engineering Team*
