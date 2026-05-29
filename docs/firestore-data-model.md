# Firestore Data Model Reference

This document explains what this app stores in Firestore, where it stores it, and what each collection/document/field means.

It is based on the current code in:

- `src/lib/firestoreService.ts`
- `src/types/ledger.ts`
- `functions/src/index.ts`
- `functions/src/formulaEngine.ts`
- `src/modules/jazzLoad/services/jazzLoadFirestore.ts`
- `src/modules/jazzLoad/types/jazzLoad.types.ts`
- `src/modules/jazzLoad/services/jazzLoadCalculations.ts`
- `firestore.rules`

## High-Level Structure

Top-level Firestore collections used by the app:

- `months`
- `jazzLoadMonths`
- `jazzLoadSettings`
- `users`
- `authorizedEmails`
- `settings`
- `notificationLogs`
- `auditLogs`

Main business data lives under `months/{monthId}`.

Jazz Load data is intentionally separate from the normal expense ledger. Jazz Load records live under `jazzLoadMonths/{monthId}` and `jazzLoadSettings/...`; they are not included in normal expense totals or workbook import totals.

## 1. `months` Collection

Path:

```text
months/{monthId}
```

Example:

```text
months/2026-05
months/2099-12
```

The month document is the root record for one accounting month.

### Month Document Fields

Common fields stored on `months/{monthId}`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Month ID, usually `YYYY-MM`, for example `2026-05`. |
| `label` | string | Human-readable label. Currently usually the same as `id`. |
| `openingBalance` | number | Starting balance for the month. |
| `status` | `"open"` or `"closed"` | Whether the month is editable. |
| `importedFileName` | string optional | Original workbook filename if month data came from import. |
| `createdAt` | number optional | Unix timestamp in milliseconds when the month was created. |
| `updatedAt` | number optional | Unix timestamp in milliseconds for the latest update. |

### Month Subcollections

Under each month document, the app uses:

- `days`
- `summary`
- `audit`

## 2. `months/{monthId}/days` Subcollection

Path:

```text
months/{monthId}/days/{dayNo}
```

Examples:

```text
months/2026-05/days/1
months/2026-05/days/15
months/2026-05/days/32
```

Document ID is the day number as a string.

### Why day `32` matters

The rules treat `dayNo != 32` as a normal daily entry. The app also uses cross-month calculations where day `32` can act like a synthetic carry-forward row when deriving opening balances for future months.

In normal daily work, most user-entered records are days `1` through `31`.

## 3. What a Day Document Stores

The day document mixes three kinds of data:

1. Raw input entered by the user
2. Workflow/lock state
3. Computed values written after recalculation

That means a day document is not only raw form input. It can become a merged record containing both input and derived totals.

### 3.1 Raw Input Fields on a Day

These come from `DailyLedgerInput`.

| Field | Type | Meaning |
| --- | --- | --- |
| `dayNo` | number | Day number within the month. |
| `date` | string optional | Date string for display/import. |
| `label` | string optional | Friendly label for the day. |
| `notes` | string optional | Free-text notes for that day. |
| `importType` | `"expense"` or `"full"` optional | Indicates whether the row came from expense-only import or full import. |
| `entryYear` | number optional | Real calendar year used by rules to decide if the day is editable today. |
| `entryMonth` | number optional | Real calendar month used by rules. |
| `entryDay` | number optional | Real calendar day used by rules. |
| `updatedAt` | number optional | Last write time in milliseconds. |

### 3.2 Lock and Reopen Workflow Fields

These fields control whether a day can still be edited.

| Field | Type | Meaning |
| --- | --- | --- |
| `lockedAt` | number optional | When the day was closed/locked. |
| `lockedBy` | string optional | UID of the user who closed the day. |
| `lockedByRole` | `owner` \| `admin` \| `viewer` optional | Role recorded when the day was closed. |
| `reopenedUntilAt` | number optional | Millisecond timestamp until a previous day remains reopened. |
| `reopenedAt` | number optional | When the previous day was reopened. |
| `reopenedBy` | string optional | UID of the user who reopened it. |
| `reopenedByRole` | `owner` \| `admin` \| `viewer` optional | Role recorded when reopened. |

### 3.3 Embedded Row Arrays on a Day

The app stores row arrays directly on the day document:

| Field | Type | Meaning |
| --- | --- | --- |
| `expenses` | array | Embedded expense rows |
| `commissions` | array | Embedded commission rows |
| `credits` | array | Embedded credit rows |
| `ownerBalances` | array | Embedded owner-balance rows |

This is important:

