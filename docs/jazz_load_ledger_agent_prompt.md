# Agent Command Prompt: Build Jazz Load Ledger Module

You are a senior full-stack developer, Firebase architect, product engineer, QA reviewer, and business-ledger system designer. Your task is to implement a complete **Jazz Load Ledger** module inside the existing franchise expense system.

This must be a **software-native financial ledger**, not a copied manual table. Build clean business logic, clean UI, clean Firestore storage, proper validation, owner-managed settings, offline-safe behavior, reports, backup support, and client-ready workflow.

## Core instruction

Build Jazz Load Ledger as a **separate module** inside the app.

Do not merge it with the existing expense tracker data.

Do not combine Jazz Load totals with normal expenses, commissions, owner balances, credit parties, or any existing ledger totals.

Use shared app utilities only where useful, such as authentication, roles, layout, formatting, Firestore helpers, offline persistence, backup/export helpers, and UI components.

The actual Jazz Load business data, calculations, routes, dashboards, reports, settings, and Firestore collections must remain separate.

The final architecture should follow this flow:

```text
User Entry → Validation → Calculation Engine → Save Ledger Record → Update Daily Summary → Update Monthly Summary → Generate Reports
```

## Business goal

The app should allow a shop/operator to maintain daily Jazz Load records in a structured system. The owner should be able to view reports remotely, manage calculation percentages, check balances, review daily and monthly performance, export/backup data, and control user access.

The system should support:

- Daily DO-wise records
- DO opening balances
- Today Jazz Load issuance
- Day total
- Payment received
- Closing balances
- Jazz Load calculated values using owner-managed percentages
- Daily lifting as one single amount
- In-hand balance calculation
- Commission/calculation rules controlled by owner settings
- Monthly summary
- DO balance report
- Payment report
- Jazz Load issuance report
- Lifting report
- Commission report
- Separate backup/export grouping
- Offline-safe daily entry where possible
- Owner/admin/viewer role behavior

## Important product rules

1. Jazz Load Ledger is separate from the normal expense tracker.
2. Do not automatically merge Jazz Load data into existing expense totals.
3. Do not hardcode percentage values.
4. Owner must manage percentage rates from dashboard/settings.
5. Users enter base amounts only.
6. Jazz Load/calculated values are system-generated and read-only.
7. Store applied rate snapshots with each saved entry.
8. Old saved records must not change when owner updates rates later.
9. All calculation logic must live in a centralized calculation service.
10. UI components must display calculated values but must not duplicate business formulas.
11. Lifting must be handled as one single field, not multiple lifting fields.
12. If no active calculation rate exists, block financial entry and show a clear configuration warning.
13. Every number must be validated before saving.
14. Use Firestore batch writes/transactions where data consistency matters.
15. Support offline persistence, but make sync status clear.

## Suggested routes

Add separate navigation entries/routes:

```text
/jazz-load
/jazz-load/dashboard
/jazz-load/daily-entry
/jazz-load/reports/do-balances
/jazz-load/reports/ml-issuance
/jazz-load/reports/payments
/jazz-load/reports/lifting
/jazz-load/reports/commission
/jazz-load/settings/rates
/jazz-load/backup
```

If the app already uses internal tabs instead of routes, use a separate sidebar section called:

```text
Jazz Load Ledger
```

Suggested menu:

```text
Jazz Load Dashboard
Daily DO Entry
DO Balances
Jazz Load Issuance
Payments Received
Lifting Summary
Commission Report
Settings
Backup / Export
```

## User roles

Reuse the existing app role system if available.

### Owner

Owner can:

- Create/load Jazz Load months
- Add/edit/delete daily Jazz Load records
- Manage DO list if needed
- Manage rates and calculation settings
- View all reports
- Export data
- Import/restore backup if backup restore exists
- Close/reopen Jazz Load month
- Correct old days
- Manage access if existing app allows

### Admin

Admin can:

