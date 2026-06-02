# Ledger V2 Production Safety Gate And Apply Plan

Date: 2026-06-02
Project: `franchise-expense-system`
Month: `2026-05`
Status: safety gate completed; production apply not run.

## Hard Rules

- Do not enable production v2 reads yet.
- Do not run migration apply without explicit approval.
- UI must remain on `v1` or `v2-shadow` until:
  - v2 apply completes,
  - emulator tests pass,
  - `verifiedReportId` is stored,
  - post-apply verification confirms live `ledgerV2` projections match the dry-run/apply report.

## JDK 21 Setup Used

System Java was still Java 17:

```text
OpenJDK 17.0.19
```

Because `sudo apt-get` required an interactive password, JDK 21 was configured as a user-space runtime under `/tmp`:

```text
/tmp/franchise-jdk21/jdk-21.0.11+10
```

Verified:

```text
openjdk version "21.0.11" 2026-04-21 LTS
OpenJDK Runtime Environment Temurin-21.0.11+10
```

Commands used for emulator runs:

```sh
JAVA_HOME=/tmp/franchise-jdk21/jdk-21.0.11+10 PATH=/tmp/franchise-jdk21/jdk-21.0.11+10/bin:$PATH npm run test:emulator:rules
JAVA_HOME=/tmp/franchise-jdk21/jdk-21.0.11+10 PATH=/tmp/franchise-jdk21/jdk-21.0.11+10/bin:$PATH npm run test:emulator:callables
```

## Emulator Test Results

Firestore rules emulator:

```text
src/shared/ledger/firestoreRules.integration.test.ts
5 tests passed
```

Callable recalculation emulator:

```text
src/shared/ledger/callableRecalculation.integration.test.ts
2 tests passed
```

Callable functions loaded successfully in emulator:

- `recalculateJazzLoadLedgerV2`
- `recalculateStockLedgerV2`
- existing Expense and report callables

Note: the Functions emulator warned that host Node is 24 while functions request Node 20. Tests still passed. Production Functions runtime remains configured as Node 20.

## May 2026 Artifact Inspection

Files inspected:

- `tmp/ledger-v2-2026-05-report.json`
- `tmp/ledger-v2-2026-05-backup.json`
- `tmp/ledger-v2-2026-05-inspection.json`

Artifact sizes:

```text
322950  tmp/ledger-v2-2026-05-report.json
1594616 tmp/ledger-v2-2026-05-backup.json
6491    tmp/ledger-v2-2026-05-inspection.json
```

Dry-run report:

```json
{
  "mode": "dry-run",
  "daysChecked": 32,
  "missingDays": [],
  "emptyCreditDays": [29, 31, 32],
  "conflicts": 0,
  "invariantFailures": 0,
  "proposedWrites": 461,
  "rowsWritten": 0,
  "backupFile": "tmp/ledger-v2-2026-05-backup.json"
}
```

Day 28 to Day 31 proof:

```json
[
  {
    "id": "day-29-rebuilt-from-day-28",
    "passed": true,
    "detail": "day28Closing=2000, day29Opening=2000"
  },
  {
    "id": "day-30-loan-preserved",
    "passed": true,
    "detail": "rawLoan=9000, projectedLoan=9000"
  },
  {
    "id": "day-30-opening-2000",
    "passed": true,
    "detail": "day30Opening=2000"
  },
  {
    "id": "day-30-closing-11000",
    "passed": true,
    "detail": "day30Closing=11000"
  },
  {
    "id": "day-31-carries-day-30",
    "passed": true,
    "detail": "day30Closing=11000, day31Opening=11000"
  }
]
```

Conclusion: the reviewed dry-run proves the May 2026 credit-party chain and preserves the manual Usman Cheema Day 30 loan of `9000`.

## Controlled Apply Command

Do not run this command until explicitly approved.

```sh
node scripts/ledger-v2-migration.mjs --month 2026-05 --apply --confirm-apply-v2 --output-report tmp/ledger-v2-2026-05-apply-report.json --backup-file tmp/ledger-v2-2026-05-apply-backup.json
```

Expected write count:

```text
461
```

Backup files:

- reviewed dry-run backup: `tmp/ledger-v2-2026-05-backup.json`
- apply-time backup: `tmp/ledger-v2-2026-05-apply-backup.json`

## Exact Paths Written By Apply

Only these path patterns should be written:

```text
ledgerV2/expense/months/2026-05
ledgerV2/expense/months/2026-05/days/{dayNo}
ledgerV2/expense/months/2026-05/days/{dayNo}/rawEntries/{entryId}
ledgerV2/expense/months/2026-05/days/{dayNo}/projections/{projectionId}
```

The apply command must not write these old paths:

```text
months/2026-05
months/2026-05/days/{dayNo}
months/2026-05/days/{dayNo}.credits
months/2026-05/days/{dayNo}/credits/{creditId}
```

## Feature Flag Behavior

Feature flag path:

```text
settings/ledger/config/main
```

Allowed read modes:

```ts
"v1" | "v2-shadow" | "v2"
```

Required behavior:

- Before apply: keep all UI reads on `v1` or `v2-shadow`.
- During apply: do not enable hard `v2`.
- After apply: set or keep `expenseReadMode` as `v2-shadow`.
- Hard `v2` is blocked unless `verifiedReportId` is present.
- Do not set hard `v2` until post-apply verification confirms live `ledgerV2` projections match the report.

## Post-Apply Verification Checklist

After explicit approval and apply:

1. Confirm `tmp/ledger-v2-2026-05-apply-report.json`:
   - `mode: "apply"`
   - `rowsWritten: 461`
   - `conflicts: 0`
   - `invariantFailures: 0`
2. Confirm `tmp/ledger-v2-2026-05-apply-backup.json` exists.
3. Read live `ledgerV2/expense/months/2026-05` using read-only Firebase REST access.
4. Compare live `ledgerV2` documents against the dry-run/apply report proposed writes.
5. Verify live Day 28 to Day 31:
   - Day 29 opening equals Day 28 closing.
   - Day 30 Usman Cheema raw loan is `9000`.
   - Day 30 opening is `2000`.
   - Day 30 closing is `11000`.
   - Day 31 opening is `11000`.
6. Confirm no old v1 paths changed during apply.
7. Write/store a reviewed `verifiedReportId`.
8. Keep UI in `v2-shadow` until owner review accepts live v2 data.

## Rollback Path

Immediate rollback:

1. Set all read modes in `settings/ledger/config/main` back to `v1`.
2. Stop invoking v2 projection reads in UI.
3. Keep old v1 data as source of truth.
4. Ignore `ledgerV2/expense/months/2026-05`.

Data cleanup rollback, only after separate approval:

1. Backup `ledgerV2/expense/months/2026-05`.
2. Delete/archive `ledgerV2/expense/months/2026-05`.
3. Keep old `months/2026-05` paths untouched.