- the app also stores the same rows again in subcollections under the same day
- `fetchMonthDays()` prefers embedded arrays if they exist
- if embedded arrays are missing, it falls back to the subcollections

So the system intentionally duplicates detail rows in two places:

1. embedded on the day document
2. in dedicated child subcollections

## 4. Day Row Subcollections

Under each day document, the app stores four detail subcollections:

- `expenses`
- `commissions`
- `credits`
- `ownerBalances`

### 4.1 Expenses

Path:

```text
months/{monthId}/days/{dayNo}/expenses/{expenseId}
```

Expense row fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Row ID. |
| `name` | string | Expense name/title. |
| `description` | string | Extra text for the expense. |
| `amount` | number | Expense amount. |
| `categoryId` | string optional | Catalog ID of the expense category. |
| `category` | string optional | Category label. |

### 4.2 Commissions

Path:

```text
months/{monthId}/days/{dayNo}/commissions/{commissionId}
```

Commission row fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Row ID. |
| `categoryId` | string optional | Catalog ID for commission category. |
| `category` | string | Commission category name, for example `JazzCash`. |
| `amount` | number | Commission amount. |

### 4.3 Credits

Path:

```text
months/{monthId}/days/{dayNo}/credits/{creditId}
```

Credit row fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Row ID. |
| `partyId` | string optional | Catalog ID of the party. |
| `partyName` | string | Party/customer name. |
| `opening` | number | Opening credit for that party at the start of the day. |
| `loan` | number | Amount given today. |
| `receive` | number | Amount received back today. |
| `today` | number optional | Alternate form of daily issued credit, used in some imports/computations. |
| `balance` | number optional | Calculated running balance for that row. |

### 4.4 Owner Balances

Path:

```text
months/{monthId}/days/{dayNo}/ownerBalances/{ownerBalanceId}
```

Owner balance row fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Row ID. |
| `description` | string | Text label for the row. |
| `amount` | number | Amount added/used for that row. |
| `opening` | number optional | Opening owner balance for the row. |
| `balance` | number optional | Computed balance. |
| `label` | string optional | Alternate display label. |

## 5. Computed Fields Also Stored on Day Documents

When the Cloud Function `recalculateMonth` runs, it computes daily totals and merges them back onto each day document.

That means `months/{monthId}/days/{dayNo}` can also contain:

| Field | Type | Meaning |
| --- | --- | --- |
| `openingBalance` | number | Opening balance entering that day. |
| `issueBalance` | number | Sum of all commissions for the day. |
| `totalBalance` | number | `openingBalance + issueBalance`. |
| `expenseTotal` | number | Sum of day expenses. |
| `returnBalance` | number | `totalBalance - expenseTotal`. |
| `commissionTotal` | number | Same as issue balance in current logic. |
| `ownerBalanceTotal` | number | Sum of computed owner balances. |
| `creditRows` | array | Computed credit rows with normalized values and balances. |
| `creditTotals` | map | Totals across all credit rows for the day. |

So a day document is effectively a merged document containing:

- raw entry metadata
- embedded raw rows
- lock/reopen state
- computed totals

## 6. `months/{monthId}/summary/home`

Path:

```text
months/{monthId}/summary/home
```

This document stores the month-level dashboard summary.

It is written after save/import/recalculate.

### Fields in `summary/home`

| Field | Type | Meaning |
| --- | --- | --- |
| `monthlyIssueTotal` | number | Sum of all day issue balances, currently derived from commissions. |
| `monthlyExpenseTotal` | number | Sum of all expenses in the month. |
| `monthlyReturnBalance` | number | Final closing return balance of the month. |
| `ownerBalanceTotal` | number | Sum of owner balances across days. |
| `creditBalanceTotal` | number | Sum of credit balances across days. |
| `expenseByCategory` | array | Aggregated expense totals by category. |
| `creditPartyBalances` | array | Latest balance per credit party plus active day count. |
| `dayRows` | array | Lightweight per-day summary rows for dashboard/month view. |
| `commissionMatrix` | array | Per-day commission totals broken down by category. |

### `expenseByCategory` row shape

| Field | Type | Meaning |
| --- | --- | --- |
| `category` | string | Expense category name. |
| `amount` | number | Total amount for that category across the month. |

### `creditPartyBalances` row shape

| Field | Type | Meaning |
| --- | --- | --- |
| `partyName` | string | Party name. |
| `balance` | number | Latest computed balance for that party. |
| `activeDays` | number | Number of days where the party had non-zero activity or carry-over. |

### `dayRows` row shape

