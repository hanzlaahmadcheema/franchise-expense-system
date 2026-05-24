# Franchise Expense System

A Firestore-backed franchise operating ledger that converts the existing monthly Excel workbook process into a web dashboard. The system imports the workbook, keeps daily records in Firestore, recalculates balances automatically, shows reports/charts, and exports backup packages so the data is not trapped in browser storage.

## Contents

- [What This App Is For](#what-this-app-is-for)
- [Tech Stack](#tech-stack)
- [Firebase Setup](#firebase-setup)
- [Local Setup](#local-setup)
- [Daily Usage Flow](#daily-usage-flow)
- [Excel Import Workflow](#excel-import-workflow)
- [Daily Entry Workflow](#daily-entry-workflow)
- [Dashboard And Reports](#dashboard-and-reports)
- [Backup And Restore](#backup-and-restore)
- [Firestore Data Model](#firestore-data-model)
- [Testing And Build](#testing-and-build)
- [Deploy](#deploy)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

## What This App Is For

The original workbook is the source model for the system. The app is designed to become one entrance for the whole franchise operating flow:

- Import an existing monthly workbook.
- Manually enter or correct daily activity.
- Track expenses with categories.
- Track commissions.
- Track owner/cash balances.
- Track credit parties and aging.
- Compare workbook totals with calculated totals.
- Review a dashboard instead of reading every sheet manually.
- Export reports and full backup packages.

The current configured month format is:

```text
YYYY-MM
```

Example:

```text
2026-04
```

## Tech Stack

- Vite
- React
- TypeScript
- Tailwind CSS through the official Vite plugin
- Firebase Auth
- Cloud Firestore
- Firebase Functions
- Recharts
- Lucide React
- SheetJS `xlsx`

Tailwind is configured without PostCSS. The project uses `@tailwindcss/vite` in [vite.config.ts](vite.config.ts).

## Firebase Setup

Current project:

```text
franchise-expense-system
```

Required Firebase services:

- Authentication
- Anonymous sign-in provider
- Cloud Firestore
- Firestore rules and indexes

The web app reads Firebase config from `.env`.

Required variables:

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

Use [.env.example](.env.example) as the template.

Deploy Firestore rules and indexes:

```bash
firebase deploy --only firestore --project franchise-expense-system
```

## Local Setup

Install frontend dependencies:

```bash
npm install
```

Install Firebase Functions dependencies:

```bash
cd functions
npm install
cd ..
```

Run the app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

On load, the app signs in anonymously and creates/loads the current user profile in Firestore.

## Daily Usage Flow

1. Open the app.
2. Check the header status.
3. It should say:

```text
Connected to Firestore
```

4. Enter the month ID.
5. Enter the opening balance.
6. Click `Load / Create`.
7. Use `Excel Import` if you are starting from a workbook.
8. Use `Daily Entry` for day-to-day input.
9. Use `Dashboard` for review, export, print, backup, and month closing.

Main tabs:

- `Dashboard`: KPI cards, charts, reports, export, backup, close/reopen month.
- `Daily Entry`: one screen for the daily ledger.
- `Excel Import`: workbook upload and validation.
- `System Blueprint`: the product direction and formula understanding.

## Excel Import Workflow

Use this when you already have a monthly workbook, for example:

```text
Expence-April-2026.xlsx
```

Steps:

1. Go to `Excel Import`.
2. Choose the `.xlsx` or `.xls` file.
3. Wait for parsing.
4. Review:
   - file name
   - imported period count
   - calculated issue total
   - calculated expense total
   - workbook Home totals
   - warnings
5. Check the preview dashboard.
6. Click `Save Imported Month to Firestore`.

Imported sheets:

- `Home`
- Day sheets `1` through `31`
- `FINAL`

`FINAL` is stored as period/day `32` and is treated as the final adjustment period.

Workbook validation currently compares calculated totals against:

```text
Home!C34 -> monthly issue total
Home!E34 -> monthly expense total
```

Imported sections:

- Expenses from workbook expense columns.
- Commissions from workbook commission columns.
- Owner/cash balances.
- Credit party rows.
- Day labels and final period labels.

If warnings appear, review them before saving. Warnings usually mean a sheet was missing, totals did not match, or the workbook layout did not fully match the expected structure.

## Daily Entry Workflow

Use `Daily Entry` for new days, corrections, or periods not imported from Excel.

Steps:

1. Go to `Daily Entry`.
2. Select `Day / Period`.
3. Use `1` through `31` for normal days.
4. Use `32` for the `FINAL` adjustment period.
5. Fill the daily rows.
6. Click `Save Day`.

Daily entry supports:

- Date label
- Notes
- Expenses
- Expense categories
- Commission rows
- Owner/cash balance rows
- Credit party rows
- Previous credit balance carry-forward
- Quick expense presets

Balance behavior:

- Day `1` starts from the month opening balance.
- Day `2` and onward use the previous day return balance as the next opening value.
- Credit-party balances can carry from the previous day.
- Saving a day recalculates the month dashboard.

Closed month behavior:

- A closed month is read-only in the UI.
- Click `Reopen Month` before making edits.
- Click `Close Month` when the month is ready for owner review.

## Dashboard And Reports

The dashboard is the main operating view. It shows:

- Issue total
- Expense total
- Final return
- Credit exposure
- Daily flow chart
- Expense mix chart
- Commission breakdown chart
- Operating signals
- Missing days
- Negative return periods
- Daily ledger table
- Credit party aging table

Dashboard actions:

- `Export Excel`: downloads a report workbook for the active month.
- `Print / PDF`: opens the browser print dialog.
- `Export Backup`: downloads all Firestore months and day records as JSON.
- `Import Backup`: restores months from a JSON backup package.

## Backup And Restore

Use backup packages before big imports, major corrections, or deployment changes.

Export backup:

1. Go to `Dashboard`.
2. Click `Export Backup`.
3. A JSON file downloads with all months and day records.

Backup file naming:

```text
franchise-backup-YYYY-MM-DD.json
```

Import backup:

1. Go to `Dashboard`.
2. Click `Import Backup`.
3. Choose a previous backup JSON file.
4. The app writes the months and day records back to Firestore.

Important: restore currently writes/merges records. It does not fully delete old subcollection rows that are missing from the backup.

## Firestore Data Model

Main structure:

```text
users/{uid}
months/{monthId}
months/{monthId}/days/{dayNo}
months/{monthId}/days/{dayNo}/expenses/{expenseId}
months/{monthId}/days/{dayNo}/commissions/{commissionId}
months/{monthId}/days/{dayNo}/credits/{creditId}
months/{monthId}/days/{dayNo}/ownerBalances/{ownerBalanceId}
months/{monthId}/summary/home
months/{monthId}/audit/{eventId}
```

User document:

```text
users/{uid}
```

Stores:

- `uid`
- `email`
- `role`
- `active`
- timestamps

Month document:

```text
months/{monthId}
```

Stores:

- month ID
- label
- opening balance
- status
- imported file name
- timestamps

Day document:

```text
months/{monthId}/days/{dayNo}
```

Stores:

- day number
- label
- date
- notes
- timestamps

Day row details are stored in subcollections so expenses, commissions, credits, and owner balances can grow independently.

## Testing And Build

Run unit tests:

```bash
npm test
```

Build the frontend:

```bash
npm run build
```

Build Firebase Functions:

```bash
cd functions
npm run build
cd ..
```

Run the workbook reconciliation script:

```bash
npm run reconcile
```

The reconcile script reads the workbook and reports the Home totals used for comparison.

## Deploy

Deploy Firestore rules only:

```bash
firebase deploy --only firestore --project franchise-expense-system
```

Deploy Functions only:

```bash
firebase deploy --only functions --project franchise-expense-system
```

Build and deploy Hosting:

```bash
npm run build
firebase deploy --only hosting --project franchise-expense-system
```

Deploy everything configured in [firebase.json](firebase.json):

```bash
firebase deploy --project franchise-expense-system
```

## Troubleshooting

### Firebase Config Missing

Cause: `.env` is missing or one of the `VITE_FIREBASE_*` values is empty.

Fix:

1. Copy `.env.example` to `.env`.
2. Fill the Firebase web app config.
3. Restart Vite.

### Enable Anonymous Auth

Cause: anonymous sign-in is disabled in Firebase Authentication.

Fix:

1. Open Firebase Console.
2. Go to Authentication.
3. Enable the Anonymous provider.
4. Reload the app.

### Permission Denied

Cause: Firestore rules were not deployed, the user profile is inactive, or the request is unauthenticated.

Fix:

```bash
firebase deploy --only firestore --project franchise-expense-system
```

Then reload the app and confirm the header says `Connected to Firestore`.

### Workbook Totals Do Not Match

Cause: the workbook layout is different from the expected format, or manual rows were placed outside the parsed ranges.

Fix:

1. Check the import warnings.
2. Compare the workbook `Home!C34` and `Home!E34` values with the preview.
3. Save only after the difference is understood.

### Old Rows Still Appear After Editing

Cause: row replacement currently merges subcollection documents and does not fully remove old row documents.

Fix for now:

- Edit old rows to zero or overwrite them.
- Add delete/replace cleanup logic before production use.

## Known Limitations

- Anonymous auth is useful for MVP testing, but production should use email/password or Google login.
- Owner/staff management does not have a full UI yet.
- Removed row cleanup is not fully implemented for nested Firestore subcollections.
- Month-to-month comparison exists as a product goal, but deeper comparison workflows can still be expanded.
- Bundle size can be improved by lazy-loading workbook import and chart libraries.
- Import validation is tuned for the current workbook structure and should be expanded if the sheet layout changes.

