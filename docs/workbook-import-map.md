# Workbook Import Map

Source workbook reviewed: `sheets/Expence-April-2026.xlsx`

The workbook contains `Home`, daily sheets `1` through `31`, and `FINAL`. The web importer now supports two modes:

- `Full Workbook`: imports expenses, commissions, owner/cash rows, and credit parties.
- `Expense Only`: imports only the daily expense rows.

## Sheet Inventory

| Sheet | Range | Non-empty cells | Formula cells |
| --- | --- | ---: | ---: |
| Home | A1:P70 | 707 | 603 |
| 1 | A1:Z41 | 129 | 43 |
| 2 | A1:X41 | 132 | 64 |
| 3 | A1:X41 | 134 | 64 |
| 4 | A1:X41 | 158 | 64 |
| 5 | A1:X41 | 119 | 64 |
| 6 | A1:X41 | 134 | 64 |
| 7 | A1:X43 | 128 | 64 |
| 8 | A1:X41 | 134 | 64 |
| 9 | A1:X42 | 129 | 64 |
| 10 | A1:X42 | 166 | 64 |
| 11 | A1:X41 | 126 | 64 |
| 12 | A1:X43 | 113 | 64 |
| 13 | A1:X41 | 123 | 64 |
| 14 | A1:X42 | 128 | 64 |
| 15 | A1:X41 | 133 | 64 |
| 16 | A1:X41 | 132 | 64 |
| 17 | A1:X41 | 132 | 64 |
| 18 | A1:X41 | 113 | 64 |
| 19 | A1:X41 | 113 | 64 |
| 20 | A1:X41 | 141 | 64 |
| 21 | A1:X42 | 128 | 64 |
| 22 | A1:X42 | 126 | 64 |
| 23 | A1:X41 | 129 | 64 |
| 24 | A1:AA41 | 126 | 64 |
| 25 | A1:X41 | 127 | 64 |
| 26 | A1:X41 | 113 | 64 |
| 27 | A1:X41 | 134 | 64 |
| 28 | A1:X41 | 137 | 64 |
| 29 | A1:X41 | 137 | 64 |
| 30 | A1:X41 | 133 | 64 |
| 31 | A1:X41 | 120 | 64 |
| FINAL | A1:X41 | 129 | 64 |

## Daily Sheet Layout

Applies to sheets `1` through `31` and `FINAL`. `FINAL` is stored as day `32`.

| Section | Cells | Imported as |
| --- | --- | --- |
| Expense headers | A2:C2 | `Name`, `Description`, `Amount` |
| Expense rows | A3:C29 | `expenses[]` |
| Expense total | C30 | Validation against calculated expense total |
| Commission rows | E3:F14 | `commissions[]` |
| Commission total | F15 | Validation against calculated commission total |
| Balance row | E18:I18 | Opening, issue, total, expense, return balances |
| Owner/cash rows | H3:I14 | `ownerBalances[]` |
| Owner/cash total | I15 | Validation reference |
| Credit headers | E21:I21 | Party, opening, loan/today, receive, balance |
| Credit rows | E22:I40 | `credits[]` |
| Credit totals | F41:I41 | Validation reference |
| Commission matrix | K4:X5 | Home-style commission category row |

Commission labels are read from `E3:E14`. Workbook labels such as `Jazz Cash` and `Jazz Load` are normalized to the system labels `JazzCash` and `JazzLoad`; duplicate `Other` rows are stored as `Other 1` and `Other 2`.

## Home Sheet Layout

| Section | Cells | Purpose |
| --- | --- | --- |
| Daily summary headers | A1:F1 | Date, opening, issue, total, expense, return |
| Daily summary rows | A2:F33 | Day `1` through `31` plus `FINAL` |
| Daily summary totals | C34 and E34 | Monthly issue and monthly expense validation |
| Commission summary | A37:N70 | Per-day commission totals by category |

The April workbook reviewed has:

- `Home!C34 = 1024626`
- `Home!E34 = 1024626`

## Import Behavior

Full workbook import reads every daily sheet and imports all operational sections. Expense-only import is intentionally narrow and should only be used when the user wants to replace expense rows without touching commission, owner/cash, or credit data.

The importer compares calculated month totals against the workbook Home totals and surfaces warnings before writing to Firestore.