| Field | Type | Meaning |
| --- | --- | --- |
| `dayNo` | number | Day number. |
| `date` | string optional | Imported/display date. |
| `label` | string optional | Day label. |
| `openingBalance` | number | Opening balance for the day. |
| `issueBalance` | number | Day commission total. |
| `totalBalance` | number | Opening plus issue. |
| `expenseTotal` | number | Total expenses that day. |
| `returnBalance` | number | Closing return balance for the day. |
| `creditBalance` | number | Total credit balance for the day. |

### `commissionMatrix` row shape

| Field | Type | Meaning |
| --- | --- | --- |
| `dayNo` | number | Day number. |
| `byCategory` | map | Category-to-amount map for that day. |
| `rowTotal` | number | Total commission amount for that day. |

## 7. `months/{monthId}/audit`

Path:

```text
months/{monthId}/audit/{eventId}
```

This stores activity history for the month.

### Audit Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Audit event ID. Client-generated for some events; auto-ID for Cloud Function recalc. |
| `action` | string | What happened. |
| `actorUid` | string optional | UID of acting user. |
| `actorEmail` | string optional | Email of acting user. |
| `createdAt` | number | Millisecond timestamp of event. |
| `detail` | string | Human-readable event description. |

### Audit Action Values

Known values in code:

- `import`
- `edit-day`
- `lock-day`
- `recalculate`
- `export`
- `close-month`
- `reopen-month`
- `role-change`
- `reopen-day`

## 8. `users` Collection

Path:

```text
users/{uid}
```

This is the application user profile collection.

A user document is created after successful Google sign-in if the email is already present in `authorizedEmails`.

### User Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `uid` | string | Firebase Auth UID. |
| `email` | string or null | Normalized email, expected lowercase. |
| `role` | `owner` \| `admin` \| `viewer` | Application role. |
| `active` | boolean | Whether access is enabled. |
| `createdAt` | number optional | Creation timestamp. |
| `updatedAt` | number optional | Last update timestamp. |

### What `users` represents

`users` is the active app identity store.

It answers:

- who is signed in
- what role they have
- whether the account is active

## 9. `authorizedEmails` Collection

Path:

```text
authorizedEmails/{email}
```

Example:

```text
authorizedEmails/hanzlaahmad100@gmail.com
```

Document ID is the normalized lowercase email address.

This collection is the allow-list for Google sign-in.

### Authorized Email Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Usually the lowercase email, same as document ID. |
| `email` | string | Lowercase email. |
| `role` | `owner` \| `admin` \| `viewer` | Role to assign on first bootstrap. |
| `active` | boolean | Whether this email is allowed to access the app. |
| `createdAt` | number optional | Creation timestamp. |
| `updatedAt` | number optional | Last update timestamp. |

### What `authorizedEmails` represents

This collection answers:

- is this Google email allowed into the app at all
- what role should a first-time user receive

It is different from `users`:

- `authorizedEmails` is the policy/allow-list
- `users` is the actual created user profile

## 10. `settings` Collection

The app uses `settings` for catalogs and notification config.

## 10.1 Catalogs

Paths:

```text
settings/expenseCategories/items/{itemId}
settings/commissionCategories/items/{itemId}
settings/creditParties/items/{itemId}
```

Each item document stores:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable catalog item ID, usually slug-like. |
| `name` | string | Display name. |
| `active` | boolean | Whether the item can still be used. |
| `sortOrder` | number | Order in dropdowns/tables. |
| `createdAt` | number optional | Creation time. |
| `updatedAt` | number optional | Last update time. |

### What each catalog means

- `expenseCategories`: Categories like `Salary`, `Rent`, `Utilities`
- `commissionCategories`: Categories like `JazzCash`, `JazzLoad`
- `creditParties`: Known parties used in credit rows

## 10.2 Notification Settings

Path:

```text
settings/notifications/config/default
```

This single config document stores email notification behavior.

### Notification Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Master notification switch. |
| `sendOnDayClose` | boolean | Send email when a day is closed. |
| `sendOnMonthClose` | boolean | Send email when a month is closed. |
| `sendOnImport` | boolean | Send email after workbook import. |
| `sendOnRecalculate` | boolean | Send email after manual recalculation. |
| `sendOnRoleChange` | boolean | Send email after role/email authorization changes. |
| `updatedAt` | number optional | Last update time. |

## 11. `notificationLogs` Collection

Path:

```text
notificationLogs/{logId}
```

This collection exists in rules, but the current app code shown here does not directly write to it from the client.

Rules mark it as:

- owner-readable
- not writable from the client

This suggests it is intended for server-side logging only.

## 12. How Data Flows During Common Actions

## 12.1 Create or load a month

When a month does not exist, the app writes:

- `months/{monthId}`