- Add/edit current daily records
- View reports
- Export allowed reports if owner allows
- Manage daily entries
- View past records

Admin should not:

- Change owner-managed calculation rates unless explicitly allowed
- Edit closed month unless owner allows
- Delete historical records unless owner allows

### Viewer

Viewer can:

- View dashboard and reports only

Viewer must not:

- Add entries
- Edit entries
- Delete entries
- Change rates
- Close/reopen months
- Restore backups

### Inactive/unauthorized user

Inactive/unauthorized user must not access Jazz Load data.

Do not rely only on hidden frontend buttons. Firestore rules must enforce permissions.

## Main data model concept

A Jazz Load month contains daily records. Each day contains multiple DO entries and one daily lifting/summary section.

A DO entry represents one DO/person/line record for a specific day.

Each amount that needs Jazz Load/calculated value should use a dual-value model:

```ts
type CalculatedMoney = {
  baseAmount: number;
  calculatedAmount: number;
  appliedRateId: string;
  appliedRateName: string;
  appliedRatePercentage: number;
  calculatedAt: Timestamp;
};
```

The user enters only `baseAmount`. The system calculates `calculatedAmount` using the active owner-managed rate.

Do not allow manual editing of calculated Jazz Load values.

## Owner-managed rate settings

Create a dedicated owner settings area for Jazz Load calculation rates.

Example type:

