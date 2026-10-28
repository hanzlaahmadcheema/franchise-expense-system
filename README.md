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
- [Offline Mode Behavior](#offline-mode-behavior)
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
- Track Jazz Load in a separate ledger module with DO balances, Jazz Load calculations, lifting, payment reports, and owner-managed rates.
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
- Google sign-in provider
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
VITE_FIRESTORE_CACHE_MODE=
VITE_FIRESTORE_FORCE_LONG_POLLING=
```

Use [.env.example](.env.example) as the template.

`VITE_FIRESTORE_CACHE_MODE` is optional. Local Vite development defaults to `memory` cache to avoid stale IndexedDB listener crashes during HMR. Production defaults to `persistent` cache for shop-machine offline work. Set it to `persistent` locally only when testing offline IndexedDB behavior.

`VITE_FIRESTORE_FORCE_LONG_POLLING` is optional. Local Vite development defaults to `true` to avoid Firestore WebChannel watch-stream crashes in some browsers/extensions/proxies. Production defaults to `false`.

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

Configure Gmail SMTP environment variables for owner activity notifications.

Create `functions/.env.franchise-expense-system`:

```bash
GMAIL_SMTP_USER=your-gmail-address@gmail.com
GMAIL_SMTP_APP_PASSWORD=your-google-app-password
```

`GMAIL_SMTP_USER` is the Gmail address used to send notifications and appears as the email `From` address. The Gmail account must have 2-step verification enabled; use a Google App Password for `GMAIL_SMTP_APP_PASSWORD`, not the normal Gmail password. Do not use `firebase functions:secrets:set` unless the project is upgraded to Blaze, because Firebase secrets require Secret Manager.

Run the app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

On load, the app requires an authorized Google account. Anonymous sign-in and email/password sign-in are not used in the UI. New users must already be allowed by an owner in `Users` -> `Authorized Emails`; after sign-in the app creates/loads the matching Firestore user profile and applies the assigned `owner`, `admin`, or `viewer` role.

## Daily Usage Flow

1. Open the app.
2. Sign in with an authorized account.
3. Check the sidebar status.
4. It should say:

```text
Connected to Firestore
```

5. Select the active month, for example `2026-04`.
6. Click `Load`.
7. Use `Excel Import` if you are starting from a workbook.
8. Use `Expense` -> `Daily Entry` for day-to-day input.
9. Use `Dashboard` for review, export, print, and month status.

Global sidebar:

- `Dashboard`: KPI cards, charts, reports, export, backup, close/reopen month.
- `Previous Records`: read-only whole-month dashboard/table view plus single-date record lookup.
- `Expense`: top-tab workspace for daily entry, dashboard review, expense categories, credit parties, and commission categories.
- `Jazz Load`: separate Jazz Load Ledger workspace for DO entry, rate settings, reports, and Jazz-only backup/export.
- `Users`: owner-only user role management.
- `Excel Import`: owner/admin workbook upload and validation.
- `Backup`: owner/admin backup export and restore.

Roles:

- `owner`: full access, including users, imports, backups, month close/reopen, and deletes allowed by rules.
- `admin`: current-day entry, catalog management, Excel import, and backup access; previous dates/months are view-only for direct edits.
- `viewer`: read-only dashboard/report access.

The theme toggle in the sidebar switches between light and dark mode and stores the preference in the browser.

## Jazz Load Ledger

Jazz Load is a separate module. It does not merge Jazz Load values into normal expenses, commissions, owner balances, credit parties, dashboard totals, or workbook import totals.

Use `Jazz Load` from the sidebar:

1. Owner opens `Settings` and creates active rates for Jazz Load Addition, Commission 1 Adjustment, and Commission 2 Payment. Daily Jazz Load entry is blocked until all three active rates exist.
2. Owner/admin creates DO Names and DO Lines separately. A fixed line can be assigned to different names on different dates.
3. Operator opens `Daily Entry` and selects a date from the Jazz Load calendar.
4. The table automatically creates one row per active DO Line. Choose the DO Name directly in that line row, then enter base issuance and payment amounts.
5. The system autosaves the day, calculates read-only Jazz Load and commission values from active rate snapshots, and stores the DO name/line assignment snapshot with each saved entry.
6. Lifting uses one `Jazz Load Lifting` field. Today Jazz Load issuance is derived from DO rows.
7. Dashboard and reports show Jazz Load-only totals.

Jazz Load formulas:

```text
Jazz Load value = base amount + (base amount * active Jazz Load percentage / 100)
Day Total Base = Opening Base + Today Jazz Load Issuance Base
Closing Base = Day Total Base - Payment Received Base
Lifting In-Hand = Opening Balance + Jazz Load Lifting - Today Jazz Load Issuance
Commission 1 Jazz Load Deduction = Payment Jazz Load Total * active Commission 1 percentage / 100
Commission 1 Adjusted Payment = Payment Jazz Load Total - Commission 1 Jazz Load Deduction
Commission 1 = Payment Base Total - Commission 1 Adjusted Payment
Commission 2 = Payment Base Total * active Commission 2 percentage / 100
Total Day Commission = Commission 1 + Commission 2
```

Roles:

- `owner`: manage calculation rates, DO profiles, month close/reopen, daily records, reports, and backup/restore.
- `admin`: create/edit open daily records, manage DO profiles, view reports, and export backup.
- `viewer`: view Jazz Load dashboard and reports only.

Old Jazz Load records are not recalculated when the owner changes rates later. New saves store the current Jazz Load Addition, Commission 1 Adjustment, and Commission 2 Payment rate snapshots with the day.

Calendar behavior:

- Future Jazz Load days are disabled and cannot create records.
- Past saved days can be opened from the calendar for review and printing.
- Active DO Lines determine the daily row count automatically.
- Closed days are read-only unless owner/admin opens a 15-minute correction window.
- Closing a corrected day returns it to read-only history.

## Excel Import Workflow

Use this when you already have a monthly workbook, for example:

```text
Expence-April-2026.xlsx
```

Steps:

1. Go to `Excel Import`.
2. Select the target `Import Month`.
3. Select the import type. Use `Full Workbook` for the normal monthly import, or `Expense Only` when only expense rows should be replaced.
4. Choose the `.xlsx` or `.xls` file.
5. Wait for parsing.
6. Review:
   - target month
   - import type
   - file name
   - imported period count
   - calculated issue total
   - calculated expense total
   - workbook Home totals
   - warnings
7. Check the preview dashboard.
8. Click `Save Full Workbook Import to Firestore` or `Save Expense Only Import to Firestore`.

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

- Expenses from workbook columns `A:C`.
- Commissions from workbook columns `E:F`.
- Owner/cash rows from workbook columns `H:I`.
- Credit parties from workbook columns `E:I`.
- Day labels and final period labels.

The detailed workbook cell map is documented in [`docs/workbook-import-map.md`](docs/workbook-import-map.md).

If warnings appear, review them before saving. Warnings usually mean a sheet was missing, totals did not match, or the workbook layout did not fully match the expected structure.

## Daily Entry Workflow

Use `Expense` -> `Daily Entry` for new days, corrections, or periods not imported from Excel.

Steps:

1. Go to `Expense`.
2. Open the `Daily Entry` tab.
3. Select `Day / Period`.
4. Use `1` through `31` for normal days.
5. Use `32` for the `FINAL` adjustment period.
6. Fill the daily rows. Changes autosave every second while the day is editable.
7. Click `Close Day` at the end of the day.

Daily entry supports:

- UTC-locked date label and live UTC clock
- Notes
- Day dropdown from `Day 1` to `Day 31` plus `FINAL`
- Expenses with managed category IDs
- User-managed commission category dropdowns, ordered from the commission category catalog
- Separate franchise owner rows: opening, description, amount, calculated balance
- Separate credit party rows: party ID, opening, loan, receive, calculated balance
- Previous credit balance carry-forward
- One-second autosave for editable daily entries
- `Close Day` lock for end-of-day completion
- Right-side summary for opening balance, commission, expense, balance, and credit

Balance behavior:

- New month opening balance is read from day `32` of the previous month when available.
- If previous month day `32` does not exist, opening balance defaults to `0`.
- Day `1` starts from the resolved month opening balance.
- Day `2` and onward use the previous day balance as the next opening value.
- Credit-party balances carry by party ID.
- Autosaving a day recalculates the month dashboard.
- Automated formula fields are read-only in the UI for owner and admin.

Closed day behavior:

- Closing a day locks that day record.
- A closed current day can be reopened and stays editable until it is manually closed again.
- Previous days are closed by default and can be reopened for a 15-minute correction window.
- Owner and admin users can reopen allowed closed days; viewer users remain read-only.

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
- Negative balance periods
- Daily ledger table
- Credit party aging table

Dashboard actions:

- `Export Monthly Excel`: downloads a formatted workbook-style report for the active month.
- `Export Monthly PDF`: opens a formatted monthly PDF/print report.
- `Export Daily Excel`: downloads a formatted report for the selected saved day from Daily Entry.
- `Export Daily PDF`: opens a formatted daily PDF/print report for the selected saved day.
- Monthly and daily reports include franchise owner balance data.
- `Export Backup`: downloads all Firestore months and day records as JSON.
- `Import Backup`: restores months from a JSON backup package.

## Backup And Restore

Use backup packages before big imports, major corrections, or deployment changes.

Export backup:

1. Go to `Backup`.
2. Click `Export Backup`.
3. A JSON file downloads with all normal ledger months/day records plus a separate `jazzLoad` group.

The `jazzLoad` backup group contains:

- Jazz Load months
- Jazz Load days and DO entries
- DO Names, DO Lines, and dated DO assignment snapshots
- calculation rates
- legacy commission rules
- DO profiles

Backup file naming:

```text
franchise-backup-YYYY-MM-DD.json
```

Import backup:

1. Go to `Backup`.
2. Click `Import Backup`.
3. Choose a previous backup JSON file.
4. The app writes normal ledger months/day records and Jazz Load data back to Firestore.

Important: restore currently writes/merges records. It does not fully delete old subcollection rows that are missing from the backup.

If the app is offline and the full month has not been cached on this device, reconnect before creating a final backup:

```text
Some records may not be available offline. Reconnect before final backup.
```

## Offline Mode Behavior

The application provides local and offline resilience for ledger operations.

The sidebar sync labels mean:

- `Connected to Firestore`: the signed-in account can reach Firestore.
- `Offline mode - changes saved locally`: the device is offline, and allowed edits are saved in the local queue.
- `Syncing changes...`: local writes are waiting for acknowledgment.
- `All changes synced`: visible local writes have been acknowledged.
- `Firestore permission/error`: rejected or failed read/write operation.

When offline edits are pending, the app keeps Daily Entry save/close usable for roles that can normally edit and shows:

```text
Owner will see updates after this machine reconnects.
```

## Firestore Data Model

Main structure:

```text
users/{uid}
settings/expenseCategories/items/{categoryId}
settings/creditParties/items/{partyId}
settings/commissionCategories/items/{categoryId}
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
- `role`: `owner`, `admin`, or `viewer`
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

### Automatic Deploy On Commit

Commits pushed to `main` run `.github/workflows/firebase-deploy.yml`. The workflow builds the frontend, builds/tests Firebase Functions, then deploys Hosting, Functions, Firestore rules, and Firestore indexes to `franchise-expense-system`.

GitHub repository setup required:

- Secret `FIREBASE_SERVICE_ACCOUNT`: JSON key for a Google service account with permission to deploy Firebase Hosting, Functions, Firestore rules, and indexes.
- Repository variables matching `.env.example`: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, and `VITE_FIREBASE_APP_ID`.

## Troubleshooting

### Firebase Config Missing

Cause: `.env` is missing or one of the `VITE_FIREBASE_*` values is empty.

Fix:

1. Copy `.env.example` to `.env`.
2. Fill the Firebase web app config.
3. Restart Vite.

### Enable Google Auth

Cause: Google sign-in is disabled in Firebase Authentication.

Fix:

1. Open Firebase Console.
2. Go to Authentication.
3. Enable the Google provider.
4. Reload the app.

### Permission Denied

Cause: Firestore rules were not deployed, the user profile is inactive, or the request is unauthenticated.

Fix:

```bash
firebase deploy --only firestore --project franchise-expense-system
```

Then reload the app and confirm the sidebar says `Connected to Firestore`.

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

- Owner-authorized Google emails control who can enter the app.
- Users must be added in `Users -> Authorized Emails` before they can sign in.
- Removed row cleanup is not fully implemented for nested Firestore subcollections.
- Month-to-month comparison exists as a product goal, but deeper comparison workflows can still be expanded.
- Bundle size can be improved by lazy-loading workbook import and chart libraries.
- Import validation is tuned for the current workbook structure and should be expanded if the sheet layout changes.