Fields created:

- `id`
- `label`
- `openingBalance`
- `status`
- `createdAt`
- `updatedAt`

## 12.2 Save a day manually

The app writes:

- `months/{monthId}/days/{dayNo}`
- `months/{monthId}/days/{dayNo}/expenses/{id}`
- `months/{monthId}/days/{dayNo}/commissions/{id}`
- `months/{monthId}/days/{dayNo}/credits/{id}`
- `months/{monthId}/days/{dayNo}/ownerBalances/{id}`
- `months/{monthId}/summary/home`
- `months/{monthId}/audit/{eventId}`

## 12.3 Close a day

The app updates:

- `months/{monthId}/days/{dayNo}` with lock fields
- `months/{monthId}/summary/home`
- `months/{monthId}/audit/{eventId}`

## 12.4 Reopen a previous day

The app updates:

- `months/{monthId}/days/{dayNo}` with reopen fields
- `months/{monthId}/audit/{eventId}`

## 12.5 Recalculate a month

The Cloud Function writes:

- computed fields back onto every `months/{monthId}/days/{dayNo}`
- `months/{monthId}/summary/home`
- `months/{monthId}` `updatedAt`
- a new `months/{monthId}/audit/{eventId}`

## 12.6 Close or reopen a month

The app updates:

- `months/{monthId}.status`
- `months/{monthId}.updatedAt`
- `months/{monthId}/audit/{eventId}`

## 12.7 Manage users

The app writes:

- `users/{uid}` for role/active updates
- `authorizedEmails/{email}` for allow-list updates

## 13. Important Design Nuances

## 13.1 Detail rows are duplicated

A single expense/commission/credit/owner-balance row is stored in two places:

- inside the parent day document array
- inside its own subcollection document

This duplication is intentional in current code.

## 13.2 Read preference favors embedded arrays

When loading a day:

- if embedded arrays exist on the day doc, the app uses them
- if embedded arrays are missing, it uses the subcollections

That means stale embedded arrays can override correct subcollection data.

## 13.3 Computed fields are merged into raw docs

The function recalculation does not keep computed values separate from the day doc. It merges computed totals into the same day document.

So day docs are a mixed raw-plus-derived storage model.

## 13.4 Security is role-based and state-based

Rules depend on:

- user role from `users/{uid}`
- authorized email in `authorizedEmails/{email}`
- month status
- whether the day matches the current real date
- whether a previous day has a valid reopen window

## 14. Jazz Load Collections

Jazz Load uses separate paths so it does not affect the normal expense ledger.

### `jazzLoadSettings/rates/items/{rateId}`

Owner-managed Jazz Load calculation rates. Daily entry is blocked unless one active rate exists for each required type:

- `ml_addition`
- `commission1_adjustment`
- `commission2_payment`

Saved DO entries store Jazz Load rate snapshots on calculated money fields. Saved day documents also store `appliedRates.mlRate`, `appliedRates.commission1Rate`, and `appliedRates.commission2Rate`, so old records do not change when these settings change.

### `jazzLoadSettings/commissionRules/items/{ruleId}`

Owner-managed commission rules. The first implementation supports one active payment-based rule applied to payment received base amounts.

### `jazzLoadSettings/doProfiles/items/{doId}`

Legacy combined DO/person/line catalog kept for older records.

### `jazzLoadSettings/doNames/items/{nameId}`

Managed DO names. Names are separate from fixed lines because one line can be assigned to different names on different dates.

### `jazzLoadSettings/doLines/items/{lineId}`

Managed fixed DO lines. Daily carry-forward prefers line identity so a line can keep its balance even when the assigned name changes.

### `jazzLoadSettings/audit/items/{eventId}`

Settings audit events for rate, commission rule, and DO profile changes.

### `jazzLoadMonths/{monthId}`

Jazz Load month root document with status, month totals, creator/updater, and close fields.

### `jazzLoadMonths/{monthId}/days/{dayNo}`

Daily Jazz Load document. It embeds `doEntries`, `lifting`, `summary`, and applied rate snapshots. The embedded rows are the preferred read source.

Commission summary fields:

| Field | Type | Notes |
| --- | --- | --- |
| `summary.commission1MlDeduction` | number | `paymentMlTotal * commission1Rate / 100` |
| `summary.commission1AdjustedPayment` | number | `paymentMlTotal - commission1MlDeduction` |
| `summary.commission1` | number | `paymentBaseTotal - commission1AdjustedPayment` |
| `summary.commission2` | number | `paymentBaseTotal * commission2Rate / 100` |
| `summary.totalCommission` | number | `commission1 + commission2` |
| `appliedRates` | map | Jazz Load Addition, Commission 1 Adjustment, and Commission 2 Payment snapshots used on this saved day |

