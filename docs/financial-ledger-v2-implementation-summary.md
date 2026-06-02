# Financial Ledger V2 Implementation Summary

## Overview

This implementation adds the first production-safe layer of the financial architecture redesign.

The core change is that ledger records now have a v2 path where raw user input is separated from calculated balances. Existing v1 Firestore paths are preserved for compatibility, but new raw-entry writes are staged into `ledgerV2/.../rawEntries`, and Expense recalculation now generates verified v2 projections.

The implementation follows this rule:

```text
Raw user input = source of truth
Calculated balances = generated projection
```

## Main Outcomes

- Added shared ledger v2 types for raw records, projections, calc runs, mismatch reports, invariant issues, and structured audit actions.
- Added a deterministic Expense credit-party projector that rebuilds carry-forward chains from raw entries and previous closings.
- Added regression coverage for the broken May 2026 Day 28 -> Day 29 -> Day 30 -> Day 31 credit-chain scenario.
- Added v2 raw-entry dual-write support for Expense, Jazz Load, and Stock saves.
- Updated Expense Cloud Function recalculation to write server-verified v2 projections, calc run docs, mismatch reports, and structured audit logs.
- Preserved all old paths and current UI compatibility snapshots.
- Added a safe migration/dry-run CLI for Firestore inspection, backup, dry-run projection, proposed writes, and v2-only apply.
- Hardened autosave statuses so local raw saves are not presented as final financial state before recalculation.
- Added owner/admin UI warning support for open v2 mismatch reports.

## Files Created

### Ledger Core

```text
src/shared/ledger/ledgerTypes.ts
src/shared/ledger/expenseCreditLedger.ts
src/shared/ledger/expenseCreditLedger.test.ts
```

These files define the v2 ledger model and the Expense credit-party projection engine.

`ledgerTypes.ts` adds shared types such as:

- `LedgerModule`
- `LedgerAuditAction`
- `LedgerCalcRun`
- `LedgerMismatchReport`
- `LedgerInvariantIssue`
- `LedgerCalcStatus`
- `RawCalculatedRecord`

`expenseCreditLedger.ts` adds:

- legacy embedded/subcollection normalization
- raw credit-entry conversion
- deterministic forward projection
- compatibility row generation
- invariant checking
- mismatch/conflict detection

### Migration Tooling

```text
scripts/ledger-v2-migration.mjs
```

This script supports:

- `--dry-run`
- `--apply`
- `--month`
- `--project`
- `--account`
- `--output-report`
- `--backup-file`
- `--confirm-apply-v2`

Important safety behavior:

- Default mode is dry-run.
- Dry-run writes only local backup/report files.
- Apply mode writes only `ledgerV2` paths.
- Apply mode requires `--confirm-apply-v2`.
- It uses Firebase CLI authenticated REST access.
- It does not print tokens.
- It does not call `firebase login:list --json`.

### Documentation

```text
docs/financial-ledger-v2.md
docs/financial-ledger-v2-implementation-summary.md
```

`financial-ledger-v2.md` documents the new architecture, paths, migration CLI, rollback, and verification commands.

This file summarizes the completed implementation.

## Files Modified

```text
.gitignore
package.json
firestore.rules
functions/src/index.ts
src/App.tsx
src/lib/auditLogService.ts
src/lib/firestoreService.ts
src/modules/jazzLoad/services/jazzLoadFirestore.ts
src/modules/stock/services/stockFirestore.ts
src/shared/dayControls/UniversalDayControlBar.tsx
src/shared/hooks/useAutoSaveEntry.ts
src/shared/types/dayControl.types.ts
src/types/ledger.ts
```

## Firestore Paths Added

The implementation introduces additive v2 paths:

```text
ledgerV2/{module}/months/{monthId}
ledgerV2/{module}/months/{monthId}/days/{dayNo}
ledgerV2/{module}/months/{monthId}/days/{dayNo}/rawEntries/{entryId}
ledgerV2/{module}/months/{monthId}/days/{dayNo}/projections/{projectionId}
ledgerV2/{module}/months/{monthId}/summary/{summaryId}
ledgerV2/{module}/months/{monthId}/calcRuns/{runId}
ledgerV2/{module}/months/{monthId}/mismatchReports/{reportId}
```

Currently:

- Expense writes v2 raw entries and server-generated v2 projections.
- Jazz Load writes v2 raw entries.
- Stock writes v2 raw entries.

## Old Paths Preserved

No old Firestore data paths were deleted.

The following compatibility paths remain intact:

```text
months/{monthId}
months/{monthId}/days/{dayNo}
months/{monthId}/days/{dayNo}.credits
months/{monthId}/days/{dayNo}/credits/{creditId}
months/{monthId}/summary/home
jazzLoadMonths/{monthId}
jazzLoadMonths/{monthId}/days/{dayNo}
stockMonths/{monthId}
stockMonths/{monthId}/days/{dayNo}
stockBalances/...
```

