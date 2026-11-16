# Franchise — UI/UX Redesign Final Implementation-Readiness Review

> **DOCUMENT STATUS:** IMPLEMENTATION-READINESS SPECIFICATION & SAFETY AUDIT  
> **READ-ONLY REVIEW — STRICT SAFETY BOUNDARIES ENFORCED**  
> **NO APPLICATION SOURCE CODE, DATABASE DATA, MIGRATIONS, DAY STATUSES, OR GENESIS SEEDS WERE MODIFIED.**  
> **Author:** Antigravity AI Senior Systems Architect & UX Lead  
> **Date:** October 28, 2026  
> **Authoritative Accounting Datastore:** PostgreSQL (`franchise_prod_db` on localhost:5432)  
> **Baseline References:**  
> - [`docs/franchise-ui-ux-audit.md`](file:///home/hanzlaahmad/PersonalProjects/Franchise/docs/franchise-ui-ux-audit.md)  
> - [`docs/franchise-ui-design-system-proposal.md`](file:///home/hanzlaahmad/PersonalProjects/Franchise/docs/franchise-ui-design-system-proposal.md)  

---

## 1. Executive Summary

This document establishes the definitive implementation-readiness specification for the **Franchise UI/UX Redesign**. Franchise is a mature commercial telecom accounting platform supporting multi-franchise operations across three high-volume domains: **Expense**, **Jazz Load**, and **Stock Inventory**.

### Core Review Findings

1. **Autosave vs. Explicit Save Reconciliation (Highest Priority):**  
   A rigorous forensic code audit of all three modules confirms that **Expense, Jazz Load, and Stock already share a unified dual-persistence model**:
   - An asynchronous, debounced background autosave hook ([`useAutoSaveEntry`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/shared/hooks/useAutoSaveEntry.ts)) debounced at **900ms**, gated strictly by an in-memory dirty-state ref (`draftDirtyRef.current`).
   - A synchronous manual "Save Day" action ([`handleVerifiedSave`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/components/DailyEntryForm.tsx#L706)) displaying a transactional progress dialog ([`SaveProgressDialog`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/components/DailyEntryForm.tsx#L342)) that waits for full server confirmation.
   - **Crucial Safety Assertion:** Server hydration, cold page refresh, day switching, and background projection recalculations **never** trigger saves because `draftDirtyRef.current` remains `false` until direct user keystroke or row mutation. The proposed UI redesign will preserve this exact dual-save architecture without altering persistence semantics.

2. **Server-Authoritative Transactional Contracts:**  
   Every operational transaction mutation across Expense, Jazz Load, and Stock executes inside an atomic PostgreSQL transaction (`db.transaction().execute(...)`). Upon commit, the backend guarantees:
   - Accounting day status and open/closed invariant verification (`assertAccountingDayActive`).
   - Master catalog name snapshotting (protecting historical records from future catalog renames).
   - Optimistic concurrency control using mandatory `baseRevision`.
   - Immutable audit logging in `audit_logs`.
   - Idempotency deduplication via `clientMutationId` / `mutation_idempotency`.
   - Forward calculation cascading and materialization into projection tables.
   - HTTP 200 is only returned when both fact write and projection recalculation succeed.

3. **Workflow-Driven Information Architecture:**  
   Rather than imposing an unnatural, identical layout across disparate tasks, the design system respects each module's real daily operating sequence:
   - **Expense:** Tabular single-page daily entry (Expenses, Commissions, Credits, Owner balances) with live cash position summary and a separate tab for monthly ledger reports.
   - **Jazz Load:** Vertical co-visibility of **Daily Lifting** (top section) and the **12-Line DO Distribution Grid** (center section), keeping lifting in-hand balance immediately visible while allocating distribution orders.
   - **Stock:** Dual-stage daily ledger with focused Outbound Dealer Issuance & Cash Collection in the primary view, Inbound Lifting in a dedicated sub-panel, and integrated Balance Transfers.

4. **Zero-Regression Phased Roadmap:**  
   Implementation is partitioned into 6 strictly bounded phases. Acceptance criteria, automated test suites, and rollback boundaries are established prior to writing any production UI code.

---

## 2. Reviewed Source Documents and Code Areas

### 2.1 Documentation Artifacts Reviewed
- [`docs/franchise-ui-ux-audit.md`](file:///home/hanzlaahmad/PersonalProjects/Franchise/docs/franchise-ui-ux-audit.md): Complete 61 KB read-only audit of the entire application shell, navigation, 20 screens, forms, permissions, and 14 observed UI issues.
- [`docs/franchise-ui-design-system-proposal.md`](file:///home/hanzlaahmad/PersonalProjects/Franchise/docs/franchise-ui-design-system-proposal.md): 47 KB unified design system specification outlining the *"Clear Ledger, Focused Day"* visual language, visual tokens, and wireframes.
- [`docs/august-ui-save-architecture-audit.md`](file:///home/hanzlaahmad/PersonalProjects/Franchise/docs/august-ui-save-architecture-audit.md): Forensic analysis of Firestore vs. PostgreSQL save mechanisms and state hydration.
- [`docs/stock-balance-transfer-final-review.md`](file:///home/hanzlaahmad/PersonalProjects/Franchise/docs/stock-balance-transfer-final-review.md): Independent audit of stock dealer balance transfers and compensation reversal invariants.

### 2.2 Frontend Source Modules Inspected
- **Expense Domain:**  
  - [`src/components/DailyEntryForm.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/components/DailyEntryForm.tsx) (1,791 lines): Form state, dirty tracking, autosave, verified save dialog, catalog modals.
  - [`src/services/api/expenseTransactionService.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/expenseTransactionService.ts) (798 lines): PostgreSQL CRUD dispatching, diff-and-sync synchronization, Day 32 FINAL settlements.
  - [`src/components/HomeDashboard.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/components/HomeDashboard.tsx) (1,015 lines): Monthly cash summaries, commission matrix, credit party statements.
- **Jazz Load Domain:**  
  - [`src/modules/jazzLoad/components/JazzLoadModule.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/jazzLoad/components/JazzLoadModule.tsx) (3,351 lines): Lifting form, 12 DO grid, rate snapshots, company payable payments, DO binding catalogs.
  - [`src/modules/jazzLoad/services/jazzLoadTransactionService.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/jazzLoadTransactionService.ts) (375 lines): Lifting synchronization, DO entry synchronization, payable payment recording.
  - [`src/modules/jazzLoad/services/jazzLoadSaveState.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/jazzLoad/services/jazzLoadSaveState.ts): Save preconditions, closed-day guards, rate existence checks.
- **Stock Domain:**  
  - [`src/modules/stock/components/StockLedgerModule.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/stock/components/StockLedgerModule.tsx) (4,929 lines): Product quantities, dealer dues, inbound lifting, balance transfers, catalog tables.
  - [`src/services/api/stockTransactionService.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/stockTransactionService.ts) (475 lines): Inbound/outbound order synchronization, payment synchronization, month parallel loading.
  - [`src/modules/stock/components/TransferBalanceModal.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/stock/components/TransferBalanceModal.tsx): Dealer balance transfer modal.
  - [`src/modules/stock/components/ReverseTransferModal.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/stock/components/ReverseTransferModal.tsx): Reversal modal with audit trail.
- **Application Shell & Shared Infrastructure:**  
  - [`src/App.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/App.tsx) (4,671 lines): Master state orchestration, top-level routing, sidebar rendering, month switching, `UserManager`.
  - [`src/shared/hooks/useAutoSaveEntry.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/shared/hooks/useAutoSaveEntry.ts): Core debounced auto-save hook.
  - [`src/services/api/ledgerApiClient.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/ledgerApiClient.ts): Typed HTTP client for all backend REST endpoints.
  - [`src/shared/dayControls/UniversalDayControlBar.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/shared/dayControls/UniversalDayControlBar.tsx): Calendar day selection and day lock/unlock triggers.

### 2.3 Backend Source Modules Inspected
- **REST Endpoints:**  
  - [`backend/src/transactions/routes.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/routes.ts): REST endpoints for expenses, commissions, credits, owner, lifting, DO, stock orders, payments, transfers.
  - [`backend/src/periods/routes.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/periods/routes.ts): Period lifecycle, day open/close/reopen, seeds, Final settlements.
  - [`backend/src/calculations/routes.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/routes.ts): Projection rebuilds, day projections, invariant reports.
  - [`backend/src/catalogs/routes.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/catalogs/routes.ts): Expense categories, commission categories, credit parties, rates, DO profiles, stock products, dealer accounts.
- **Service & Business Invariant Logic:**  
  - [`backend/src/transactions/service.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts) (2,528 lines): Transaction mutation implementations, optimistic locking, forward recalculations.
  - [`backend/src/periods/service.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/periods/service.ts) (1,970 lines): Day status validation, atomic month close and rollover.
  - [`backend/src/calculations/engine.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/calculations/engine.ts): Server-authoritative calculation engine.

---

## 3. Verified Current Persistence Behavior: Expense, Jazz Load, and Stock

### 3.1 Detailed Module Persistence Tracing

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        VERIFIED DUAL-SAVE PERSISTENCE LIFECYCLE                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ USER INTERACTION                                                                       │
│   ├── User edits input / adds line item / updates table cell                           │
│   └── Component calls `markDraftDirty()` ──> `draftDirtyRef.current = true`            │
│                                                                                        │
│ PERSISTENCE PATH A: Debounced Background Autosave                                      │
│   ├── `useAutoSaveEntry` watches payload / signature with `debounceMs: 900`            │
│   ├── Preconditions: `enabled: draftDirtyRef.current && !disabled && canSave`          │
│   ├── Triggers `onSave(payload, { silent: true })`                                     │
│   └── On HTTP 200: updates `lastSavedRef.current`, resets `draftDirtyRef.current = false`│
│                                                                                        │
│ PERSISTENCE PATH B: Explicit Verified Save ("Save Day" Button)                         │
│   ├── User clicks "Save Day" / "Save Entry" button                                     │
│   ├── Displays `SaveProgressDialog` modal (`saving` spinner)                           │
│   ├── Awaits in-flight background promise if already running                           │
│   ├── Triggers `onSave(payload, { awaitRemote: true })`                                │
│   ├── Updates `lastSavedRef.current`, resets `draftDirtyRef.current = false`           │
│   └── Displays Green "Save Confirmed" confirmation in modal                            │
│                                                                                        │
│ SAFETY ENFORCEMENT: Hydration & Day Switching                                          │
│   ├── Switching Day/Month ──> resets `draftDirtyRef.current = false`                   │
│   ├── Server Hydration ──> only updates local state IF `draftDirtyRef.current === false`│
│   └── Result: Passive reloads & calculations NEVER trigger autosave!                   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### A. Expense Module
1. **Editable Fields:**  
   - Expense items: `item_name`, `amount`, `category_id`, `description`.
   - Commission items: `amount` (category is predefined by catalog row).
   - Credit Party transactions: `loan` amount, `receive` amount, `loanDescription`, `receiveDescription`.
   - Owner Balance transactions: `amount`, `description` (withdrawal vs injection).
   - Day notes: `notes`.
   - Day 32 (FINAL Month-End): Commission final settlements, Expense settlements, Credit party settlements, Owner settlement entries.
2. **Local Draft Management:**  
   State managed via React `useState` hooks: `expenses`, `commissions`, `credits`, `ownerBalances`, `notes`. Assembled into a unified `payload: DailyLedgerInput`.
3. **Saving Mode:** **Mixed (Dual-Save).** Background autosave (`debounceMs: 900`) runs silently while typing; manual explicit "Save Day" (`handleVerifiedSave`) is available with a progress modal.
4. **Events Initiating Persistence:**
   - Keystroke in inputs after 900ms idle time (when `draftDirtyRef.current === true`).
   - Adding or deleting a line item.
   - Clicking "Save Day" button.
   - Navigating away while dirty (triggers `handleBeforeUnload` prompt and flushes via `onManualSaveReady`).
   - Triggering day close (`closeDay` flushes pending drafts via `expenseManualSaveRef.current`).
5. **Call Chain:**  
   `DailyEntryForm` ──> `onSave` ([`saveDay`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/App.tsx#L2477)) ──> [`saveExpenseDayPostgres`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/expenseTransactionService.ts#L45) ──> [`ledgerApiClient.expenses.*`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/ledgerApiClient.ts) ──> Express router [`backend/src/transactions/routes.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/routes.ts#L220) ──> [`createExpense`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts#L130) ──> PostgreSQL transaction.
6. **Dirty State Clearing:**  
   When PostgreSQL returns HTTP 200, `lastSavedRef.current` is set to `JSON.stringify(payload)` and `draftDirtyRef.current` is explicitly set to `false`.
7. **Hydration Trigger Protection:**  
   In [`DailyEntryForm.tsx` L376](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/components/DailyEntryForm.tsx#L376), hydration from server `initial` is guarded by `if (draftDirtyRef.current) return;`. Furthermore, `useAutoSaveEntry` has `enabled: !disabled && draftDirtyRef.current`. Thus, cold loads and server pushes **never** trigger saves.
8. **Firestore Accounting Writes:** **Completely eliminated for PostgreSQL periods.** In `App.tsx` L2496, `if (isPostgreSqlPeriod(monthId))` exclusively routes to `saveExpenseDayPostgres` and returns.

#### B. Jazz Load Module
1. **Editable Fields:**  
   - Daily Lifting: `mlLifting` (cash amount lifted from Jazz company).
   - DO Entries (12 DO lines): `todayMlIssuance` (cash amount issued to DO), `paymentReceived` (cash payment received from DO).
   - Day notes: `dayNotes`.
   - Separate operation: Jazz Company Payable payment (`amount`, `paymentReference`, `notes`).
   - Master Settings: Rates (`mlRate`, `commission1Rate`, `commission2Rate`), DO names, DO lines, Bindings.
2. **Local Draft Management:**  
   State managed in `JazzLoadModule.tsx` via `drafts: JazzLoadDoEntryDraft[]`, `mlLifting: number`, `dayNotes: string`.
3. **Saving Mode:** **Mixed (Dual-Save).** Background autosave (`debounceMs: 900`) runs on `autosaveSignature`; explicit "Save Day" is provided via `handleVerifiedSave` with progress dialog.
4. **Events Initiating Persistence:**
   - Editing lifting or DO issuance/payment inputs after 900ms idle.
   - Clicking "Save Day" button.
   - Explicit "Save Rate" or "Save Profile" buttons in Settings.
5. **Call Chain:**  
   `JazzLoadModule` ──> `saveDay` ──> [`saveJazzLoadDayPostgres`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/jazzLoadTransactionService.ts#L37) ──> [`ledgerApiClient.jazzLifting.*`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/ledgerApiClient.ts) & [`ledgerApiClient.jazzDo.*`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/ledgerApiClient.ts) ──> [`backend/src/transactions/routes.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/routes.ts#L436) ──> [`createJazzLifting`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts) & [`createJazzDoEntry`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts) ──> PostgreSQL transaction.
6. **Precondition Guards:**  
   [`getJazzLoadSaveState`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/modules/jazzLoad/services/jazzLoadSaveState.ts#L1204) strictly validates that the day is open, user has daily write role, selected day is not future, active rate exists, and DO entries do not contain duplicate profiles.
7. **Hydration Trigger Protection:**  
   `useAutoSaveEntry` has `enabled: draftDirtyRef.current && jazzDailyReady`. When loading or switching days, `draftDirtyRef.current` is reset to `false`.

#### C. Stock Module
1. **Editable Fields:**  
   - Dealer Issuance (Outbound): Product quantities for 11 products (`productQuantities: Record<string, number>`), `paymentReceived`, `notes`.
   - Stock Lifting (Inbound): Product quantities lifted from Jazz company, `paidAmount`, `notes`.
   - Balance Transfers: Source account, destination account, transfer amount, transfer reason.
   - Reversals: Reversal reason.
   - Settings: Product rates, display order, active status; Account opening balance, account type, active status.
2. **Local Draft Management:**  
   State managed in `StockLedgerModule.tsx` via `draft: StockDailyAccountDraft` (keyed by dealer account ID) and `stockInDraft` for inbound lifting.
3. **Saving Mode:** **Mixed (Dual-Save).** Background autosave (`debounceMs: 900`) for dealer issuance; explicit "Save Day" (`handleVerifiedSave`) for issuance; explicit "Save Stock In" button for inbound lifting.
4. **Events Initiating Persistence:**
   - Editing product quantities or dealer payments after 900ms idle.
   - Clicking "Save Day" button.
   - Clicking "Save Stock In" button (inbound lifting).
   - Submitting Balance Transfer modal.
5. **Call Chain:**  
   - Dealer Issuance: `StockLedgerModule` ──> `saveEntry` ──> [`saveStockDayPostgres`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/stockTransactionService.ts#L40) ──> [`ledgerApiClient.stockOrders.*`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/ledgerApiClient.ts) & [`ledgerApiClient.stockPayments.*`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/ledgerApiClient.ts) ──> [`backend/src/transactions/routes.ts`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/routes.ts#L544) ──> [`createStockOrder`](file:///home/hanzlaahmad/PersonalProjects/Franchise/backend/src/transactions/service.ts) ──> PostgreSQL transaction.
   - Inbound Lifting: `StockLedgerModule` ──> `saveStockIn` ──> [`saveStockInPostgres`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/stockTransactionService.ts#L141) ──> `ledgerApiClient.stockOrders.create` (with `direction: 'inbound'`).
6. **Hydration Trigger Protection:**  
   `stockEntryAutoSave` has `enabled: stockDraftDirtyRef.current && Boolean(stockDailyReady && canEdit && selectedAccount && previewEntry && !monthBootstrapPending && section === "daily")`. Passive loads do not set `stockDraftDirtyRef.current`, preventing spurious saves.

---

## 4. Save-Contract Comparison and Unresolved Questions

### 4.1 Cross-Module Persistence Comparison Table

| Attribute | Expense Module | Jazz Load Module | Stock Module |
| :--- | :--- | :--- | :--- |
| **Primary Entry Scope** | Multi-table daily entries (4 sections) | 12-line DO distribution grid & daily lifting | Per-dealer issuance form & inbound lifting |
| **Autosave Hook** | `useAutoSaveEntry` (900ms debounce) | `useAutoSaveEntry` (900ms debounce) | `useAutoSaveEntry` (900ms debounce) |
| **Autosave Activation Gate** | `draftDirtyRef.current && !disabled` | `draftDirtyRef.current && jazzDailyReady && canSave` | `stockDraftDirtyRef.current && stockDailyReady && canEdit && selectedAccount` |
| **Explicit Save Trigger** | "Save Day" button (`handleVerifiedSave`) | "Save Day" button (`handleVerifiedSave`) | "Save Day" button (`handleVerifiedSave`) |
| **Save Confirmation UX** | `SaveProgressDialog` (saving spinner ──> green success) | `SaveProgressDialog` (saving spinner ──> green success) | `SaveProgressDialog` (saving spinner ──> green success) |
| **PostgreSQL Dispatcher** | [`saveExpenseDayPostgres`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/expenseTransactionService.ts#L45) | [`saveJazzLoadDayPostgres`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/jazzLoadTransactionService.ts#L37) | [`saveStockDayPostgres`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/services/api/stockTransactionService.ts#L40) |
| **Backend REST Endpoints** | `/expenses`, `/commissions`, `/credits`, `/owner` | `/jazz-load/lifting`, `/jazz-load/do`, `/jazz-company/payments` | `/stock/orders`, `/stock/account-payments`, `/stock/transfers` |
| **Concurrency Control** | `baseRevision` on updates | `baseRevision` on updates | `baseRevision` on updates |
| **Authoritative Projections** | Fetched via `getDayProjections(dayId)` on commit | Fetched via `getDayProjections(dayId)` on commit | Fetched via `getDayProjections(dayId)` on commit |
| **Day Close Integration** | Flushes draft before close; closes via unified API | Closes via unified API | Closes via unified API |
| **Firestore References** | Fully bypassed for PostgreSQL periods | Fully bypassed for PostgreSQL periods | Fully bypassed for PostgreSQL periods |

### 4.2 Intentional Behaviors vs. Suspected Defects

1. **Intentional Business Requirements:**
   - **Dual-Save Model:** Accountants entering dozens of lines need autosave so work is not lost if the browser tab is accidentally closed. Store owners reviewing end-of-day ledgers require the explicit "Save Day" confirmation to be certain PostgreSQL has committed the record.
   - **Catalog Snapshotting:** Freezing category names and DO profiles at the moment of entry is intentional so historical ledgers remain mathematically immutable even if catalogs change.
   - **Optimistic Concurrency:** Rejecting mutations with HTTP 409 if `baseRevision` is stale prevents concurrent overwrites across multiple counter terminals.
2. **Suspected Defects / Inconsistencies:**
   - **Redundant Top Save Buttons:** `DailyEntryForm` renders two identical Save buttons (one in the header and one at the bottom), causing visual clutter.
   - **Console Key Warnings in Audit Logs:** `actionOptions = Object.values(AUDIT_LOG_ACTIONS).flat()` lacks deduplication, generating 50+ console warnings on mount.
   - **Disabled Email Action:** "Send Daily Email" button is visible but permanently disabled (`canSendEmail={false}` in `App.tsx`) because SMTP credentials are unconfigured.

### 4.3 Required Decision & Implementation Boundary
> [!IMPORTANT]
> **Persistence Boundary Decision:** The visual redesign must **strictly preserve the existing dual-save architecture**. The shared Save Control Bar will expose the existing explicit save handler and display clean/dirty/saving/saved states driven by the existing `useAutoSaveEntry` and `draftDirtyRef` logic. **No autosave behavior will be added or removed.**

---

## 5. Module-Specific Navigation and Workflow Decisions

### 5.1 Expense Module
```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ EXPENSE WORKSPACE LAYOUT                                                               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Header: Expense Ledger | Oct 2026 - Day 26 | Status: OPEN | Closing Cash: Rs 136,855   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TABS: [1. Daily Entry]  [2. Ledger Reports & History]  [3. Master Categories]          │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TAB 1: DAILY ENTRY                                                                     │
│ ┌─────────────────────────────────┬──────────────────────────────────────────────────┐ │
│ │ SECTION A: Operating Expenses   │ SECTION B: Commission Receipts                   │ │
│ │ Table: Name | Cat | Rs | Del    │ Grid: Jazz Cash | EasyPaisa | Direct | Total     │ │
│ ├─────────────────────────────────┼──────────────────────────────────────────────────┤ │
│ │ SECTION C: Credit Party Ledger  │ SECTION D: Franchise Owner Movements             │ │
│ │ Table: Party | Loan | Recv | Due│ Table: Desc | Injected | Drawn | Net             │ │
│ └─────────────────────────────────┴──────────────────────────────────────────────────┘ │
│ Universal Action Bar: [Save Day (Pristine/Saved)] [Close Day] [Print Summary]          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
1. **Hierarchy:** `[1. Daily Entry]`, `[2. Ledger Reports & History]`, `[3. Master Categories]`.
2. **Primary Workflow:** Select Day ──> Enter daily expense bills ──> Enter daily commission receipts ──> Record credit party lending/recoveries ──> Verify owner drawings/injections ──> Review closing cash balance ──> Save / Close Day.
3. **Essential Co-Visible Info:** Daily Cash Summary Card (Opening Cash, Expenses Total, Commission Total, Net Cash, Closing Cash) must remain pinned and visible while entering items.
4. **Secondary Information:** Detailed monthly historical trends and category catalogs move to Tabs 2 and 3.
5. **Keyboard Traversal:** `Tab` moves across inputs; `Enter` inside an expense amount triggers `addExpense()` and focuses the next empty row.

### 5.2 Jazz Load Module
```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ JAZZ LOAD WORKSPACE LAYOUT                                                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Header: Jazz Load Ledger | Oct 2026 - Day 26 | Status: OPEN | Rate Snapshot: Active   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TABS: [1. Daily Operations]  [2. Jazz Reports Center]  [3. Calculation Settings]       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TAB 1: DAILY OPERATIONS                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ SECTION 1: DAILY LIFTING & CASH IN-HAND (Pinned Top)                               │ │
│ │ Opening In-Hand: 75,000 | + ML Lifting: [  50,000  ] | Total Available: 125,000    │ │
│ ├────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ SECTION 2: 12-LINE DO DISTRIBUTION GRID (Immediate Center)                         │ │
│ │ Line | DO Name | Open Due | Today Issuance | Payment Recv | Comm | Net Due | Stat │ │
│ │ #1   | Arslan  | 136,855  | [   10,000   ] | [   5,000   ] |  250 | 142,105 | OK   │ │
│ │ ...  | ...     | ...      | ...            | ...           |  ... | ...     | ...  │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ Universal Action Bar: [Save Day (Saved)] [Company Payable Payment] [Close Day]         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
1. **Hierarchy:** `[1. Daily Operations]`, `[2. Jazz Reports Center]`, `[3. Calculation Settings]`.
2. **Primary Workflow:** Select Day ──> Enter Jazz Company ML Lifting ──> Verify Total Available in hand ──> Enter DO Issuance and Payment Received across 12 lines ──> Verify DO balances and Commission Adjustments ──> Record Company Payable Payment if applicable ──> Save / Close Day.
3. **Essential Co-Visible Info:** **Daily Lifting (Section 1) MUST remain visible above the 12 DO Grid (Section 2)**. A clerk cannot issue load safely without seeing how much cash-in-hand is available to distribute.
4. **Secondary Information:** Historical Trend table, DO ranking cards, and Rate configurations move to Tabs 2 and 3.
5. **Keyboard Traversal:** Vertical `Tab`/`Enter` traversal down the Issuance column, then down the Payment column.

### 5.3 Stock Module
```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ STOCK LEDGER WORKSPACE LAYOUT                                                          │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Header: Stock Ledger | Oct 2026 - Day 26 | Status: OPEN | Warehouse Value: Rs 420,000 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TABS: [1. Daily Operations]  [2. Stock Reports & Valuation]  [3. Inventory Masters]    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TAB 1: DAILY OPERATIONS                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ SUB-PANEL A: Inbound Stock Lifting (Jazz Company -> Warehouse) [Expand/Collapse]   │ │
│ │ Products lifted: SIMs, Handsets | Total Lifted: Rs 150,000 | [Save Stock In]       │ │
│ ├────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ SUB-PANEL B: Outbound Dealer Issuance & Payment Collection (Primary Work Area)     │ │
│ │ Dealer Selector: [ DO Arslan ▼ ] | Previous Due: Rs 59,575 | New Due: Rs 84,575   │ │
│ │ Product Matrix (11 Products): Quantity Issued [   ] @ Rate -> Total Amount         │ │
│ │ Cash Payment Received: [ 10,000 ] | Net Closing Due: Rs 74,575                     │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ Universal Action Bar: [Save Day] [Transfer Balance Modal] [Close Day]                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
1. **Hierarchy:** `[1. Daily Operations]`, `[2. Stock Reports & Valuation]`, `[3. Inventory Masters]`.
2. **Primary Workflow:** Select Day ──> Record Inbound Lifting from Jazz Company (if stock arrived) ──> Select Dealer from dropdown ──> Enter quantities issued across products ──> Enter cash payment received ──> Verify dealer closing due ──> Save Dealer Entry ──> Repeat for active dealers ──> Save / Close Day.
3. **Essential Co-Visible Info:** Dealer previous due, today's issuance value, payment received, and calculated closing due must update reactively next to the product quantity grid.
4. **Secondary Information:** Balance transfer audit history, product master price lists, and monthly inventory valuation move to Tabs 2 and 3.
5. **Keyboard Traversal:** `Tab` moves sequentially through product quantity inputs; `Enter` skips to Payment Received.

---

## 6. Final Shared Design-System Specification

### 6.1 Design Tokens (Tailwind CSS Baseline)
- **Neutral Palette:** High-contrast Slate (`bg-slate-950` shell, `bg-slate-900` card surfaces, `border-slate-800` dividers, `text-slate-100` headings, `text-slate-400` secondary text).
- **Domain Accents:**
  - Expense: Emerald (`emerald-500` / `emerald-400`)
  - Jazz Load: Amber / Jazz Red (`amber-500` / `rose-500`)
  - Stock Inventory: Cyan / Sky (`cyan-500` / `sky-400`)
- **Typography Scale:** Inter / System Font, Tabular Figures (`font-mono` / `tabular-nums`) for all monetary amounts, quantities, and balances.
- **Elevation:** Flat border-driven hierarchy (`border border-slate-800`), eliminating noisy drop-shadows.

### 6.2 Shared Component Inventory

| Component Name | Purpose | Key Variants | Keyboard / A11y Behavior | Modules Using |
| :--- | :--- | :--- | :--- | :--- |
| **`AppHeader`** | Global context & navigation | Default, Condensed | `Tab` navigates; popover closes on `Escape` | Global Shell |
| **`AppSidebar`** | Primary module navigation rail | Expanded (224px), Collapsed (64px) | Full ARIA menu roles; keyboard focus rings | Global Shell |
| **`SaveControlBar`** | Universal save action & feedback | Pristine, Dirty, Saving, Saved, Error | `Ctrl+S` shortcut triggers explicit save; `aria-live="polite"` | Expense, Jazz, Stock |
| **`CurrencyInput`** | Formatted numeric currency entry | Default, Disabled, Error, Highlight | Auto-selects on focus; formats with commas; rejects non-numeric | Expense, Jazz, Stock |
| **`StatusBadge`** | Day and transaction lifecycle states | `OPEN` (green), `CLOSED` (slate), `REOPENED` (amber), `VERIFIED` (purple) | Screen-reader text paired with color indicator | All Modules |
| **`LedgerTable`** | Dense, tabular accounting ledger | Default, Striped, Pinned First Column | `overflow-x-auto` with frozen first column on mobile/tablet | All Modules |
| **`AlertDrawer`** | Consolidates system warnings | Warning, Error, Info (Dismissible) | Focus moves to drawer on critical error; `Escape` dismisses | All Modules |
| **`ConfirmModal`** | Transactional confirmation modal | Standard, Destructive | Traps focus; `Escape` cancels; `Enter` on primary executes | All Modules |
| **`DayPickerPopover`** | Month calendar day selector | Compact 31-day calendar popover | Arrow key calendar navigation; `Enter` selects day | Global Header |

---

## 7. Application-Shell and Settings Hub Decisions

### 7.1 Shell Layout Architecture
1. **56px Fixed Global Top Header:**
   - **Left:** Application Logo & Franchise Context Pill (displays active franchise name).
   - **Center:** Active Month Selector (instant switch dropdown, eliminating the redundant "Load" button) + Active Day Selector Popover (`Day 26 (Open)`).
   - **Right:** Sync Status Indicator (Online/Offline/Syncing), Notification Bell, and User Menu (Avatar, Role Badge, Sign Out).
2. **Slim Left Navigation Rail:**
   - Width: 224px (expanded) / 64px (collapsed).
   - Contains ONLY primary navigation destinations: `Dashboard`, `Expense Ledger`, `Jazz Load`, `Stock Ledger`, `Reports Center`, `Settings Hub`, `Audit Logs`.
   - **Relocation Decision:** Day buttons (1..31), day lifecycle actions (Close/Reopen), and live clock metrics are **completely removed from the sidebar**. Day lifecycle actions are located on the module page within a guarded action panel.
3. **Responsive Unlocking:**
   - Remove `min-width: 1280px` constraint from [`src/styles.css`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/styles.css#L61) and restore standard Tailwind breakpoints (`sm: 640px`, `md: 768px`, `lg: 1024px`, `xl: 1280px`).
   - Tables wrap in `overflow-x-auto` with sticky left columns to ensure readability on counter tablets and split-screen windows.

### 7.2 Centralized Settings Hub Consolidation Mapping

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SETTINGS HUB ARCHITECTURE                       │
├────────────────────────────────────────────────────────────────────────┤
│ TAB 1: Expense & Credit Masters                                        │
│   • Expense Categories table (name, sort order, active toggle)         │
│   • Commission Categories table (name, rate, active toggle)            │
│   • Credit Parties catalog (name, opening balance, phone, status)      │
├────────────────────────────────────────────────────────────────────────┤
│ TAB 2: Jazz Load Configuration                                         │
│   • Calculation Rates (ML rate, Comm 1, Comm 2) with effective dates   │
│   • DO Names catalog & DO Lines master catalog                         │
│   • Line-to-DO Bindings configuration                                  │
│   • Legacy DO Profiles (archived)                                      │
├────────────────────────────────────────────────────────────────────────┤
│ TAB 3: Stock Inventory Catalog                                         │
│   • Stock Products table (product name, unit rate, sort order, active) │
│   • Stock Dealer Accounts (dealer name, type, opening dues, active)    │
├────────────────────────────────────────────────────────────────────────┤
│ TAB 4: Users, Access & Data Tools                                      │
│   • Local Users Management (role assignment, password reset)           │
│   • Authorized Emails list & Notification settings                     │
│   • Excel Import Tool (retained for historical data migration)         │
│   • Database Backup Export / JSON Restore                              │
└────────────────────────────────────────────────────────────────────────┘
```

- **Excel Import Decision:** Retained inside Tab 4 (`Users, Access & Data Tools`). Moving it out of the main navigation declutters daily clerk workflows while preserving historical data recovery.
- **Email Dispatch Decision:** The "Send Daily Email" buttons in daily forms will be hidden from daily clerk workflows until SMTP server credentials are provided by the franchise owner. Configuration settings will remain visible in Tab 4.

---

## 8. Phase-by-Phase Acceptance Criteria

### Phase 1 — Foundation & Application Shell
- **AC-1.1 (Responsive Shell):** Viewport scales smoothly from 768px to 1920px without horizontal document overflow (`overflow-x: hidden` on root).
- **AC-1.2 (Top Header Integration):** Global header renders active franchise, month dropdown, day popover, and user menu at 56px height.
- **AC-1.3 (Instant Month Switch):** Changing the month dropdown immediately dispatches period routing without requiring an extra "Load" click.
- **AC-1.4 (Slim Navigation Rail):** Sidebar renders 7 primary navigation links; toggles between 224px and 64px; no calendar buttons in sidebar.
- **AC-1.5 (Zero Accounting Regression):** Routing changes do not alter database connections, session auth, or query APIs.

### Phase 2 — Shared Components Library
- **AC-2.1 (Currency Input):** `CurrencyInput` displays formatted commas on blur (e.g. `136,855.00`), strips non-numeric input on paste, and updates numeric model accurately.
- **AC-2.2 (Universal Save Bar):** Displays `Pristine` (muted), `Unsaved Changes` (amber), `Saving...` (spinner), `Saved to Database` (green, only after HTTP 200).
- **AC-2.3 (Accessible Badges):** All status badges pair color with explicit text (`OPEN`, `CLOSED`, `REOPENED`) and achieve WCAG AA $\ge 4.5:1$ contrast.
- **AC-2.4 (Audit Log Fix):** `AuditLogsView` action dropdown renders without duplicate React keys or console warnings.

### Phase 3 — Expense Workspace
- **AC-3.1 (Form Rehydration):** Selecting an open day populates existing expenses, commissions, credits, and owner balances without setting `draftDirtyRef.current = true`.
- **AC-3.2 (Dual-Save Fidelity):** Background typing triggers autosave after 900ms idle; clicking "Save Day" opens verified save dialog; both clear dirty state on HTTP 200.
- **AC-3.3 (Closed Day Protection):** Closed days render all inputs as read-only; autosave is disabled; Save buttons are hidden or disabled.
- **AC-3.4 (Day 32 FINAL Governance):** FINAL month-end settlement entries only editable by owner; verify action locks period.

### Phase 4 — Jazz Load Workspace
- **AC-4.1 (Co-Visibility):** Section 1 (Daily Lifting) and Section 2 (12-Line DO Grid) render in a single viewport layout without requiring tab switching.
- **AC-4.2 (Grid Traversal):** Pressing `Enter` in DO issuance moves focus directly to the payment input of the same line or next line.
- **AC-4.3 (Dual-Save Fidelity):** Background autosave and explicit save update PostgreSQL without dropping DO profiles.
- **AC-4.4 (Rate Protection):** Modifying calculation rates in Settings updates new days only; existing saved days retain rate snapshots.

### Phase 5 — Stock Workspace
- **AC-5.1 (Dual-Stage Workflow):** Inbound Stock Lifting renders in a collapsible top section; Outbound Dealer Issuance renders as primary work area.
- **AC-5.2 (Dealer Balance Updates):** Changing dealer product quantities or cash payment updates calculated closing dues instantly.
- **AC-5.3 (Balance Transfer Integrity):** Dealer balance transfers validate source dues, execute atomic transfer in PostgreSQL, and log audit trail.
- **AC-5.4 (Reversal Safety):** Reverse transfer dialog enforces reason requirement and updates dealer dues atomically.

### Phase 6 — Settings Hub & Cleanup
- **AC-6.1 (Consolidated Settings):** All 4 settings tabs load and update catalog items via `ledgerApiClient.catalogs.*` without errors.
- **AC-6.2 (Orphaned Code Deprecation):** Deprecate duplicate `RecordsView` inside Expense; deprecate orphaned top-level `records` view.
- **AC-6.3 (RBAC Enforcement):** Non-owner users cannot access Tab 4 (Users & Access) or modify master calculation rates.

---

## 9. Regression-Test Matrix

| Test ID | Scope | Preconditions | Execution Steps | Expected Result | Automation Status | Current Status |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: |
| **REG-01** | Backend Auth | Local session active | `GET /api/v1/auth/me` | HTTP 200 with sanitized user & franchise profile | Automated (`localAuth.test.ts`) | **PASS** |
| **REG-02** | Catalog Isolation | Admin role in F1 | `GET /api/v1/catalogs/expense-categories` | Only F1 categories returned; F2 isolated | Automated (`catalogs.test.ts`) | **PASS** |
| **REG-03** | Expense Save | Day open in 2026-10 | Post expense mutation with `baseRevision` | Fact inserted, audit logged, day projections rebuilt | Automated (`transactions.test.ts`) | **PASS** |
| **REG-04** | Jazz Load Save | Active rate exists | Post lifting & DO entries | Fact saved, lifting projection updated, HTTP 200 | Automated (`transactions.test.ts`) | **PASS** |
| **REG-05** | Stock Orders | Dealer account active | Post outbound order (11 products) | Order lines inserted, dealer dues rebuilt | Automated (`transactions.test.ts`) | **PASS** |
| **REG-06** | Stock Transfers | 2 active dealers | `POST /stock/transfers` | Source due decreased, dest due increased, audit logged | Automated (`stockBalanceTransfer.test.ts`) | **PASS** |
| **REG-07** | Transfer Reversal | Existing transfer | `POST /stock/transfers/:id/reverse` | Compensating entries created, dues reverted | Automated (`stockBalanceTransfer.test.ts`) | **PASS** |
| **REG-08** | Closed Day Guard | Day closed | Attempt transaction mutation on closed day | HTTP 422 `INV_CLOSED_DAY_MUTATION` | Automated (`dayLock.ts`) | **PASS** |
| **REG-09** | Month Rollover | August closed | `POST /periods/:id/rollover` | September initialized with 30 days & Day 1 open | Automated (`closedMonthRecovery.test.ts`) | **PASS** |
| **REG-10** | Negative Stock | Closed period | Check negative stock seeds in successor | Exact negative quantities preserved with provenance | Automated (`closedMonthRecovery.test.ts`) | **PASS** |
| **REG-11** | Frontend Hydration | PostgreSQL active | Cold load Day 26 in October | Data loaded into form without triggering autosave | Automated (`PostgresPersistenceFix.test.tsx`)| **PASS** |
| **REG-12** | Stock Month Hydration| Oct 2026 loaded | `loadStockMonthPostgres("2026-10")` | All 31 days loaded, Day 26 active entries resolved | Automated (`stockClosedDayHydration.test.ts`) | **PASS** |

---

## 10. Risk Register and Blockers

| Risk ID | Severity | Discovery & Evidence | Impact | Recommended Resolution | Phase Blocked |
| :--- | :---: | :--- | :--- | :--- | :---: |
| **RSK-01** | **HIGH** | `min-width: 1280px` in `src/styles.css` L61 locks root viewport | Complete layout clipping and horizontal scroll on counter laptops/tablets | Remove 1280px lock; restore standard Tailwind breakpoints in Phase 1 | **Phase 1** |
| **RSK-02** | **MEDIUM** | Duplicate React keys in `AuditLogsView.tsx` action dropdown | 50+ console error warnings on every mount | Apply `Array.from(new Set(...))` deduplication in Phase 2 | **Phase 2** |
| **RSK-03** | **HIGH** | Monolithic component sizes (>4,000 lines in `StockLedgerModule.tsx`) | High risk of state regression during inline edits | Extract sub-components into isolated files (`StockInboundPanel`, `DealerIssuanceGrid`) | **Phase 5** |
| **RSK-04** | **LOW** | Disabled "Send Email" action in `DailyEntryForm` (`canSendEmail={false}`) | Clerk confusion over permanently disabled button | Hide email button from daily entry; keep status in Settings Hub | **Phase 3** |
| **RSK-05** | **MEDIUM** | Duplicated `HomeDashboard` inside Expense Previous Records | Redundant bundle size and confusing user navigation | Replace duplicate with direct link or unified Reports view | **Phase 3** |

---

## 11. Recommended Implementation Sequence

```
┌────────────────────────────────────────────────────────────────────────┐
│                   RECOMMENDED IMPLEMENTATION ROADMAP                   │
├────────────────────────────────────────────────────────────────────────┤
│ STEP 1: Foundation & Shell (Phase 1)                                   │
│   • Remove `min-width: 1280px` in `styles.css`.                        │
│   • Build `AppHeader` (56px) with instant month switcher & day popover.│
│   • Slim down `AppSidebar` to a 64px/224px navigation rail.            │
│   • Verify with `tsc --noEmit` and run Shell acceptance tests.         │
├────────────────────────────────────────────────────────────────────────┤
│ STEP 2: Shared Component Library (Phase 2)                             │
│   • Implement `CurrencyInput`, `StatusBadge`, and `SaveControlBar`.    │
│   • Deduplicate action options in `AuditLogsView.tsx`.                 │
│   • Verify with Vitest component tests.                                │
├────────────────────────────────────────────────────────────────────────┤
│ STEP 3: Expense Workspace Redesign (Phase 3)                           │
│   • Adopt standard 3-tab layout (`[Daily]`, `[Reports]`, `[Masters]`). │
│   • Pin Daily Cash Summary card; implement vertical keyboard travel.   │
│   • Remove duplicate `HomeDashboard` from Previous Records.            │
├────────────────────────────────────────────────────────────────────────┤
│ STEP 4: Jazz Load Workspace Redesign (Phase 4)                         │
│   • Co-locate Daily Lifting (top) and 12-Line DO Grid (center).        │
│   • Implement vertical grid keyboard traversal (`Enter`/`Tab`).        │
│   • Move historical trend tables to Reports tab.                       │
├────────────────────────────────────────────────────────────────────────┤
│ STEP 5: Stock Workspace Redesign (Phase 5)                             │
│   • Implement collapsible Inbound Lifting sub-panel.                   │
│   • Optimize Dealer Issuance & Payment Collection as primary view.     │
│   • Maintain Balance Transfer modal integration.                       │
├────────────────────────────────────────────────────────────────────────┤
│ STEP 6: Settings Hub & Final Deprecation (Phase 6)                     │
│   • Consolidate categories, rates, products, and users into 4 tabs.    │
│   • Retain Excel Import under Data Tools tab.                          │
│   • Run full backend & frontend test suites for 100% regression proof. │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 12. Explicit List of Decisions Requiring User Approval Before Coding

Prior to beginning Phase 1 implementation, explicit user confirmation is requested on the following 5 decisions:

1. **Dual-Save Architecture Retention:**  
   Confirm that the visual redesign should **retain the existing dual-save mechanism** (automatic debounced background saving + explicit "Save Day" button with progress dialog), rather than enforcing purely explicit-only or purely autosave-only behavior.
2. **Global Header & Day Selector Placement:**  
   Confirm moving the active month switcher and active day selector into the 56px global top header, allowing the left sidebar to be simplified into a pure navigation rail.
3. **Co-Visibility in Jazz Load:**  
   Confirm keeping Daily Lifting (top) and the 12 DO Grid (center) co-visible in a single vertical scrolling view on the Daily Operations tab.
4. **Excel Import Relocation:**  
   Confirm keeping the Excel Import screen available, relocated to the Settings Hub under Tab 4 (`Users, Access & Data Tools`), rather than deprecating it.
5. **Hiding Unconfigured Email Buttons:**  
   Confirm hiding the "Send Daily Email" buttons from daily entry screens until SMTP server credentials are provided.

---

### DO NOT IMPLEMENT YET

This document is an implementation-readiness specification and safety audit only. No application source code, backend APIs, database records, accounting transactions, day statuses, or genesis seed records were modified. Implementation will begin only upon explicit user authorization.