### `jazzLoadMonths/{monthId}/days/{dayNo}/doEntries/{entryId}`

Row-level mirror of the embedded DO entries. Each entry stores the DO name, DO line, IDs, assignment ID, and rate snapshots as historical data. The app reads embedded rows first.

### `jazzLoadMonths/{monthId}/days/{dayNo}/doAssignments/{assignmentId}`

Date-specific assignment snapshot mapping one DO Line to one DO Name. The Daily Entry table creates one row per active DO Line; choosing a DO Name in that row writes this assignment snapshot and autosaves the day.

### `jazzLoadMonths/{monthId}/summary/monthly`

Precomputed Jazz Load monthly summary: issuance, payments, lifting, in-hand balance, commission, missing days, and DO balances.

### `jazzLoadMonths/{monthId}/audit/{eventId}`

Jazz Load audit events for day saves, close/reopen actions, month status changes, and future restore/rate changes.

## 15. `auditLogs` Collection

Path:

```text
auditLogs/{logId}
```

Unified, owner-readable activity log across expense, Jazz Load, settings, auth, and system actions. The app dual-writes here when legacy month/jazz audit events are created.

### Access

- Read: owner only (`firestore.rules`)
- Create: authenticated active users; `actorUid` must match the signed-in user
- Update/delete: denied (append-only)

### Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Document ID |
| `createdAt` | number | Milliseconds timestamp |
| `module` | string | `expense`, `jazzLoad`, `settings`, `auth`, or `system` |
| `action` | string | Normalized action code (for example `edit-day`, `role-change`) |
| `summary` | string | Human-readable one-line description |
| `actorUid` | string | User who performed the action |
| `actorEmail` | string \| null | Actor email when available |
| `actorRole` | string | `owner`, `admin`, or `viewer` at write time |
| `monthId` | string optional | Related month when applicable |
| `dayNo` | number optional | Related day when applicable |
| `targetType` | string optional | Resource type (for example `day`, `catalogItem`) |
| `targetId` | string optional | Resource identifier |
| `sourcePath` | string optional | Legacy audit document path for backfill traceability |

Legacy audit subcollections (`months/.../audit`, `jazzLoadMonths/.../audit`, `jazzLoadSettings/audit/items`) remain for email notifications and historical compatibility; only owners can read them.

## 16. Quick Path Cheat Sheet

```text
months/{monthId}
months/{monthId}/days/{dayNo}
months/{monthId}/days/{dayNo}/expenses/{expenseId}
months/{monthId}/days/{dayNo}/commissions/{commissionId}
months/{monthId}/days/{dayNo}/credits/{creditId}
months/{monthId}/days/{dayNo}/ownerBalances/{ownerBalanceId}
months/{monthId}/summary/home
months/{monthId}/audit/{eventId}
users/{uid}
authorizedEmails/{email}
settings/expenseCategories/items/{itemId}
settings/commissionCategories/items/{itemId}
settings/creditParties/items/{itemId}
settings/notifications/config/default
notificationLogs/{logId}
auditLogs/{logId}
jazzLoadSettings/rates/items/{rateId}
jazzLoadSettings/commissionRules/items/{ruleId}
jazzLoadSettings/doProfiles/items/{doId}
jazzLoadSettings/doNames/items/{nameId}
jazzLoadSettings/doLines/items/{lineId}
jazzLoadSettings/audit/items/{eventId}
jazzLoadMonths/{monthId}
jazzLoadMonths/{monthId}/days/{dayNo}
jazzLoadMonths/{monthId}/days/{dayNo}/doEntries/{entryId}
jazzLoadMonths/{monthId}/days/{dayNo}/doAssignments/{assignmentId}
jazzLoadMonths/{monthId}/summary/monthly
jazzLoadMonths/{monthId}/audit/{eventId}
```

## 17. Practical Mental Model

If you want to understand the database quickly, think of it like this:

- `authorizedEmails`: who is allowed in
- `users`: who the app knows and what role they have
- `months`: one ledger per month
- `days`: one detailed ledger document per day
- day subcollections: row-level detail tables
- `summary/home`: precomputed dashboard snapshot
- `audit`: per-month event history (email trigger)
- `auditLogs`: unified owner audit trail with filters in the app
- `settings/*`: master data and notification configuration
- `jazzLoadSettings/*`: Jazz Load-only rates, commission rules, DO profiles, and settings audit logs
- `jazzLoadMonths`: Jazz Load-only months, daily DO entries, summaries, and audit logs