The app can still fall back to old v1 data if v2 rollout is stopped.

## Expense Ledger Changes

Expense daily saves now do two things in one controlled flow:

1. Preserve legacy compatibility writes:

```text
months/{monthId}/days/{dayNo}
months/{monthId}/days/{dayNo}/expenses/{expenseId}
months/{monthId}/days/{dayNo}/commissions/{commissionId}
months/{monthId}/days/{dayNo}/credits/{creditId}
months/{monthId}/days/{dayNo}/ownerBalances/{ownerBalanceId}
months/{monthId}/summary/home
```

2. Write canonical v2 raw entries:

```text
ledgerV2/expense/months/{monthId}/days/{dayNo}/rawEntries/{entryId}
```

Raw entries are grouped by type:

- `expense`
- `commission`
- `credit`
- `ownerBalance`

The raw credit entry stores editable fields only:

```ts
{
  partyId,
  partyNameSnapshot,
  loan,
  receive,
  manualAdjustment,
  notes,
  source
}
```

It does not treat opening or closing balances as editable truth.

## Expense Recalculation Function Changes

`functions/src/index.ts` still keeps the existing callable name:

```text
recalculateMonth
```

But it now also stages v2 projection data:

```text
ledgerV2/expense/months/{monthId}/days/{dayNo}/projections/{projectionId}
ledgerV2/expense/months/{monthId}/summary/home
ledgerV2/expense/months/{monthId}/calcRuns/{calcRunId}
ledgerV2/expense/months/{monthId}/mismatchReports/{reportId}
```

The function also writes structured audit logs:

- `FORWARD_RECALC_STARTED`
- `FORWARD_RECALC_COMPLETED`
- `FORWARD_RECALC_FAILED`
- `BALANCE_MISMATCH_DETECTED`

If mismatches are detected, the function writes a mismatch report instead of silently continuing as if the month is correct.

## Jazz Load Changes

Jazz Load day saves now write raw v2 records under:

```text
ledgerV2/jazzLoad/months/{monthId}/days/{dayNo}/rawEntries/{entryId}
```

The raw entries preserve editable input such as:

- DO identity
- DO line
- issuance base amount
- payment received base amount
- lifting amount
- notes

Calculated values such as opening balance, day total, closing balance, commission, and daily summary remain generated values in the current Jazz Load service.

The next phase should move Jazz Load authoritative projection writes into Functions the same way Expense was started.

## Stock Changes

Stock Ledger day saves now write raw v2 records under:

```text
ledgerV2/stock/months/{monthId}/days/{dayNo}/rawEntries/{entryId}
```

The raw entries preserve editable input such as:

- account id/name/type
- product quantities
- product rates at entry time
- payments received
- stock-in product quantities
- stock-in paid amount
- notes

Calculated values such as due balance, carry-forward balance, current stock, Jazz payable, and summaries remain generated values in the current Stock service.

The next phase should move Stock authoritative projections into Functions.

## Firestore Rules Changes

Client access now separates raw writes from calculated writes.

Allowed:

```text
ledgerV2/{module}/months/{monthId}/days/{dayNo}/rawEntries/{entryId}
```

Blocked for clients:

```text
ledgerV2/{module}/months/{monthId}
ledgerV2/{module}/months/{monthId}/days/{dayNo}
ledgerV2/{module}/months/{monthId}/days/{dayNo}/projections/{projectionId}
ledgerV2/{module}/months/{monthId}/summary/{summaryId}
ledgerV2/{module}/months/{monthId}/calcRuns/{runId}
ledgerV2/{module}/months/{monthId}/mismatchReports/{reportId}
```

The rule intent is:

- clients can write raw user input only
- projections are backend-owned
- calc runs are backend-owned
- mismatch reports are backend-owned

## Autosave/UI Changes

Autosave now better matches the redesigned financial state model.

New statuses include:

- `Typing...`
- `Saving...`
- `Pending sync`
- `Pending recalculation`
- `Saved`
- `Error saving`
- `Read-only`
- `Closed day`

Expense daily entry no longer exposes a manual Save button in the universal day control bar.

The universal controls still include:

- Close Day
- Reopen Selected Day
- Reopen All Days
- Close All Previous Days Except Today
- Master Refresh Calculations
- Export Daily Excel
- Export Daily PDF

Owner/admin users now see a visible warning when open v2 mismatch reports exist for the selected Expense month.

## Audit Log Changes

Unified audit log support was expanded with:

- `date`
- `before`
- `after`

Structured financial actions were added to the action lists, including:

- `RAW_ENTRY_SAVED`
- `FORWARD_RECALC_STARTED`
- `FORWARD_RECALC_COMPLETED`
- `FORWARD_RECALC_FAILED`
- `BALANCE_MISMATCH_DETECTED`
- `BALANCE_MISMATCH_REPAIRED`
- `DAY_CLOSED`
- `DAY_REOPENED`
- `ALL_DAYS_REOPENED`
- `PREVIOUS_DAYS_CLOSED`
- `MASTER_REFRESH_STARTED`
- `MASTER_REFRESH_COMPLETED`
- `MASTER_REFRESH_FAILED`
- `MIGRATION_STARTED`
- `MIGRATION_COMPLETED`
- `MIGRATION_FAILED`
- `BACKUP_CREATED`

