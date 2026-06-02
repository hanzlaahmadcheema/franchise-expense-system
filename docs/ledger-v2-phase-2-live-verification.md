# Ledger V2 Phase 2 Live Verification

Date: 2026-06-02
Project: `franchise-expense-system`
Scope: May 2026 Expense credit-party dry-run verification, v2 read cutover guard, and backend projection start for Jazz Load and Stock.

## Production Safety

- Production migration was not applied.
- No `--apply` or `--confirm-apply-v2` migration command was run.
- The May 2026 script ran in `dry-run` mode and reported `rowsWritten: 0`.
- Old Firestore paths remain preserved:
  - `months/{monthId}`
  - `months/{monthId}/days/{dayNo}`
  - `months/{monthId}/days/{dayNo}.credits`
  - `months/{monthId}/days/{dayNo}/credits/{creditId}`

## Commands Run

```sh
firebase login --reauth
firebase deploy --only firestore:rules --dry-run
npm run ledger:dry-run:may2026
npm run ledger:inspect:may2026
npm test
npm run build
npm --prefix functions run build
npm --prefix functions test
```

## Firestore Rules Dry-Run

Result: passed.

Key output:

```text
cloud.firestore: rules file firestore.rules compiled successfully
Dry run complete
```

No rules were deployed.

## Dry-Run Artifacts

Generated local files:

- `tmp/ledger-v2-2026-05-report.json`
- `tmp/ledger-v2-2026-05-backup.json`
- `tmp/ledger-v2-2026-05-inspection.json`

Artifact sizes:

```text
322950  tmp/ledger-v2-2026-05-report.json
1594616 tmp/ledger-v2-2026-05-backup.json
6491    tmp/ledger-v2-2026-05-inspection.json
```

These files are under `tmp/`, which is gitignored.

## Dry-Run Result

```json
{
  "mode": "dry-run",
  "daysChecked": 32,
  "missingDays": [],
  "emptyCreditDays": [29, 31, 32],
  "conflicts": 0,
  "invariantFailures": 0,
  "proposedWrites": 461,
  "rowsWritten": 0
}
```

Backup summary:

```json
{
  "projectId": "franchise-expense-system",
  "monthId": "2026-05",
  "days": 32,
  "summaryDocs": 1,
  "auditDocs": 270
}
```

## Day 28-31 Credit-Party Proof

Focused inspection result: passed.

```json
[
  {
    "id": "dry-run-mode",
    "passed": true,
    "detail": "mode=dry-run, rowsWritten=0"
  },
  {
    "id": "backup-created",
    "passed": true,
    "detail": "backupFile=tmp/ledger-v2-2026-05-backup.json"
  },
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

Conclusion: the May 2026 bug is repaired in the v2 dry-run projection. Day 29 is rebuilt from Day 28, Day 30 preserves the manual Usman Cheema loan of `9000`, Day 30 opening is `2000`, Day 30 closing is `11000`, and Day 31 opens from Day 30 closing.

## Feature-Flagged Read Cutover

Added config path:

```text
settings/ledger/config/main
```

Fields:

```ts
{
  expenseReadMode: "v1" | "v2-shadow" | "v2";
  jazzLoadReadMode: "v1" | "v2-shadow" | "v2";
  stockReadMode: "v1" | "v2-shadow" | "v2";
  verifiedReportId?: string;
  updatedAt?: number;
  updatedBy?: string;
}
```

Defaults keep all modules on `v1`.

Hard `v2` mode is blocked in client service code and Firestore rules unless `verifiedReportId` is present. The UI currently only shows a warning for `v2-shadow`; it does not switch reads to `ledgerV2`.

## Backend Projection Start

Added callable projection entrypoints:

- `recalculateJazzLoadLedgerV2`
- `recalculateStockLedgerV2`

These callables:

- require owner/admin auth
- read existing module month/day data
- write raw snapshots and calculated projections under `ledgerV2`
- write calc run documents
- write mismatch reports when chains fail
- write structured audit logs

No UI production read cutover was added.

## Emulator Tests

Added emulator integration test files:

- `src/shared/ledger/firestoreRules.integration.test.ts`
- `src/shared/ledger/callableRecalculation.integration.test.ts`

Normal Vitest result:

```text
10 passed, 2 skipped
51 passed, 7 skipped
```

The emulator tests are skipped in normal test runs and run only when the relevant emulators are active.

JDK 21 was configured under `/tmp/franchise-jdk21/jdk-21.0.11+10` because system Java is OpenJDK 17 and Firebase CLI 15.19.0 requires Java 21+ for emulators.

Firestore rules emulator result:

```sh
JAVA_HOME=/tmp/franchise-jdk21/jdk-21.0.11+10 PATH=/tmp/franchise-jdk21/jdk-21.0.11+10/bin:$PATH npm run test:emulator:rules
```

```text
src/shared/ledger/firestoreRules.integration.test.ts
5 tests passed
```

Callable emulator result:

```sh
JAVA_HOME=/tmp/franchise-jdk21/jdk-21.0.11+10 PATH=/tmp/franchise-jdk21/jdk-21.0.11+10/bin:$PATH npm run test:emulator:callables
```

```text
src/shared/ledger/callableRecalculation.integration.test.ts
2 tests passed
```

Temporary JDK verification:

```text
openjdk version "21.0.11" 2026-04-21 LTS
OpenJDK Runtime Environment Temurin-21.0.11+10
```

Note: the Functions emulator warned that the host Node runtime is 24 while Functions are configured for Node 20. The callable tests still passed; production Functions remain configured with Node 20.

## Local Verification

Passed:

- `npm test`
- `npm run build`
- `npm --prefix functions run build`
- `npm --prefix functions test`
- `node --check scripts/inspect-ledger-v2-report.mjs`
- Firestore rules dry-run
- May 2026 ledger v2 dry-run
- May 2026 Day 28-31 inspection
- Firestore rules emulator test
- Callable recalculation emulator test

Build note: Vite still reports the existing large bundle warning.

## Rollback

Before production apply, rollback is simple:

1. Leave `settings/ledger/config/main` at all `v1`, or delete the config document.
2. Do not run migration `--apply`.
3. Ignore or remove local `tmp/ledger-v2-2026-05-*.json` artifacts.
4. Revert this Phase 2 code if needed.

If a later reviewed v2 apply is performed, rollback should set read modes back to `v1` first, then stop invoking v2 recalculation callables. Old v1 data remains preserved.

## Next Deployment Steps

1. Review `tmp/ledger-v2-2026-05-report.json`.
2. Review `tmp/ledger-v2-2026-05-backup.json`.
3. Review `tmp/ledger-v2-2026-05-inspection.json`.
4. Review `docs/ledger-v2-production-safety-gate-apply-plan.md`.
5. Deploy Firestore rules only after review.
6. Deploy Functions only after emulator callable tests pass.
7. Do not run v2 apply until explicitly approved.
8. Set `settings/ledger/config/main.expenseReadMode` to `v2-shadow` only after apply and post-apply verification.
9. Compare v1 UI output to v2 projections.
10. Only after reviewed verification, set a `verifiedReportId` and consider hard `v2` read mode.
