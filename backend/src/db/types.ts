import type { Generated, ColumnType } from "kysely";

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type Numeric = ColumnType<string, number | string, number | string>;

export interface FranchisesTable {
  id: Generated<string>;
  code: string;
  name: string;
  brand_name: string;
  is_active: boolean;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface UsersTable {
  id: Generated<string>;
  firebase_uid: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface FranchiseUsersTable {
  id: Generated<string>;
  franchise_id: string;
  user_id: string;
  role: "owner" | "admin" | "viewer";
  is_active: boolean;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AuthorizedEmailsTable {
  id: Generated<string>;
  franchise_id: string;
  email: string;
  role: "owner" | "admin" | "viewer";
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AccountingPeriodsTable {
  id: Generated<string>;
  franchise_id: string;
  period_key: string;
  year_num: number;
  month_num: number;
  label: string;
  status: "open" | "closed";
  closed_at: Timestamp | null;
  closed_by_user_id: string | null;
  reopened_at: Timestamp | null;
  reopened_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AccountingDaysTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  day_no: number;
  day_type: "calendar" | "settlement";
  calendar_date: string;
  label: string;
  status: "open" | "closed" | "reopen";
  closed_at: Timestamp | null;
  closed_by_user_id: string | null;
  reopened_at: Timestamp | null;
  reopened_by_user_id: string | null;
  reopened_until_at: Timestamp | null;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ExpenseCategoriesTable {
  id: Generated<string>;
  franchise_id: string;
  slug: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CommissionCategoriesTable {
  id: Generated<string>;
  franchise_id: string;
  slug: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CreditPartiesTable {
  id: Generated<string>;
  franchise_id: string;
  slug: string;
  name: string;
  type: "dealer" | "dso" | "staff" | "external" | "other";
  is_active: boolean;
  sort_order: number;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface JazzLoadRatesTable {
  id: Generated<string>;
  franchise_id: string;
  name: string;
  ml_rate: Numeric;
  comm1_rate: Numeric;
  comm2_rate: Numeric;
  effective_from: string;
  is_active: boolean;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface JazzLoadDoProfilesTable {
  id: Generated<string>;
  franchise_id: string;
  do_name: string;
  do_line: string | null;
  sort_order: number;
  is_active: boolean;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface StockProductsTable {
  id: Generated<string>;
  franchise_id: string;
  slug: string;
  name: string;
  rate: Numeric;
  payment_tracking_enabled: boolean;
  category: string | null;
  sort_order: number;
  is_active: boolean;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface StockAccountsTable {
  id: Generated<string>;
  franchise_id: string;
  slug: string;
  name: string;
  type: "DO" | "CCR" | "DSO" | "STOCK" | "OTHER";
  sort_order: number;
  is_active: boolean;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PeriodFinancialSeedsTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  opening_cash: Numeric;
  opening_owner_balance: Numeric;
  opening_jazz_lifting: Numeric;
  opening_jazz_payable: Numeric;
  source_period_key: string | null;
  source_day_no: number | null;
  verified_by_user_id: string | null;
  is_verified: boolean;
  notes: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PeriodCreditPartySeedsTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  party_id: string;
  opening_balance: Numeric;
  source_period_key: string | null;
  source_day_no: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PeriodStockProductSeedsTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  product_id: string;
  opening_quantity: number;
  source_period_key: string | null;
  source_day_no: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PeriodStockAccountSeedsTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  account_id: string;
  opening_receivable: Numeric;
  source_period_key: string | null;
  source_day_no: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PeriodJazzDoSeedsTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  do_profile_id: string;
  opening_base_balance: Numeric;
  source_period_key: string | null;
  source_day_no: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ExpenseItemsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  category_id: string | null;
  category_name_snapshot: string;
  item_name: string;
  description: string | null;
  amount: Numeric;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CommissionItemsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  category_id: string | null;
  category_name_snapshot: string;
  amount: Numeric;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CreditTransactionsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  party_id: string;
  party_name_snapshot: string;
  loan_amount: Numeric;
  receipt_amount: Numeric;
  manual_adjustment: Numeric;
  loan_description: string | null;
  receive_description: string | null;
  notes: string | null;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OwnerTransactionsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  description: string;
  amount: Numeric;
  notes: string | null;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface JazzLoadLiftingRecordsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  ml_lifting_amount: Numeric;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface JazzLoadDoEntriesTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  do_profile_id: string;
  do_name_snapshot: string;
  do_line_snapshot: string | null;
  issuance_base: Numeric;
  payment_base: Numeric;
  applied_ml_rate_percentage: Numeric;
  notes: string | null;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface StockOrdersTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  direction: "inbound" | "outbound";
  account_id: string | null;
  account_name_snapshot: string | null;
  supplier_name: string | null;
  invoice_reference: string | null;
  notes: string | null;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface StockOrderLinesTable {
  id: Generated<string>;
  stock_order_id: string;
  product_id: string;
  product_name_snapshot: string;
  unit_rate: Numeric;
  quantity: number;
  line_amount: Generated<Numeric>;
  created_at: Generated<Timestamp>;
}

export interface StockAccountPaymentsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  account_id: string;
  amount: Numeric;
  payment_method: string;
  notes: string | null;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface JazzCompanyPayablePaymentsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  amount: Numeric;
  payment_reference: string | null;
  notes: string | null;
  revision: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface DayFinancialProjectionsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  opening_cash: Numeric;
  total_issues: Numeric;
  total_expenses: Numeric;
  closing_cash: Numeric;
  owner_closing_balance: Numeric;
  calculated_at: Generated<Timestamp>;
  calculation_version: Generated<number>;
  calc_run_id: string | null;
}

export interface CreditPartyDayProjectionsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  party_id: string;
  opening_balance: Numeric;
  total_loans: Numeric;
  total_receipts: Numeric;
  manual_adjustments: Numeric;
  closing_balance: Numeric;
  calculated_at: Generated<Timestamp>;
}

export interface StockProductDayProjectionsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  product_id: string;
  opening_qty: number;
  stock_in_qty: number;
  stock_out_qty: number;
  closing_qty: number;
  calculated_at: Generated<Timestamp>;
}

export interface StockAccountDayProjectionsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  account_id: string;
  opening_due: Numeric;
  stock_taken_amount: Numeric;
  payment_received_amount: Numeric;
  closing_due: Numeric;
  calculated_at: Generated<Timestamp>;
}

export interface JazzLiftingDayProjectionsTable {
  id: Generated<string>;
  franchise_id: string;
  day_id: string;
  opening_lifting: Numeric;
  ml_lifting_purchased: Numeric;
  today_ml_issuance: Numeric;
  closing_lifting_in_hand: Numeric;
  calculated_at: Generated<Timestamp>;
}

export interface AuditLogsTable {
  id: Generated<string>;
  franchise_id: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_state: unknown;
  after_state: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<Timestamp>;
}

export interface CalculationRunsTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  trigger_source: string;
  from_day_no: number;
  to_day_no: number;
  status: "started" | "completed" | "failed";
  duration_ms: Numeric | null;
  error_message: string | null;
  executed_by_user_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface InvariantViolationsTable {
  id: Generated<string>;
  franchise_id: string;
  period_id: string;
  day_id: string | null;
  invariant_code: string;
  severity: "critical" | "error" | "warning";
  message: string;
  details: unknown;
  resolved_at: Timestamp | null;
  resolved_by_user_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface MigrationIdempotencyMapTable {
  id: Generated<string>;
  franchise_id: string;
  firestore_collection: string;
  firestore_doc_id: string;
  source_type: "embedded_array" | "parent_doc_field" | "master_catalog";
  firestore_row_id: string;
  pg_table: string;
  pg_record_id: string;
  migrated_at: Generated<Timestamp>;
  migrated_by_user_id: string | null;
}

export interface MutationIdempotencyTable {
  id: Generated<string>;
  franchise_id: string;
  client_mutation_id: string;
  user_id: string | null;
  endpoint: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
  created_at: Generated<Timestamp>;
}

/**
 * Complete Kysely Database Interface mapping all 37 tables.
 */
export interface Database {
  franchises: FranchisesTable;
  users: UsersTable;
  franchise_users: FranchiseUsersTable;
  authorized_emails: AuthorizedEmailsTable;
  accounting_periods: AccountingPeriodsTable;
  accounting_days: AccountingDaysTable;
  expense_categories: ExpenseCategoriesTable;
  commission_categories: CommissionCategoriesTable;
  credit_parties: CreditPartiesTable;
  jazz_load_rates: JazzLoadRatesTable;
  jazz_load_do_profiles: JazzLoadDoProfilesTable;
  stock_products: StockProductsTable;
  stock_accounts: StockAccountsTable;
  period_financial_seeds: PeriodFinancialSeedsTable;
  period_credit_party_seeds: PeriodCreditPartySeedsTable;
  period_stock_product_seeds: PeriodStockProductSeedsTable;
  period_stock_account_seeds: PeriodStockAccountSeedsTable;
  period_jazz_do_seeds: PeriodJazzDoSeedsTable;
  expense_items: ExpenseItemsTable;
  commission_items: CommissionItemsTable;
  credit_transactions: CreditTransactionsTable;
  owner_transactions: OwnerTransactionsTable;
  jazz_load_lifting_records: JazzLoadLiftingRecordsTable;
  jazz_load_do_entries: JazzLoadDoEntriesTable;
  stock_orders: StockOrdersTable;
  stock_order_lines: StockOrderLinesTable;
  stock_account_payments: StockAccountPaymentsTable;
  jazz_company_payable_payments: JazzCompanyPayablePaymentsTable;
  day_financial_projections: DayFinancialProjectionsTable;
  credit_party_day_projections: CreditPartyDayProjectionsTable;
  stock_product_day_projections: StockProductDayProjectionsTable;
  stock_account_day_projections: StockAccountDayProjectionsTable;
  jazz_lifting_day_projections: JazzLiftingDayProjectionsTable;
  audit_logs: AuditLogsTable;
  calculation_runs: CalculationRunsTable;
  invariant_violations: InvariantViolationsTable;
  migration_idempotency_map: MigrationIdempotencyMapTable;
  mutation_idempotency: MutationIdempotencyTable;
}