```ts
type JazzLoadRateConfig = {
  id: string;
  name: string;
  type: "ml_addition" | "commission" | "adjustment" | "custom";
  percentage: number;
  active: boolean;
  description?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

Owner should be able to:

- Create rate
- Edit rate
- Activate/deactivate rate
- Set percentage
- Set rate type
- View rate history

Rules:

- Do not hardcode percentage values.
- Default UI may show empty state: “No active Jazz Load rate configured.”
- If no active Jazz Load addition rate exists, block daily financial entry.
- If commission rates are needed, manage them separately from Jazz Load addition rates.
- When saving a ledger record, snapshot the rate into the record.
- Never recalculate old records using a new active rate.

## Calculation engine

Create a centralized service/module, for example:

```text
src/modules/jazzLoad/services/jazzLoadCalculations.ts
```

or similar according to existing project structure.

Do not put calculation formulas inside React components.

Suggested functions:

```ts
calculateAmountWithRate(baseAmount: number, rate: JazzLoadRateConfig): CalculatedMoney
calculateDoRow(input: DoEntryInput, activeRates: ActiveJazzLoadRates): DoEntryCalculated
calculateDailyLifting(input: DailyLiftingInput): DailyLiftingCalculated
calculateDailySummary(day: JazzLoadDay): JazzLoadDailySummary
calculateMonthlySummary(days: JazzLoadDay[]): JazzLoadMonthlySummary
carryForwardDoOpening(previousDayClosing: number): number
validateJazzLoadEntry(input: unknown): ValidationResult
```

## Jazz Load/calculated amount rule

Use owner-managed rate.

Formula:

```text
calculatedAmount = baseAmount + (baseAmount * appliedRatePercentage / 100)
```

Example only:

```text
If base amount is 100000 and active rate is 2.6%, calculated amount becomes 102600.
```

Do not hardcode this percentage. This is only an example.

## DO entry fields

Each daily DO entry should contain:

```ts
type JazzLoadDoEntry = {
  id: string;
  doName: string;
  doLine?: string;

  openingBalance: CalculatedMoney;
  todayMlIssuance: CalculatedMoney;
  dayTotal: CalculatedMoney;
  paymentReceived: CalculatedMoney;
  closingBalance: CalculatedMoney;

  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

If calculated values are required for opening balance, day total, payment received, and closing balance, display them as read-only calculated columns.

The UI should show base input + calculated output clearly.

Example UI concept:

```text
DO Name | DO Line | Opening Base | Opening Jazz Load | Issuance Base | Issuance Jazz Load | Day Total Base | Day Total Jazz Load | Payment Base | Payment Jazz Load | Closing Base | Closing Jazz Load
```

But the user should only edit base fields where entry is required.

## DO row formulas

Base formulas:

```text
dayTotal.baseAmount = openingBalance.baseAmount + todayMlIssuance.baseAmount
closingBalance.baseAmount = dayTotal.baseAmount - paymentReceived.baseAmount
```

Calculated/Jazz Load values should be generated using the applied active rate snapshot.

The exact strategy can be:

```text
Calculate each important amount from its base value using the active Jazz Load rate.
```

or:

```text
Calculate dayTotal and closingBalance from the already calculated Jazz Load values.
```

Choose the method that matches business expectations best, but keep it consistent and documented in code comments.

Recommended stable approach:

```text
1. Compute base totals first.
2. Apply rate to each final base amount where Jazz Load display/reporting is required.
3. Store both base and calculated values.
```

This avoids compounding percentage errors.

## Daily lifting section

Lifting should be one single field only.

Do not create separate first lifting and second lifting fields.

Daily lifting fields:

```ts
type JazzLoadDailyLifting = {
  openingBalance: number;
  mlLifting: number;
  totalBalance: number;
  todayMlIssuance: number;
  inHandBalance: number;
};
```

Formulas:

```text
totalBalance = openingBalance + mlLifting
inHandBalance = totalBalance - todayMlIssuance
```

`todayMlIssuance` should preferably be derived from the day’s DO issuance total, not manually duplicated, unless the business explicitly requires manual override.

Recommended:

```text
Daily lifting Today Jazz Load Issuance = sum of all DO todayMlIssuance values for that day.
```

If manual override is needed, implement owner-only override with audit note.

## Carry-forward behavior

The system should carry closing balances forward.

Recommended logic:

```text
Day 1 opening balance is manually entered or loaded from previous month closing if available.
Day 2 opening balance comes from Day 1 closing balance.
Day 3 opening balance comes from Day 2 closing balance.
...
```

For DO entries:

```text
Each DO’s next-day opening balance should come from the same DO’s previous-day closing balance.
```

Match by stable DO ID if DO catalog exists. If no DO catalog exists, match by normalized DO name + line.

Recommended: create a DO catalog.

```ts
type JazzLoadDoProfile = {
  id: string;
  name: string;
  line?: string;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

This prevents spelling mismatch issues.

## DO catalog

Add optional DO management if useful.

Owner/admin can create DO profiles:

```text
DO Name
DO Line
Active/Inactive
Notes
```

Daily entry should allow selecting existing DOs from dropdown, while still allowing owner/admin to add new DO if permitted.

Use DO ID in stored records to prevent duplicate/misspelled DO names.

## Month structure

A Jazz Load month should have:

```ts
type JazzLoadMonth = {
  id: string; // YYYY-MM
  label: string;
  status: "open" | "closed";
  openingBalance?: number;
  closingBalance?: number;
  totalMlIssuance?: number;
  totalPayments?: number;
  totalLifting?: number;
  totalCommission?: number;
  createdBy: string;
  updatedBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt?: Timestamp;
  closedBy?: string;
};
```

A day should have:

```ts
type JazzLoadDay = {
  id: string; // day number as string or full date
  monthId: string;
  dayNo: number;
  date: string;
  status: "open" | "closed";
  doEntries: JazzLoadDoEntry[];
  lifting: JazzLoadDailyLifting;
  summary: JazzLoadDailySummary;
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt?: Timestamp;
  closedBy?: string;
};
```

## Firestore structure

Keep Jazz Load data separate.

Recommended structure:

```text
jazzLoadSettings/rates/items/{rateId}
jazzLoadSettings/doProfiles/items/{doId}
jazzLoadMonths/{monthId}
jazzLoadMonths/{monthId}/days/{dayNo}
jazzLoadMonths/{monthId}/days/{dayNo}/doEntries/{entryId}
jazzLoadMonths/{monthId}/summary/monthly
jazzLoadMonths/{monthId}/audit/{eventId}
```

Do not store Jazz Load records under existing expense collections.

Do not store existing expense records under Jazz Load collections.

## Save strategy

When saving a day:

1. Validate all input.
2. Fetch active rate settings.
3. Calculate all computed values through calculation service.
4. Store base + calculated values + applied rate snapshot.
5. Update day summary.
6. Update month summary.
7. Write audit log.
8. Show save/sync status.

Use Firestore batch writes or transactions when saving multiple related records.

Avoid partial saves that update DO entries but not summary.

## Validation rules

Validate before saving:

- Month ID must be valid.
- Day number must be valid.
- DO name/profile required.
- Base amounts must be numbers.
- Negative values must be blocked unless business allows them.
- Rate must exist and be active.
- Percentage must be valid number.
- Payment received must not accidentally create invalid closing balance unless allowed.
- Duplicate DO entries for the same day should be blocked or clearly merged by user confirmation.
- Closed days should not be editable except by owner.
- Closed months should not be editable unless reopened by owner.
- Viewer cannot save.
- Inactive users cannot save.

Handle empty string inputs safely. Do not allow NaN.

## UI behavior

Daily Entry page should include:

- Month selector
- Day selector
- Day status
- Online/offline/sync status
- Active rate display
- DO entries table
- Add DO row button
- Remove row button with confirmation
- Read-only calculated Jazz Load columns
- Daily lifting card
- Daily summary card
- Save status
- Close day button
- Reopen day button for owner if needed
- Notes field

Owner should see active rate clearly, for example:

```text
Active Jazz Load Rate: 2.6% — applied to new entries only
```

If rate is missing:

```text
No active Jazz Load rate configured. Ask owner to configure Jazz Load rate settings before entering records.
```

Do not let the UI silently calculate with zero rate.

## Dashboard

Jazz Load Dashboard should show:

- Selected month
- Month status
- Total Jazz Load issuance
- Total payments received
- Total lifting
- In-hand balance
- Total outstanding closing balance
- Total commission if configured
- Daily trend chart
- DO balance summary
- Highest outstanding DOs
- Missing days
- Closed/open day status
- Recent activity
- Export buttons

Dashboard must read only Jazz Load data.

Do not include normal expense tracker totals.

## Reports

Add separate Jazz Load reports:

### DO Balance Report

Show:

- DO name
- DO line
- Opening balance
- Total issuance
- Total payments
- Closing balance
- Calculated Jazz Load values where required

### Jazz Load Issuance Report

Show:

- Day-wise issuance
- DO-wise issuance
- Monthly total
- Calculated Jazz Load total

### Payment Received Report

Show:

- Day-wise payments
- DO-wise payments
- Payment Jazz Load value if required
- Monthly total

### Lifting Summary

Show:

- Day
- Opening balance
- Jazz Load lifting
- Total balance
- Today Jazz Load issuance
- In-hand balance

### Commission Report

Show:

- Commission base
- Applied commission rate
- Calculated commission
- Day total
- Month total

### Monthly Summary

Show:

- Day-wise totals
- Month totals
- Closing/in-hand balance
- Outstanding DO balances

## Commission logic

Commission should be treated as a separate calculation layer.

Do not hardcode commission percentage.

Owner should manage commission rates from settings.

Suggested type:

```ts
type JazzLoadCommissionRule = {
  id: string;
  name: string;
  type: "payment_based" | "issuance_based" | "adjustment_based" | "custom";
  percentage: number;
  active: boolean;
  appliesTo: "paymentReceived" | "todayMlIssuance" | "closingBalance" | "custom";
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

At minimum, create structure to support commission rules even if first implementation only supports one active payment-based commission.

When saving commission result, store:

```ts
type JazzLoadCommissionResult = {
  baseAmount: number;
  commissionAmount: number;
  appliedRateId: string;
  appliedRateName: string;
  appliedRatePercentage: number;
};
```

## Offline behavior

The app may be deployed online, but the shop machine may temporarily lose internet.

Implement/verify:

- Firestore offline persistence
- App remains usable if already open
- Clear offline status
- Pending sync status
- Synced status
- No data loss when reconnecting

If PWA/service worker already exists, make sure Jazz Load routes work offline after first load.

If PWA does not exist, do not implement large unrelated changes unless assigned, but document that offline reload requires service worker/PWA cache.

## Backup/export behavior

Jazz Load data should be included as a separate backup group.

Do not mix it into normal expense backup without separation.

Backup JSON structure should clearly separate:

```json
{
  "jazzLoad": {
    "months": [],
    "days": [],
    "doEntries": [],
    "settings": [],
    "doProfiles": []
  }
}
```

If app already has backup helpers, reuse them but keep Jazz Load grouped separately.

Export reports should include only Jazz Load data when exporting from Jazz Load pages.

## Audit logging

For important changes, write audit logs:

- Rate created/updated/activated/deactivated
- Day saved
- Day closed
- Day reopened
- Month closed
- Month reopened
- DO entry deleted
- Backup restored if restore exists
- Owner override if any

Suggested path:

```text
jazzLoadMonths/{monthId}/audit/{eventId}
```

Audit event:

```ts
type JazzLoadAuditEvent = {
  action: string;
  userId: string;
  userEmail?: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  createdAt: Timestamp;
};
```

## Error and empty states

Handle these clearly:

- No month selected
- No day selected
- No active Jazz Load rate
- No DO profiles
- No entries for selected day
- Permission denied
- Offline mode
- Pending sync
- Failed save
- Invalid amount
- Duplicate DO
- Closed day
- Closed month
- Missing Firestore permissions

Do not show raw technical errors to client users unless in developer/debug mode.

## UI quality expectations

The module must feel client-ready.

Requirements:

- Clean spacing
- Consistent table design
- Clear currency formatting
- Clear calculated read-only cells
- Good empty states
- Good loading states
- Confirmation before destructive actions
- Mobile/tablet tolerance if existing app supports it
- No broken overflow on laptop screens
- No unclear labels
- No hidden critical buttons
- No accidental save/delete behavior

## Formatting

Use shared formatting utilities or create them:

```ts
formatCurrency(value: number): string
formatPercentage(value: number): string
parseMoneyInput(value: string): number
roundMoney(value: number): number
```

Decide rounding strategy and keep it consistent.

Recommended:

```text
Store numbers with two decimal precision where appropriate.
Display formatted currency in UI.
Do not store formatted strings as numeric values.
```

## Security rules

Update Firestore rules for Jazz Load paths.

Rules must enforce:

- Auth required
- Active user required
- Owner/admin/viewer permissions
- Viewer read-only
- Owner-only rate changes
- Owner-only close/reopen month if desired
- Admin limited write access
- No unauthorized writes to settings

Do not depend only on frontend protection.

## Suggested file structure

Use existing project conventions, but recommended structure:

```text
src/modules/jazzLoad/
  components/
    JazzLoadDashboard.tsx
    JazzLoadDailyEntry.tsx
    JazzLoadDoEntryTable.tsx
    JazzLoadLiftingCard.tsx
    JazzLoadSummaryCards.tsx
    JazzLoadRateSettings.tsx
    JazzLoadReports.tsx
  services/
    jazzLoadCalculations.ts
    jazzLoadValidation.ts
    jazzLoadFirestore.ts
    jazzLoadReports.ts
  types/
    jazzLoad.types.ts
  hooks/
    useJazzLoadMonth.ts
    useJazzLoadDay.ts
    useJazzLoadRates.ts
    useJazzLoadReports.ts
  utils/
    jazzLoadFormatters.ts
```

If the current project does not use modules, adapt this structure cleanly.

## Implementation phases

### Phase 1 — Add types and calculation engine

- Create Jazz Load types.
- Create rate config types.
- Create centralized calculation service.
- Add unit tests for formulas if test setup exists.

Acceptance:

- Formulas work independently of UI.
- No hardcoded rates.
- Old records can snapshot applied rates.

### Phase 2 — Add Firestore layer

- Create Jazz Load Firestore service.
- Add create/load month.
- Add save/load day.
- Add save/load DO entries.
- Add settings/rates storage.
- Add monthly summary update.

Acceptance:

- Data saves under separate Jazz Load collections.
- Existing expense data remains untouched.

### Phase 3 — Add rate settings UI

- Owner can create/edit/activate/deactivate rates.
- Show active Jazz Load rate.
- Block daily entry if no active rate.

Acceptance:

- No calculation happens without configured rate.
- Only owner can manage rates.

### Phase 4 — Add daily entry UI

- Month/day selector.
- DO row entry table.
- Base inputs.
- Read-only calculated Jazz Load columns.
- Single lifting field.
- Daily summary.
- Save and close day behavior.

Acceptance:

- User can enter daily records.
- System calculates all computed fields.
- Save works.
- Closed day locks properly.

### Phase 5 — Add dashboard and reports

- Dashboard cards.
- DO balance report.
- Jazz Load issuance report.
- Payment report.
- Lifting report.
- Commission report.
- Monthly summary.

Acceptance:

- Reports read only Jazz Load data.
- Totals match saved day entries.

### Phase 6 — Add backup/export support

- Add Jazz Load backup group.
- Add export for Jazz Load reports.
- Add restore only if existing app supports restore.

Acceptance:

- Backup is separate and clearly labeled.
- Existing expense backup is not corrupted.

### Phase 7 — Add permissions and audit logs

- Update Firestore rules.
- Add audit logging for important actions.
- Verify owner/admin/viewer behavior.

Acceptance:

- Viewer cannot write.
- Admin cannot change rates.
- Owner can manage settings.
- Firestore rules enforce this.

### Phase 8 — QA and client handover readiness

Test:

- Build
- Login
- Owner rate setup
- Month create/load
- Day entry
- Calculations
- Save
- Reload
- Offline entry if persistence exists
- Reconnect sync
- Reports
- Export
- Roles
- Firestore rules
- Empty states
- Error states

Acceptance:

- No breaking console errors.
- No calculation mismatch.
- No data mixing.
- No unauthorized access.
- Module is ready for client testing.

## Final QA checklist

Complete this before marking task done:

```text
[ ] Jazz Load module is separate from existing expense tracker
[ ] Separate Firestore collections are used
[ ] No Jazz Load data is merged into normal expense totals
[ ] Owner-managed rates implemented
[ ] No hardcoded percentage values
[ ] Active rate is required before entry
[ ] Base amount input works
[ ] Calculated Jazz Load amount is read-only
[ ] Applied rate snapshot is stored per record
[ ] Old records do not change when rate changes
[ ] Single Jazz Load lifting field implemented
[ ] Daily lifting formulas work
[ ] DO day total formula works
[ ] DO closing balance formula works
[ ] DO carry-forward works
[ ] Daily summary works
[ ] Monthly summary works
[ ] Dashboard works
[ ] DO balance report works
[ ] Jazz Load issuance report works
[ ] Payment report works
[ ] Lifting report works
[ ] Commission report works if enabled
[ ] Backup/export separates Jazz Load data
[ ] Firestore rules updated
[ ] Owner/admin/viewer permissions tested
[ ] Offline/pending sync status does not break the module
[ ] Build passes
[ ] No critical console errors
[ ] README/docs updated with Jazz Load usage
```

## Final output required from agent

After implementation, provide a report with:

1. Files created/modified
2. Firestore collections added
3. Routes/pages added
4. Calculation formulas implemented
5. Rate settings behavior
6. Role behavior
7. What was tested
8. Known limitations
9. Deployment notes
10. Remaining improvements

## Hard restrictions

Do not rewrite the whole app.

Do not change existing expense tracker behavior unless required for shared navigation/layout.

Do not merge Jazz Load with existing expense data.

Do not hardcode percentage rates.

Do not let users manually type calculated Jazz Load values.

Do not duplicate formulas inside UI components.

Do not save broken/NaN values.

Do not bypass Firestore rules.

Do not make destructive actions without confirmation.

Do not mark the task done without testing build and main user flows.



#Example data 

| DO           |       Line | Opening Base | Opening Jazz Load | Issuance Base | Issuance Jazz Load | Day Total Base | Day Total Jazz Load | Payment Base | Payment Jazz Load | Closing Base | Closing Jazz Load |
| ------------ | ---------: | -----------: | ---------: | ------------: | ----------: | -------------: | -----------: | -----------: | ---------: | -----------: | ---------: |
| RIZWAN       | 3017211475 |            0 |          0 |        185000 |      189810 |         185000 |       189810 |       185000 |     189810 |            0 |          0 |
| MIRZA        | 3051639672 |            0 |          0 |         30000 |       30780 |          30000 |        30780 |            0 |          0 |        30000 |      30780 |
| ADNAN        | 3017211714 |            0 |          0 |         85000 |       87210 |          85000 |        87210 |        85000 |      87210 |            0 |          0 |
| ARSLAN       | 3027100125 |            0 |          0 |        186000 |      190836 |         186000 |       190836 |       186000 |     190836 |            0 |          0 |
| MUBASHAR     | 3027100126 |            0 |          0 |        250000 |      256500 |         250000 |       256500 |        70000 |      71820 |       180000 |     184680 |
| IRFAN MIRZA  | 3027103467 |            0 |          0 |        100000 |      102600 |         100000 |       102600 |        73500 |      75411 |        26500 |      27189 |
| HASSAN       | 3027103468 |            0 |          0 |        150000 |      153900 |         150000 |       153900 |            0 |          0 |       150000 |     153900 |
| NAVEED       | 3030963707 |            0 |          0 |        100000 |      102600 |         100000 |       102600 |        89000 |      91314 |        11000 |      11286 |
| IRFAN        | 3030964504 |            0 |          0 |        111500 |      114399 |         111500 |       114399 |       111500 |     114399 |            0 |          0 |
| Unknown DO 1 |       null |            0 |          0 |         80000 |       82080 |          80000 |        82080 |        80000 |      82080 |            0 |          0 |
| Unknown DO 2 |       null |            0 |          0 |          8816 |    9045.216 |           8816 |     9045.216 |         8816 |   9045.216 |            0 |          0 |
| OFFICE       | 3027107343 |            0 |          0 |             0 |           0 |              0 |            0 |            0 |          0 |            0 |          0 |

#Example Jazz Day Data
```json
{
  "dayNo": 1,
  "totals": {
    "openingBase": 0,
    "openingMl": 0,
    "issuanceBase": 1286316,
    "issuanceMl": 1319760.216,
    "dayTotalBase": 1286316,
    "dayTotalMl": 1319760.216,
    "paymentBase": 888816,
    "paymentMl": 911925.216,
    "closingBase": 397500,
    "closingMl": 407835
  },
  "lifting": {
    "openingBalance": 3485487,
    "mlLifting": 0,
    "totalBalance": 3485487,
    "todayMlIssuance": 1319760.216,
    "inHandBalance": 2165726.784
  },
  "commission": {
    "commission1": 600.8396159999538,
    "commission2": 8532.6336,
    "totalDayCommission": 9133.473215999953
  }
}
```

For every row, user enters base values only. Jazz Load values are calculated by the system using the active owner-managed rate snapshot. Day Total = Opening + Today Issuance. Closing Balance = Day Total - Payment Received. Daily lifting has one lifting field only, and In Hand Balance = Opening Balance + Jazz Load Lifting - Today Jazz Load Issuance. Jazz Load data stays separate from normal expense tracker data.