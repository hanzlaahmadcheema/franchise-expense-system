# Stock Ledger Canvas Update — Remove Supplier Complexity

Update the Stock Ledger requirement: do **not** create Supplier Management, Supplier Profiles, multi-supplier reports, or supplier/source settings. The business receives stock from only one fixed source: **Jazz Company**. Therefore, Stock In should be handled as a simple **Stock In from Jazz Company** workflow, not a supplier-based purchase module.

## Updated Stock Module Sections

Use these main sections:

```text
Stock Dashboard
Stock In from Jazz Company
Stock Out / Allotment
Daily Stock Entry
Previous Stock Records
Current Stock Balance
Jazz Company Payable
CCR / DO / DSO Dues
Product Summary
Account Summary
Stock Settings
Stock Backup / Export
```

Remove these sections completely:

```text
Supplier / Source Settings
Supplier Payable Report
Supplier Profiles
Supplier-wise Credit Report
Multi-supplier Purchase Management
```

## Updated Stock In Workflow

Stock In means stock received from **Jazz Company**.

Workflow:

```text
Select Date
→ Enter product-wise stock received from Jazz Company
→ Select Stock In Mode: Cash or Credit
→ System snapshots product rates
→ System calculates total stock-in amount
→ Enter paid amount if any
→ System calculates Jazz Company payable
→ Save Stock In record
→ Increase current product stock
→ Update Jazz payable balance
→ Update stock reports
```

Data model:

```ts
type StockInRecord = {
  id: string;
  date: string;
  monthId: string;

  sourceName: "Jazz Company";

  stockInMode: "cash" | "credit";

  products: StockProductLine[];

  totalQty: number;
  totalAmount: number;
  paidAmount: number;
  jazzPayableAmount: number;

  notes?: string;

  createdBy: string;
  updatedBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
```

Formula:

```text
productAmount = quantity * productRateSnapshot
totalAmount = sum(productAmount)
jazzPayableAmount = totalAmount - paidAmount
```

For running payable:

```text
currentJazzPayable = previousJazzPayable + totalAmount - paidAmount
```

Rules:

```text
Cash stock-in should normally have full paid amount and zero payable.
Credit stock-in may have full unpaid or partial paid amount.
Jazz payable must stay separate from CCR/DO/DSO customer dues.
Stock In increases available product stock.
Stock Out decreases available product stock.
```

## Updated Stock Settings

Stock Settings should only include:

```text
Products
CCR / DO / DSO Accounts
Opening Stock
Jazz Opening Payable
Permissions if needed
```

Remove:

```text
Suppliers
Sources
Supplier Types
Supplier Opening Payables
```

## Updated Jazz Payable Ledger

Create a dedicated **Jazz Company Payable** ledger.

This represents the money business owes to Jazz Company.

Formula:

```text
Jazz Payable = Previous Jazz Payable + Stock In Amount - Paid Amount
```

Report fields:

```text
Date
Stock In Mode: Cash/Credit
Total Stock Received
Total Stock Amount
Paid Amount
Remaining Jazz Payable
Running Jazz Payable
```

Do not mix Jazz payable with customer dues.

```text
Jazz payable = money we owe Jazz Company
CCR/DO/DSO due = money others owe us
```

## Updated Current Stock Formula

```text
currentStock = openingStock + totalStockInFromJazz - totalStockOut + returns - damageAdjustments
```

At minimum implement:

```text
openingStock
stockInFromJazz
stockOut
currentStock
```

## Updated Firestore Structure

Use this structure:

```text
stockSettings/products/items/{productId}
stockSettings/accounts/items/{accountId}
stockSettings/opening/main

stockMonths/{monthId}
stockMonths/{monthId}/days/{date}
stockMonths/{monthId}/days/{date}/stockIn/{stockInId}
stockMonths/{monthId}/days/{date}/stockOut/{stockOutId}
stockMonths/{monthId}/summary/monthly
stockMonths/{monthId}/audit/{auditId}

stockBalances/products/{productId}
stockBalances/accounts/{accountId}
stockBalances/jazzCompany/main
```

Do not create:

```text
stockSettings/suppliers
stockBalances/suppliers
supplierReports
```

## Updated Reports

Required reports:

```text
Current Stock Report
Stock In from Jazz Report
Stock Out Report
Product-wise Stock Movement
CCR/DO/DSO Due Report
Jazz Company Payable Report
Daily Stock Summary
Monthly Stock Summary
Low Stock Report
Payment Recovery Report
```

Remove:

```text
Supplier Payable Report
Supplier-wise Stock Report
Multi-supplier Credit Report
```

## Updated Validation

Before saving Stock In:

```text
Date is required.
Future date is blocked.
Products must exist.
Product rates must exist.
Quantities must be valid numbers.
Paid amount must be valid number.
Stock In mode must be Cash or Credit.
No NaN values.
Admin cannot edit closed previous records.
Viewer cannot write.
```

For cash mode:

```text
Warn if paidAmount is less than totalAmount.
```

For credit mode:

```text
Allow full or partial unpaid amount.
```

## Updated Role Permissions

Owner can:

```text
Manage products
Manage product rates
Manage CCR/DO/DSO accounts
Set opening stock
Set Jazz opening payable
Add/edit Stock In from Jazz
Add/edit Stock Out
View Jazz payable
Close/reopen days
Export/backup
View all reports
```

Admin can:

```text
Add current-day Stock In from Jazz
Add current-day Stock Out
Enter payments
Print current-day records
View allowed reports
```

Admin cannot:

```text
Manage product rates
Manage stock settings
Change Jazz opening payable
Reopen previous closed days
Delete historical records
```

Viewer can only view allowed dashboards/reports.

## Updated Backup Group

Use:

```json
{
  "stock": {
    "settings": {
      "products": [],
      "accounts": [],
      "openingStock": [],
      "jazzOpeningPayable": {}
    },
    "records": {
      "stockInFromJazz": [],
      "stockOut": []
    },
    "balances": {
      "products": [],
      "accounts": [],
      "jazzCompany": {}
    },
    "summaries": []
  }
}
```

## Updated Hard Restrictions

Do not create supplier management.

Do not create supplier profiles.

Do not create supplier-wise reports.

Do not create multi-supplier complexity.

Do not mix Jazz payable with CCR/DO/DSO dues.

Do not treat Stock as only stock-out/allotment.

The Stock Ledger must track both:

```text
Stock In from Jazz Company
Stock Out to CCR/DO/DSO
Current Stock Balance
Jazz Company Payable
CCR/DO/DSO Customer Dues
```