## May 2026 Credit Bug Regression

A test was added for the known broken sequence:

```text
Day 28 has correct non-zero credit closings.
Day 29 is empty.
Day 30 has manual Usman Cheema loan 9000 with opening 0.
Day 31 should carry forward from Day 30.
```

The v2 projector verifies:

```text
Day 29 Usman opening = 2000
Day 29 Usman closing = 2000
Day 30 Usman opening = 2000
Day 30 Usman loan = 9000
Day 30 Usman receive = 0
Day 30 Usman closing = 11000
Day 31 Usman opening = 11000
Day 31 Usman closing = 11000
```

Manual `loan` and `receive` values are preserved.

Opening and closing balances are regenerated.

## Tests Added

New test file:

```text
src/shared/ledger/expenseCreditLedger.test.ts
```

It covers:

- Day 29 carry-forward rebuilt from Day 28
- Day 30 manual Usman Cheema loan preserved
- Day 31 carry-forward from Day 30
- compatibility credit rows generated from projections
- embedded/subcollection mismatch detection
- legacy balance-only row inference as manual adjustment

Existing tests still cover:

- current `computeMonth` carry-forward behavior
- owner balance carry-forward
- Jazz Load calculations
- Stock carry-forward calculations
- universal workflow structure
- audit log helper behavior
- sync status labels

## Verification Results

These commands passed:

```bash
npm test
npm run build
npm --prefix functions run build
npm --prefix functions test
node --check scripts/ledger-v2-migration.mjs
```

Frontend test result:

```text
10 test files passed
51 tests passed
```

Functions test result:

```text
1 test passed
```

Build result:

```text
Frontend build passed
Functions TypeScript build passed
```

## Blocked Verification

These commands were attempted but blocked by expired Firebase CLI credentials:

```bash
firebase deploy --only firestore:rules --dry-run
npm run ledger:dry-run:may2026
```

Observed error:

```text
Authentication Error: Your credentials are no longer valid.
Please run firebase login --reauth
```

Because of this, live Firestore data was not inspected in this implementation pass.

The May 2026 bug is verified by deterministic tests, not yet by live Firestore dry-run output.

## Migration Status

Migration is implemented as tooling, not applied to live Firestore.

No live v2 migration writes were performed.

No v1 data was deleted.

No backup file was produced because Firestore auth failed before the script could read data.

After Firebase reauthentication, run:

```bash
npm run ledger:dry-run:may2026
```

Expected output files:

```text
tmp/ledger-v2-2026-05-report.json
tmp/ledger-v2-2026-05-backup.json
```

`tmp/` is ignored by git.

## Known Limitations

- Live Firestore verification is pending Firebase CLI reauthentication.
- Firestore rules dry-run is pending Firebase CLI reauthentication.
- Expense has the strongest v2 projection implementation right now.
- Jazz Load and Stock currently write v2 raw entries but still calculate projections in their frontend services.
- Full Functions-authoritative projection for Jazz Load and Stock should be done in the next phase.
- Feature-flagged v2 read cutover is documented but not fully implemented yet.
- Migration apply mode exists, but it should not be run until backup and dry-run report are reviewed.

## Rollback

Rollback is simple because all v2 work is additive.

To roll back:

1. Stop using `ledgerV2` reads/projections.
2. Keep existing v1 paths active.
3. Continue using:

```text
months/...
jazzLoadMonths/...
stockMonths/...
stockBalances/...
```

Do not delete `ledgerV2` data during rollback.

Do not restore backup into production unless explicitly approved.

If a restore is needed, restore into an emulator or staging Firebase project first.

## Deployment Steps

After Firebase credentials are refreshed:

```bash
firebase login --reauth
firebase deploy --only firestore:rules --dry-run
npm run ledger:dry-run:may2026
```

Review:

```text
tmp/ledger-v2-2026-05-report.json
tmp/ledger-v2-2026-05-backup.json
```

Then deploy only after review:

```bash
firebase deploy --only firestore:rules
npm --prefix functions run build
firebase deploy --only functions
```

If using Hosting:

```bash
npm run build
firebase deploy --only hosting
```

## Recommended Next Phase

1. Reauthenticate Firebase CLI.
2. Run the May 2026 dry-run and inspect the report.
3. Confirm live Day 28, Day 29, Day 30, and Day 31 values.
4. Add a feature flag for v2 read cutover.
5. Move Jazz Load projections into Functions.
6. Move Stock projections into Functions.
7. Add emulator integration tests for rules and callable recalculation.
8. Apply v2 migration only after backup and dry-run review.
