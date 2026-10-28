# Complete Frontend Accounting UI & Persistence Architecture Audit

**Date:** 2026-09-19  
**Target Environment:** Local PostgreSQL (`franchise_prod_db` on port 5433) & React/Vite Frontend  
**Target Period:** August 2026 (`2026-08`) — Authoritative Day 1 Open, Days 2–31 Closed  
**Status:** READ-ONLY STRUCTURAL AUDIT — NO IMPLEMENTATION CHANGES MADE  

---

## 1. Complete UI Component Hierarchy

The application UI is structured as a hierarchical dashboard with three core operational accounting modules (**Expense**, **Jazz Load**, and **Stock Ledger**) managed under a unified shell in [`src/App.tsx`](file:///home/hanzlaahmad/PersonalProjects/Franchise/src/App.tsx):

```
App (src/App.tsx)
├── SelectedDateProvider (src/shared/context/SelectedDateContext.tsx)
├── SidebarDayControlsProvider (src/shared/context/SidebarDayControlsContext.tsx)
├── Top Navigation Header
│   ├── Period/Month Selector (monthId dropdown)
│   ├── View Tabs ("expenses" | "jazz-load" | "stock-ledger" | "audit-logs" | "users")
│   ├── Sync State & Status Indicator
│   └── User Role / Auth Badge / Session Actions
├── Sidebar Navigation
│   ├── UniversalCalendar (src/shared/calendar/UniversalCalendar.tsx) [Variant: mini]
│   └── UniversalDayControlBar (src/shared/dayControls/UniversalDayControlBar.tsx) [Day status, Open/Close/Reopen actions]
└── Main Content Container
    │
    ├── VIEW: "expenses"
    │   ├── Sub-Navigation Bar
    │   │   ├── "daily" (Daily Entry Form)
    │   │   ├── "previous-records" (Records View)
    │   │   ├── "expense-dashboard" (Expense Analytics & Summaries)
    │   │   ├── "expense-categories" (Catalog Manager)
    │   │   ├── "credit-parties" (Catalog Manager)
    │   │   └── "commission-categories" (Catalog Manager)
    │   │
    │   └── SUB-VIEW: "daily" → <DailyEntryForm> (src/components/DailyEntryForm.tsx)
    │       ├── Header Control Bar
    │       │   ├── Date & Day Number Indicator
    │       │   ├── Autosave Status Badge ("Autosave on" / "Autosaving..." / "Autosave off" / "Autosave failed")
    │       │   ├── "Save Now & Verify" Button (<button className="btn-primary">)
    │       │   └── "Send Email" Button (<button className="btn-secondary">)
    │       ├── Opening Balance & Notes Panel
    │       │   ├── Opening Balance (Read-only computed field)
    │       │   └── Notes Input (Controlled text input)
    │       ├── Mobile Actions Bar (Alternative layout for mobile view)
    │       ├── Commission Panel
    │       │   ├── Category Dropdown (Select from commissionOptions)
    │       │   ├── Amount Input (Controlled numeric input)
    │       │   ├── "Add Commission" Button
    │       │   └── Commission Rows Table (Category, Amount, Action Buttons: Edit, Delete)
    │       ├── Franchise Owner Balance Panel
    │       │   ├── Description Input (Controlled text input)
    │       │   ├── Owner Expense Input (Cash Out)
    │       │   ├── Cash Received Input (Cash In)
    │       │   ├── "Add Owner Entry" Button
    │       │   └── Owner Rows Table (Description, Opening, Expense, Received, Balance, Actions: Edit, Delete)
    │       ├── Credit Parties Panel
    │       │   ├── Party Dropdown (Select from partyOptions)
    │       │   ├── Loan Reason Input (Controlled text input)
    │       │   ├── Receive Reason Input (Controlled text input)
    │       │   ├── Loan Amount Input (Controlled numeric input)
    │       │   ├── Receive Amount Input (Controlled numeric input)
    │       │   ├── "Add Entry" Button
    │       │   └── Credit Rows Table (Party, Opening, Loan, Receive, Balance, Description Fields, Actions: Edit, Delete)
    │       ├── Expenses Panel
    │       │   ├── Category Dropdown (Select from categoryOptions)
    │       │   ├── Item Name Input (Controlled text input)
    │       │   ├── Description Input (Controlled text input)
    │       │   ├── Amount Input (Controlled numeric input via InputText)
    │       │   ├── "Add Expense" Button
    │       │   └── Expense Rows Table (Name, Category, Description, Amount, Actions: Edit, Delete)
    │       ├── Modals & Overlays
    │       │   ├── <SaveProgressDialog> (src/shared/components/SaveProgressDialog.tsx)
    │       │   └── Create Catalog Item Modal (Expense Category / Commission Category / Credit Party)
    │       │
    │   ├── SUB-VIEW: "previous-records" → <RecordsView> (src/components/RecordsView.tsx)
    │   ├── SUB-VIEW: "expense-dashboard" → <HomeDashboard> (src/components/HomeDashboard.tsx)
    │   └── SUB-VIEW: Catalog Managers → <CatalogManager> (src/components/CatalogManager.tsx)
    │
    ├── VIEW: "jazz-load" → <JazzLoadModule> (src/modules/jazzLoad/components/JazzLoadModule.tsx)
    │   ├── Sub-Navigation Bar ("daily" | "dashboard" | "reports" | "settings" | "backup")
    │   └── SUB-VIEW: "daily"
    │       ├── Header Control Bar (Active Rate Chips, "Save & Verify", "Save", "Recalculate", Status Badges)
    │       ├── In-Hand Lifting Card
    │       │   ├── Opening Balance (Read-only, loaded from financial seed / previous day)
    │       │   ├── ML Lifting Input (Controlled via NumberInput)
    │       │   ├── Total Lifting (Read-only calculated sum)
    │       │   ├── Today ML Issuance (Read-only sum of DO issuances)
    │       │   ├── In-Hand Balance (Read-only calculated balance)
    │       │   └── Lifting Notes (Controlled text input)
    │       ├── DO Line Entries Table (14 DO Profiles: Mirza, Arslan, Mubashir, Irfan Mirza, Hassan, Naveed, Irfan, Hasan, Free SIM, Tetas, Saram, Annie, Waseem, Abdullah)
    │       │   └── Table Columns: DO Name, Opening Base, Opening ML, Today ML Issuance, Day Total Base/ML, Payment Received Base/ML, Closing Base/ML, Comm 1, Comm 2
    │       ├── Daily Summary Card (Totals for Opening, Issuance, Payments, Closing, Commissions, Outstanding Count)
    │       └── Modals & Overlays
    │           ├── <SaveProgressDialog>
    │           └── DO Line Binding Backfill Dialog
    │
    └── VIEW: "stock-ledger" → <StockLedgerModule> (src/modules/stock/components/StockLedgerModule.tsx)
        ├── Sub-Navigation Bar ("daily" | "dashboard" | "orders" | "stock-accounts" | "catalog" | "backup")
        └── SUB-VIEW: "daily"
            ├── Header Control Bar ("Save & Verify", "Save", Status Badges)
            ├── Stock Account Selector (DO and Retailer Account Chips/Buttons)
            ├── Daily Account Card
            │   ├── Carry Forward / Opening Balance (Read-only from seed / previous day)
            │   ├── Product Movement Grid (12 Products: Retailer, Franchise, Load SIM, MBB SIM, E SIM, Shine Mobile, Mobile, Wingle, Gold Number, Retail IMZI, CS IMZI, Dongle)
            │   │   └── Inputs for Issued/Received quantities per product
            │   ├── Payment Received Input (Controlled numeric input)
            │   └── Closing Due Balance (Read-only calculated balance)
            ├── In-Hand Stock Summary (Physical quantities and valuation across all 12 products)
            └── Modals & Overlays
                └── <SaveProgressDialog>
```

---

## 2. State Ownership Map

| State Variable | Owning Component | Scope | Persistence / Rehydration Source |
|---|---|---|---|
| `view` | `App.tsx` | App shell | `useState("expenses")` |
| `monthId` | `App.tsx` / `SelectedDateContext` | App shell | Global context / URL / defaults to current month |
| `selectedDay` | `App.tsx` / `SelectedDateContext` | App shell | Global context (1..31) |
| `role` / `user` | `App.tsx` | App shell | Local session / Firebase auth fallback |
| `days` (Expense) | `App.tsx` | App-level | Rehydrated via `getAccountingPeriodWithDays` (PG) or Firestore `subscribeDays` |
| `computed` (Expense) | `App.tsx` | App-level | Derived locally via `computeMonth()` |
| `hasPendingDayChanges` | `App.tsx` | App-level | Lifted boolean flag from active child module (`DailyEntryForm`, `JazzLoadModule`, `StockLedgerModule`) |
| `closedExpenseDayKeysRef` | `App.tsx` | App-level | Synchronized Set of closed days (`${monthId}/${dayNo}`) |
| `expenseDraft` | `DailyEntryForm.tsx` | Component-local | Transient local draft state (`{ categoryId, category, name, description, amount }`) |
| `expenses` | `DailyEntryForm.tsx` | Component-local | Initialized from `initial.expenses`, modified locally by user |
| `ownerDraft` | `DailyEntryForm.tsx` | Component-local | Transient local draft state (`{ description, expense, received }`) |
| `ownerBalances` | `DailyEntryForm.tsx` | Component-local | Initialized from `initial.ownerBalances`, modified locally by user |
| `creditDraft` | `DailyEntryForm.tsx` | Component-local | Transient local draft state (`{ partyId, partyName, loanDescription, receiveDescription, loan, receive }`) |
| `credits` | `DailyEntryForm.tsx` | Component-local | Initialized from `initial.credits` / `previousDay.credits`, modified locally |
| `commissionDraft` | `DailyEntryForm.tsx` | Component-local | Transient local draft state (`{ category, amount }`) |
| `commissions` | `DailyEntryForm.tsx` | Component-local | Initialized from `initial.commissions`, modified locally |
| `notes` | `DailyEntryForm.tsx` | Component-local | Initialized from `initial.notes`, modified by user typing |
| `draftDirtyRef` | `DailyEntryForm.tsx` | Component-local | `useRef(false)`: tracks whether user actively modified drafts |
| `verifiedSave` | `DailyEntryForm.tsx`, `JazzLoadModule.tsx`, `StockLedgerModule.tsx` | Component-local | `SaveProgressState`: controls visibility of `<SaveProgressDialog>` modal |
| `jazzDays` (`days`) | `JazzLoadModule.tsx` | Component-local | Rehydrated via `getAccountingPeriodWithDays` (PG) or Firestore `subscribeJazzLoadDays` |
| `jazzDrafts` (`drafts`) | `JazzLoadModule.tsx` | Component-local | Rehydrated from `selectedDayRecord.doEntries` or initialized with DO profiles |
| `liftingOpening` | `JazzLoadModule.tsx` | Component-local | Rehydrated from `period_financial_seeds.opening_jazz_lifting` |
| `mlLifting` | `JazzLoadModule.tsx` | Component-local | Rehydrated from `selectedDayRecord.lifting.mlLifting`, modified by user |
| `stockDays` (`days`) | `StockLedgerModule.tsx` | Component-local | Rehydrated via `getAccountingPeriodWithDays` (PG) or Firestore `subscribeStockDays` |
| `stockDraft` (`draft`) | `StockLedgerModule.tsx` | Component-local | Rehydrated from `selectedDayRecord.entries[accountId]` or initialized empty |
| `openingBalances` | `StockLedgerModule.tsx` | Component-local | Rehydrated from `period_stock_product_seeds` and `period_stock_account_seeds` |

---

## 3. Data-Flow Map: Boundaries & Current Contamination

The intended clean accounting architecture defines a strict unidirectional flow:

```
[1. USER INPUT] (Keystrokes / Clicks)
       ↓
[2. LOCAL FORM DRAFT] (Uncommitted React state in active module)
       ↓
[3. EXPLICIT USER SAVE] (User clicks "Save Day" or "Add Item")
       ↓
[4. POSTGRESQL TRANSACTION API] (POST/PATCH/DELETE /api/v1/transactions/...)
       ↓
[5. SERVER VALIDATION & WRITE] (Atomic DB transaction on open day)
       ↓
[6. SERVER ENGINE CALCULATION] (Stored procedures & calculation engine)
       ↓
[7. AUTHORITATIVE PROJECTIONS] (Updated records returned to client)
       ↓
[8. UI REHYDRATION] (Client updates view from server response; draft clean)
```

### Where Boundaries Are Currently Contaminated

1. **Client-Side Shadow Calculation Pre-Empting Server Authority:**
   In `App.tsx` (`saveDay`), before sending data to the server, the client runs `replaceDay(days, day)` and `computeMonth(nextDays, ...)` using client-side JavaScript formula engines (`formulaEngine.ts`). It commits the unverified day snapshot into React state *before* the backend transaction even executes.
2. **Differential Micro-Sync instead of Atomic Transaction Intent:**
   In `expenseTransactionService.ts`, when saving an expense day, the client performs a "differential sync": it queries `GET /expenses`, `GET /commissions`, `GET /credits`, `GET /owner`, computes differences in memory, and issues multiple sequential HTTP requests (`create`, `update`, `delete`) in a loop. A single failure halfway through (e.g. 400 on an invalid category ID) leaves the day partially saved or corrupted.
3. **Background Autosave Conflating Local Editing with Database Persistence:**
   `useAutoSaveEntry` continuously debounces form state. When a user clicks "Add Expense", the client immediately schedules a background save 900ms later. If the draft contains invalid input, the user is bombarded with error popups while still trying to complete their entry.
4. **Seed Hydration Leaking into Form Dirty State:**
   When `previousDay` loads asynchronously carrying forward credit party seeds, `DailyEntryForm` merges missing rows into `credits` via `useEffect`. If not guarded by strict user-interaction checks, the difference between initial payload and hydrated payload falsely flags the form as "dirty" and triggers unsaved-changes warnings or autosaves.
5. **Legacy Firestore Shell Retained Around PostgreSQL Calls:**
   `handleVerifiedSave` wraps PostgreSQL calls, but its UI callbacks and strings were hardcoded for Firestore: `"Writing the complete day snapshot to Firestore..."` and `"Day X was saved successfully and Firestore confirmed the write."`
6. **Catalog Slug vs. UUID Foreign Key Incompatibility:**
   The frontend `activeOrFallback()` helper generates slug strings (e.g. `id: "salary"`). PostgreSQL `expense_items` and `commission_items` schemas strictly require valid UUID foreign keys (`category_id: z.string().uuid().nullable().optional()`). The frontend passes slug strings into UUID columns, immediately triggering HTTP 400 validation failures.

---

## 4. All Persistence Paths

| Module | Action | Trigger | Persistence Mechanism | Endpoint / Target | Classification |
|---|---|---|---|---|---|
| **Expense** | Manual Day Save | "Save Now & Verify" button | Explicit click | `POST /api/v1/transactions/expenses` etc. via `saveExpenseDayPostgres` | **A (PostgreSQL Transaction API)** |
| **Expense** | Autosave | Debounce timer (900ms) | Automatic (on edit) | `POST /api/v1/transactions/expenses` via `saveExpenseDayPostgres` | **A (PostgreSQL Transaction API)** |
| **Expense** | Legacy Day Save | `saveDay` (non-PG) | Automatic / Explicit | Firestore `queueDayAndSummaryWrite` | **C (Firestore Write)** |
| **Expense** | Close Day | "Close Day" in control bar | Explicit click | `POST /api/v1/periods/:id/days/:dayNo/close` | **A (PostgreSQL Transaction API)** |
| **Expense** | Reopen Day | "Reopen Day" in control bar | Explicit click | `POST /api/v1/periods/:id/days/:dayNo/reopen` | **A (PostgreSQL Transaction API)** |
| **Jazz Load** | Manual Day Save | "Save & Verify" button | Explicit click | `POST /api/v1/transactions/jazz-load/...` via `saveJazzLoadDayPostgres` | **A (PostgreSQL Transaction API)** |
| **Jazz Load** | Autosave | Debounce timer (1200ms) | Automatic (on edit) | `POST /api/v1/transactions/jazz-load/...` via `saveJazzLoadDayPostgres` | **A (PostgreSQL Transaction API)** |
| **Jazz Load** | Legacy Day Save | `saveDay` (non-PG) | Automatic / Explicit | Firestore `saveJazzLoadDay` | **C (Firestore Write)** |
| **Jazz Load** | Close Day | "Close Day" in control bar | Explicit click | `POST /api/v1/periods/:id/days/:dayNo/close` | **A (PostgreSQL Transaction API)** |
| **Stock** | Manual Account Save | "Save & Verify" button | Explicit click | `POST /api/v1/transactions/stock/...` via `saveStockDayPostgres` | **A (PostgreSQL Transaction API)** |
| **Stock** | Autosave | Debounce timer (1200ms) | Automatic (on edit) | `POST /api/v1/transactions/stock/...` via `saveStockDayPostgres` | **A (PostgreSQL Transaction API)** |
| **Stock** | Legacy Account Save | `saveEntry` (non-PG) | Automatic / Explicit | Firestore `saveStockAccountDailyDraft` | **C (Firestore Write)** |
| **Stock** | Create Order | Orders tab "Save Order" | Explicit click | `POST /api/v1/transactions/stock/orders` | **A (PostgreSQL Transaction API)** |
| **Stock** | Create Payment | Payments tab "Save Payment" | Explicit click | `POST /api/v1/transactions/stock/account-payments` | **A (PostgreSQL Transaction API)** |
| **Catalogs** | Save Catalog Item | `<CatalogManager>` modal | Explicit click | Firestore `saveCatalogItem` (Legacy) | **C (Firestore Write)** |

---

## 5. Firestore Dependency Map

Even though accounting operations for August 2026 have been routed to PostgreSQL, legacy Firestore listeners and write references remain embedded across the frontend:

### 1. Active Firestore Subscriptions (`onSnapshot` / `subscribe*`)
- `subscribeCatalogItems("expenseCategories")`: `App.tsx` (Line 2104) — **Active**
- `subscribeCatalogItems("commissionCategories")`: `App.tsx` (Line 2110) — **Active**
- `subscribeCatalogItems("creditParties")`: `App.tsx` (Line 2116) — **Active**
- `subscribeDays(monthId)`: `App.tsx` (Line 2132) — Active for non-PG periods; bypassed when `isPostgreSqlPeriod(monthId)` is true.
- `subscribeMonths()`: `App.tsx` (Line 2136) — Active for non-PG periods.
- `subscribeJazzLoadDoProfiles()`, `subscribeJazzLoadRates()`, etc.: `JazzLoadModule.tsx` (Lines 775–805) — Active for non-PG periods; bypassed for PG periods.
- `subscribeStockProducts()`, `subscribeStockAccounts()`, etc.: `StockLedgerModule.tsx` (Lines 1170–1245) — Active for non-PG periods; bypassed for PG periods.

### 2. Firestore Writes (`setDoc`, `addDoc`, `deleteDoc`, `writeBatch`)
- `src/lib/firestoreService.ts`: Contains legacy Firestore writes for days (`months/{monthId}/days/{dayNo}`), month summaries, and catalogs.
- `src/modules/jazzLoad/services/jazzLoadFirestore.ts`: Contains legacy Firestore writes for Jazz Load days and rates.
- `src/modules/stock/services/stockFirestore.ts`: Contains legacy Firestore writes for Stock days, orders, and payments.

### 3. UI Residuals Mentioning Firestore
- `DailyEntryForm.tsx` (Line 596): `"Writing the complete day snapshot to Firestore and waiting for confirmation..."`
- `DailyEntryForm.tsx` (Line 602): `"Day ${dayNo} was saved successfully and Firestore confirmed the write."`
- `DailyEntryForm.tsx` (Line 604): `"Firestore did not confirm the save."`
- `JazzLoadModule.tsx` (Line 2009): `"Writing the full day to Firestore and waiting for confirmation..."`
- `JazzLoadModule.tsx` (Line 2012): `"Jazz Load day ${selectedDay} was saved successfully and Firestore confirmed the write."`
- `JazzLoadModule.tsx` (Line 2014): `"Firestore did not confirm the save."`
- `StockLedgerModule.tsx` (Line 1411): `"Writing the selected account entry to Firestore and waiting for confirmation..."`
- `StockLedgerModule.tsx` (Line 1414): `"Stock day ${selectedDay} was saved successfully and Firestore confirmed the write."`
- `StockLedgerModule.tsx` (Line 1416): `"Firestore did not confirm the save."`

---

## 6. Current Save Call Chains (Step-by-Step)

### Call Chain 1: Expense Manual Save ("Save Now & Verify")
1. **User Action:** User clicks `<button className="btn-primary">Save Now & Verify</button>`.
2. **Component Handler:** `DailyEntryForm.handleVerifiedSave()` executes.
3. **Modal Initialization:** Sets `verifiedSave = { status: "saving", title: "Saving Expense Day", message: "Writing the complete day snapshot to Firestore..." }`.
4. **App Callback:** Awaits `onSave(payload, { awaitRemote: true })` $\rightarrow$ calls `App.saveDay(day, options)`.
5. **Period Routing Check:** `isPostgreSqlPeriod("2026-08")` evaluates to `true`.
6. **Backend Sync Service:** Calls `saveExpenseDayPostgres(monthId, day)`.
7. **Day Resolution:** Calls `resolveAccountingDayId("2026-08", 1)` $\rightarrow$ returns Day 1 UUID (`5fd6bee1-7f5a-4e14-8843-c43bea594eb9`).
8. **Differential Loop:**
   - Fetches existing items via `GET /api/v1/transactions/expenses?day_id=...`.
   - Iterates through `input.expenses`:
     - If empty: performs 0 network mutations.
     - If items exist: calls `POST /api/v1/transactions/expenses` with `{ day_id, category_id, item_name, amount, ... }`.
   - Performs equivalent loops for commissions, credits, and owner balances.
9. **Return to UI:**
   - If loop succeeds: `handleVerifiedSave` executes `setVerifiedSave({ status: "success", title: "Save Confirmed", message: "Day 1 was saved successfully and Firestore confirmed the write." })`.
   - If any API call fails: `handleVerifiedSave` catches error and executes `setVerifiedSave({ status: "error", title: "Save Failed", message: error.message })`.

### Call Chain 2: Expense Autosave (Debounce)
1. **User Action:** User types into Notes, adds an expense row, or edits a field.
2. **Dirty Trigger:** Component calls `markDraftDirty()`, setting `draftDirtyRef.current = true`.
3. **Hook Evaluation:** `useAutoSaveEntry` observes `enabled: !disabled && draftDirtyRef.current`.
4. **Timer:** 900ms debounce timer expires.
5. **Execution:** Calls `save(nextPayload)` $\rightarrow$ `onSave(nextPayload, { silent: true })` $\rightarrow$ `saveExpenseDayPostgres`.
6. **Error / Success:** If error occurs, sets `autoSaveStatus = "error"`. If success, sets `autoSaveStatus = "saved"` and clears `draftDirtyRef.current = false`.

### Call Chain 3: Jazz Load Save
1. **User Action:** User edits ML lifting or DO issuance and clicks "Save & Verify".
2. **Component Handler:** `JazzLoadModule.handleVerifiedSave()` $\rightarrow$ calls `saveDay("open", { awaitRemote: true })`.
3. **Period Routing Check:** `isPostgreSqlPeriod("2026-08")` is true $\rightarrow$ calls `saveJazzLoadDayPostgres(monthId, day, doProfiles)`.
4. **Backend Sync:**
   - If `mlLifting > 0`: calls `POST /api/v1/transactions/jazz-load/lifting`.
   - For each DO with activity: calls `POST /api/v1/transactions/jazz-load/do`.
5. **Completion:** Displays `<SaveProgressDialog>` with success/error.

### Call Chain 4: Stock Save
1. **User Action:** User edits product movement quantities for a DO account and clicks "Save & Verify".
2. **Component Handler:** `StockLedgerModule.handleVerifiedSave()` $\rightarrow$ calls `saveEntry(snapshot, { awaitRemote: true })`.
3. **Period Routing Check:** `isPostgreSqlPeriod("2026-08")` is true $\rightarrow$ calls `saveStockDayPostgres(monthId, dayNo, draft, products)`.
4. **Backend Sync:**
   - If order lines exist: calls `POST /api/v1/transactions/stock/orders` (`direction: "outbound"`).
   - If payment exists: calls `POST /api/v1/transactions/stock/account-payments`.
5. **Completion:** Displays `<SaveProgressDialog>` with success/error.

---

## 7. Current Dirty-State Call Chains

1. **DailyEntryForm:**
   - Dirty flag: `draftDirtyRef = useRef(false)`.
   - Set dirty: `markDraftDirty()` is invoked on user input (`addExpense`, `editExpense`, `deleteExpense`, `addOwnerRow`, `editOwnerRow`, `deleteOwnerRow`, `addCredit`, `deleteCredit`, `updateCreditDescription`, `addCommission`, `editCommission`, `deleteCommission`, notes `onChange`).
   - Clear dirty: Reset on day change (`useEffect [dayNo]`), on successful manual save, on successful verified save, and on successful autosave.
   - Pending changes evaluation:
     ```ts
     const hasPendingChanges = saveBaselineReady && draftDirtyRef.current && (
       saveInFlight ||
       hasPendingAutoSave ||
       JSON.stringify(payload) !== lastSavedRef.current
     );
     ```
   - App communication: `onPendingStateChange?.(hasPendingChanges)` with unmount cleanup `return () => onPendingStateChange?.(false)`.
2. **JazzLoadModule:**
   - Dirty flag: `draftDirtyRef = useRef(false)`.
   - Set dirty: `markDraftDirty()` is invoked when user changes lifting input, lifting notes, or DO entry drafts (`setDraft`).
   - Clear dirty: Reset on day change, on remote draft state hydration, and after save.
   - Pending changes evaluation:
     ```ts
     const hasPendingJazzChanges = draftDirtyRef.current && (
       autoSaveStatus === "typing" ||
       autoSaveStatus === "saving" ||
       autoSaveStatus === "unsaved" ||
       recalculating
     );
     ```
   - App communication: `onPendingStateChange?.(hasPendingJazzChanges)` with unmount cleanup.
3. **StockLedgerModule:**
   - Dirty flag: `stockDraftDirtyRef = useRef(false)`.
   - Set dirty: `markStockDraftDirty()` is invoked on `updateStockDraft()`.
   - Clear dirty: Reset on day/account change, on remote draft state hydration, and after save.
   - Pending changes evaluation:
     ```ts
     const hasPendingStockChanges = stockDraftDirtyRef.current && (
       stockEntryAutoSave.autoSaveStatus === "typing" ||
       stockEntryAutoSave.autoSaveStatus === "saving" ||
       stockEntryAutoSave.autoSaveStatus === "unsaved"
     );
     ```
   - App communication: `onPendingStateChange?.(hasPendingStockChanges)` with unmount cleanup.

---

## 8. Exact Root Cause: "Save Confirmed" Without User Edits

### Symptoms
When the user views Day 1 (without modifying any fields) and clicks "Save Now & Verify", the modal displays:
```
Save Confirmed
Day 1 was saved successfully and Firestore confirmed the write.
```

### Root Cause Mechanism
1. **Unconditional Execution on Empty State:**
   The "Save Now & Verify" button in `DailyEntryForm.tsx` (line 959) is not disabled when there are 0 uncommitted edits. Clicking it executes `handleVerifiedSave()`.
2. **Zero-Mutation Success in PostgreSQL Sync:**
   `handleVerifiedSave()` passes `payload` (where `expenses: []`, `commissions: []`, etc.) to `saveExpenseDayPostgres()`.
   `saveExpenseDayPostgres()` queries existing transactions in PostgreSQL (which is 0 rows).
   It loops through 0 expenses, 0 commissions, 0 credits with activity, and 0 owner rows.
   It executes zero HTTP mutations, encounters zero errors, and immediately returns `{ success: true }`.
3. **Hardcoded Firestore Success Message:**
   In `DailyEntryForm.tsx` (line 602), the success handler contains the hardcoded string:
   ```ts
   setVerifiedSave({
     status: "success",
     title: "Save Confirmed",
     message: `Day ${dayNo} was saved successfully and Firestore confirmed the write.`
   });
   ```
   The dialog pops up displaying this legacy message even though PostgreSQL was the datastore and no actual data was written.

---

## 9. Exact Root Cause: HTTP 400 on `POST /api/v1/transactions/expenses`

### Symptoms
When attempting "Add Data" (adding an expense row and saving):
```
Save Failed
Request validation failed.
POST /api/v1/transactions/expenses → HTTP 400
```

### Root Cause Mechanism
1. **Empty Database Catalog:**
   The PostgreSQL `expense_categories` catalog table contains **0 rows** in production (`franchise_prod_db`).
2. **Frontend Fallback to Non-UUID Slugs:**
   Because no categories exist in the database, `DailyEntryForm.tsx` (line 259) invokes:
   ```ts
   const categoryOptions = activeOrFallback(expenseCategories, [
     "Salary", "Refreshment", "IMSI", "Utilities", "Rent", "General"
   ]);
   ```
   The `activeOrFallback()` helper generates slug identifiers:
   ```ts
   return fallback.map((name, index) => ({
     id: slug(name), // "salary", "refreshment", "imsi", "utilities", "rent", "general"
     name,
     active: true,
     sortOrder: index + 1
   }));
   ```
3. **Form Selection:**
   When the user adds an expense, `expenseDraft.categoryId` is assigned `"salary"`.
4. **Invalid Request Payload:**
   `saveExpenseDayPostgres()` sends the raw draft category ID to the backend:
   ```ts
   await ledgerApiClient.expenses.create({
     day_id: dayId,
     category_id: exp.categoryId ?? null, // Sends "salary"
     category_name_snapshot: exp.category, // "Salary"
     item_name: itemName,
     description: exp.description || null,
     amount: Number(exp.amount)
   });
   ```
5. **Strict Backend Zod Schema Rejection:**
   In `backend/src/transactions/schemas.ts` (line 50):
   ```ts
   export const ExpenseItemCreateSchema = z.object({
     ...IdempotencyFields,
     day_id: z.string().uuid(),
     category_id: z.string().uuid().nullable().optional(), // STRICT UUID REQUIREMENT
     category_name_snapshot: z.string().max(100).optional(),
     item_name: z.string().min(1).max(150),
     description: z.string().max(1000).nullable().optional(),
     amount: z.number().positive({ message: "amount must be greater than 0" })
   });
   ```
   Zod fails validation because `"salary"` is not a valid UUID string.
6. **Backend 400 Response:**
   The backend returns:
   ```json
   {
     "success": false,
     "error": {
       "code": "VALIDATION_ERROR",
       "message": "Request validation failed.",
       "details": [
         {
           "validation": "uuid",
           "code": "invalid_string",
           "message": "Invalid uuid",
           "path": ["category_id"]
         }
       ]
     }
   }
   ```
7. **UI Error Popup:**
   `ledgerApiClient` throws `Error("Request validation failed.")`, which `handleVerifiedSave()` catches and displays in `<SaveProgressDialog>` as `Save Failed: Request validation failed.`
8. **Identical Risk in Commissions:**
   `CommissionItemCreateSchema` (line 76) likewise enforces `category_id: z.string().uuid().nullable().optional()`. Adding a commission item using slug categories will trigger the exact same HTTP 400 failure.

---

## 10. Code That Should Be Removed Entirely

Rather than patching or adding more guards to the current save mechanism, the following legacy components must be cleanly decommissioned:

### 1. Old Firestore Accounting Saves
- In `src/lib/firestoreService.ts`:
  - `queueDayAndSummaryWrite()`
  - `saveDayToFirestore()`
  - `saveMonthSummary()`
  - `createMonth()`
  - `closeDayInFirestore()`
  - `reopenDayInFirestore()`
- In `src/modules/jazzLoad/services/jazzLoadFirestore.ts`:
  - `saveJazzLoadDay()`
  - `closeJazzLoadDaysExceptToday()`
  - `reopenJazzLoadDaysFor15Minutes()`
- In `src/modules/stock/services/stockFirestore.ts`:
  - `saveStockDay()`
  - `saveStockAccountDailyDraft()`

### 2. Automatic Save-on-Mount & Save-on-Hydration Machinery
- `useAutoSaveEntry.ts` across all three modules:
  - Remove `useAutoSaveEntry` from `DailyEntryForm.tsx`.
  - Remove `useAutoSaveEntry` from `JazzLoadModule.tsx`.
  - Remove `stockEntryAutoSave` from `StockLedgerModule.tsx`.
- Remove all autosave UI indicators ("Autosave on", "Autosaving...", "Autosave failed", "Autosave off").
- Remove JSON string diffing (`lastSavedRef.current = JSON.stringify(...)`) used to guess whether state is dirty.

### 3. Client-Side Pre-Emptive Mutation
- In `App.tsx` (`saveDay`):
  - Remove `replaceDay(days, day)` and `setDays(nextDays)` before backend confirmation.
  - Remove `computeMonth(nextDays, ...)` pre-calculation before backend confirmation.

### 4. Legacy Firestore Feedback Modals
- Remove `<SaveProgressDialog>` instances that contain hardcoded references to Firestore writes and confirmations.

### 5. Multi-Request Differential Sync Loops
- Replace `saveExpenseDayPostgres`, `saveJazzLoadDayPostgres`, and `saveStockDayPostgres` client-side diff loops with atomic, purpose-built batch/transaction operations.

---

## 11. Proposed Clean PostgreSQL Persistence Architecture

The proposed persistence architecture cleanly separates **Form Draft State** from **Committed Ledger State**:

```
┌─────────────────────────────────────────────────────────┐
│                    USER INTERACTION                     │
│  • User enters text / numbers in local form controls   │
│  • Local React state updates immediately (Draft)       │
│  • Form marks itself: hasUnsavedChanges = true          │
│  • NO background network requests (NO autosave)         │
│  • NO saves on mount, rehydration, or date change       │
└────────────────────────────┬────────────────────────────┘
                             │
                  User clicks "Save Day"
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│                 CLIENT PERSISTENCE HANDLER              │
│  • Validates local draft (positive amounts, etc.)       │
│  • Sanitizes foreign keys: category_id is UUID or null  │
│  • Disables Save button & shows clean loading spinner   │
│  • Sends single atomic batch or direct transaction      │
│    POST /api/v1/transactions/expenses/batch             │
│    (or sequential atomic operations with Idempotency)   │
└────────────────────────────┬────────────────────────────┘
                             │
                   HTTP Request to Backend
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│                POSTGRESQL BACKEND ENGINE                │
│  1. Verifies accounting_days.status === 'open'          │
│  2. Validates payload via Zod schemas                   │
│  3. Starts atomic PostgreSQL transaction (BEGIN)        │
│  4. Writes operational rows (expense_items, etc.)       │
│  5. Executes calculation engine for the day             │
│  6. Writes updated day projections                      │
│  7. Commits transaction (COMMIT)                        │
│  8. Returns: { success: true, data: { projections } }   │
└────────────────────────────┬────────────────────────────┘
                             │
                    HTTP 200/201 Response
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│                  UI REHYDRATION & RESET                 │
│  • UI receives authoritative updated projections        │
│  • Updates displayed balances directly from server      │
│  • Resets hasUnsavedChanges = false                     │
│  • Displays clean banner: "Saved to PostgreSQL ledger"  │
└─────────────────────────────────────────────────────────┘
```

### Key Architectural Tenets

1. **Only Explicit User Action Initiates Persistence:**
   - No timers, no debounces, no effects triggering network writes.
   - Initial loading, seed hydration, day switching, and catalog loading NEVER trigger persistence.
2. **Clean Category / Foreign Key Handling:**
   - Catalog options loaded from PostgreSQL `GET /api/v1/catalogs/...` providing true UUIDs.
   - If a category is unassigned or fallback text is used, `category_id` is passed as `null` and `category_name_snapshot` holds the label string, fully adhering to `ExpenseItemCreateSchema`.
3. **Single Authoritative Source of Truth:**
   - The client does not calculate closing balances or cash flows. The backend calculation engine (`engine.ts`) calculates them upon transaction write and returns authoritative projections.
4. **Idempotency & Optimistic Concurrency:**
   - Every mutation sends a unique `clientMutationId` to prevent duplicate submissions on double clicks.
   - Updates send `baseRevision` to prevent race conditions.
5. **Day Closed/Open Invariant:**
   - When `accounting_days.status !== 'open'`, all input fields and the Save button are rendered disabled in the DOM. Server-side triggers enforce ledger immutability as a second defense.
6. **Unsaved Changes Navigation Protection:**
   - Navigation warning is active ONLY when `hasUnsavedChanges === true` (user has uncommitted local draft changes).
   - Once saved, `hasUnsavedChanges` is immediately set to `false`, allowing seamless navigation without confirmation modals.

---

## 12. Migration & Removal Plan

1. **Phase 1: Catalog Clean-Up & UUID Alignment**
   - Wire `App.tsx` to load expense categories and commission categories from PostgreSQL catalogs API (`GET /api/v1/catalogs/expense-categories` and `commission-categories`).
   - Seed standard default categories into PostgreSQL `expense_categories` and `commission_categories` tables so that real UUIDs exist.
   - Update `DailyEntryForm.tsx` so that fallback categories pass `category_id: null` instead of slug strings.
2. **Phase 2: Decommission Autosave & Legacy Hooks**
   - Remove `useAutoSaveEntry` from `DailyEntryForm.tsx`, `JazzLoadModule.tsx`, and `StockLedgerModule.tsx`.
   - Remove autosave status chips from headers.
   - Replace complex `lastSavedRef` JSON diffing with a simple, robust `isDirty` boolean flag managed strictly by user input events.
3. **Phase 3: Clean Save Handlers & Message Modernization**
   - Replace `handleVerifiedSave` in each module with an explicit, clean `handleSave()`.
   - Remove all text referencing Firestore from UI dialogs and status banners; replace with `"Saved to PostgreSQL ledger"`.
   - Ensure the Save button is disabled when `!isDirty` or when day is closed.
4. **Phase 4: Purge Legacy Firestore Accounting Writes**
   - Decommission `queueDayAndSummaryWrite`, `saveJazzLoadDay`, and `saveStockDay` from frontend code for PostgreSQL periods.
   - Guarantee zero Firestore writes for all periods $\ge$ August 2026.

---

## 13. Risks and Regression Points

1. **Unsaved Edits on Navigation:**
   Without autosave, users who type values and navigate away without saving will lose their inputs unless the navigation guard intercepts them.
   *Mitigation:* Retain the simple `window.confirm("You have unsaved changes. Leave anyway?")` navigation guard tied strictly to `isDirty`.
2. **Credit Party Closing Balance Carried Forward:**
   Credit parties rely on carried-forward opening balances from Day 0 seeds or previous days.
   *Mitigation:* Keep rehydration of previous day credit balances completely decoupled from the draft dirty flag.
3. **Concurrent Multi-Tab Edits:**
   If a user edits the same day in two tabs, optimistic concurrency (`baseRevision`) will reject stale updates.
   *Mitigation:* Catch revision conflicts (409) and prompt the user to reload the latest day state.

---

## 14. Comprehensive Test Plan

1. **Unit Tests:**
   - Test that `DailyEntryForm` does NOT set `isDirty = true` upon mount or seed rehydration.
   - Test that typing into Notes, Expense Name, or Amount sets `isDirty = true`.
   - Test that saving resets `isDirty = false`.
   - Test that `category_id` is either a valid UUID or `null` (never a slug string).
2. **Integration Tests (API & Schema):**
   - Test `POST /api/v1/transactions/expenses` with valid UUID `category_id` $\rightarrow$ 201 Created.
   - Test `POST /api/v1/transactions/expenses` with `category_id: null` and `category_name_snapshot: "Salary"` $\rightarrow$ 201 Created.
   - Test `POST /api/v1/transactions/commissions` with valid UUID or null $\rightarrow$ 201 Created.
3. **Lifecycle & Regression Tests:**
   - Verify that loading August 2026 Day 1 produces 0 network save requests.
   - Verify that clicking Save without edits is either disabled or a clean no-op.
   - Verify that adding an expense row and saving succeeds with 201 and updates financial projections.
   - Verify zero Firestore requests occur throughout the workflow.

---

## DO NOT IMPLEMENT YET

**Explicit Confirmation:**
No implementation changes, code removals, or database modifications were made during this audit phase.

### Current System Verification:
- **Frontend Test Suite:** `npm test -- --run` $\rightarrow$ **230 passed, 0 failed, 22 skipped**.
- **Backend Test Suite:** `npm --prefix backend test` $\rightarrow$ **170 passed, 0 failed**.
- **Production Build:** `npm run build` (`tsc -b && vite build`) $\rightarrow$ **Success (Exit code 0)**.
- **Production Database Metrics (`franchise_prod_db` on port 5433):**
  - Operational transaction rows: **0 rows** across all 10 operational tables.
  - Verified genesis seeds: **53 / 53 intact**.
  - August 2026 accounting days: **Day 1 open, Days 2–31 closed**.
  - Production accounting data is **100% untouched**.
