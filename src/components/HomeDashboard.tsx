import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  CalendarDays,
  Coins,
  FileSpreadsheet,
  Info,
  Landmark,
  Layers,
  Package,
  PackageOpen,
  ReceiptText,
  ShoppingCart,
  Tags,
  TrendingUp,
  WalletCards
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { MonthComputed } from "../types/ledger";
import { subscribeJazzLoadMonthlySummary } from "../modules/jazzLoad/services/jazzLoadFirestore";
import { subscribeStockMonthlySummary } from "../modules/stock/services/stockFirestore";
import type { JazzLoadMonthlySummary } from "../modules/jazzLoad/types/jazzLoad.types";
import type { StockMonthlySummary } from "../modules/stock/types/stock.types";

type Props = {
  month: MonthComputed | null;
  monthId?: string;
};

const chartColors = ["#34d399", "#60a5fa", "#fbbf24", "#f87171", "#a78bfa", "#22d3ee"];

function money(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function compactMoney(value: number) {
  return Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function tooltipMoney(value: unknown) {
  return money(Number(value ?? 0));
}

function MetricCard({
  label,
  value,
  helper,
  icon: Icon,
  tone = "emerald"
}: {
  label: string;
  value: string;
  helper: string;
  icon: typeof Banknote;
  tone?: "emerald" | "blue" | "amber" | "rose" | "cyan" | "orange";
}) {
  const tones = {
    emerald: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
    blue: "bg-blue-400/10 text-blue-300 ring-blue-400/20",
    amber: "bg-amber-400/10 text-amber-300 ring-amber-400/20",
    rose: "bg-rose-400/10 text-rose-300 ring-rose-400/20",
    cyan: "bg-cyan-400/10 text-cyan-300 ring-cyan-400/20",
    orange: "bg-orange-400/10 text-orange-300 ring-orange-400/20"
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-400">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">{value}</p>
        </div>
        <div className={`rounded-lg p-2 ring-1 ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500 sm:mt-4 sm:text-sm">{helper}</p>
    </div>
  );
}

export function HomeDashboard({ month, monthId }: Props) {
  const activeMonthId = monthId || month?.monthId || "";
  const [activeTab, setActiveTab] = useState<"overview" | "expense" | "jazzload" | "stock">("overview");

  const [jazzLoadSummary, setJazzLoadSummary] = useState<JazzLoadMonthlySummary | null>(null);
  const [stockSummary, setStockSummary] = useState<StockMonthlySummary | null>(null);

  const [chartsReady, setChartsReady] = useState(false);
  // Subscribe to summaries
  useEffect(() => {
    if (!activeMonthId) return;

    const unsubJazz = subscribeJazzLoadMonthlySummary(
      activeMonthId,
      (summary) => setJazzLoadSummary(summary),
      (err) => console.error("Error subscribing to Jazz Load summary:", err)
    );

    const unsubStock = subscribeStockMonthlySummary(
      activeMonthId,
      (summary) => setStockSummary(summary),
      (err) => console.error("Error subscribing to Stock summary:", err)
    );

    return () => {
      unsubJazz();
      unsubStock();
    };
  }, [activeMonthId]);

  useEffect(() => {
    setChartsReady(false);
    const id = window.setTimeout(() => setChartsReady(true), 150);
    return () => window.clearTimeout(id);
  }, [activeMonthId, activeTab, month?.days.length]);

  if (!activeMonthId) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
          <Landmark className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-white">No active month selected</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
          Please select or create an active month from the left sidebar or the main panel to view reports.
        </p>
      </section>
    );
  }

  // --- Calculations for Expense ---
  const expenseCommissionTotals = new Map<string, number>();
  if (month) {
    for (const row of month.homeSummary.commissionMatrix) {
      for (const [category, amount] of Object.entries(row.byCategory)) {
        expenseCommissionTotals.set(category, (expenseCommissionTotals.get(category) ?? 0) + amount);
      }
    }
  }
  const totalExpenseCommission = [...expenseCommissionTotals.values()].reduce((a, b) => a + b, 0);

  // --- Calculations for Grand Totals (Consolidated Overview) ---
  const grandVolume =
    (month?.homeSummary.monthlyIssueTotal || 0) +
    (jazzLoadSummary?.totalIssuanceBase || 0) +
    (stockSummary?.totalAmount || 0);

  const grandPayments =
    (month?.homeSummary.monthlyReturnBalance || 0) +
    (jazzLoadSummary?.totalPaymentsBase || 0) +
    (stockSummary?.totalPaymentReceived || 0);

  const grandCommission =
    totalExpenseCommission +
    (jazzLoadSummary?.totalCommission || 0);

  const grandCredit =
    (month?.homeSummary.creditBalanceTotal || 0) +
    (jazzLoadSummary?.totalClosingBase || 0) +
    (stockSummary?.totalDueBalance || 0);

  // Consolidated Module Contributions for BarChart
  const consolidatedContributionData = [
    { name: "Expense Ledger", Volume: month?.homeSummary.monthlyIssueTotal || 0, fill: "#10b981" },
    { name: "Jazz Load", Volume: jazzLoadSummary?.totalIssuanceBase || 0, fill: "#06b6d4" },
    { name: "Stock Ledger", Volume: stockSummary?.totalAmount || 0, fill: "#f97316" }
  ];

  return (
    <section className="space-y-6">
      {/* Top Universal Banner */}
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900/90 via-slate-900/40 to-slate-950/80 p-5 shadow-xl shadow-black/20 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">
            Universal Command Center
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {activeMonthId}
          </h2>
          <p className="mt-1.5 text-sm text-slate-400">
            Multi-module franchise operations report for Expense, Jazz Load, and Stock Ledger
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {month && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Expense Ledger Active
            </span>
          )}
          {jazzLoadSummary && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-300">
              <span className="h-2 w-2 rounded-full bg-cyan-400" />
              Jazz Load Active
            </span>
          )}
          {stockSummary && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-300">
              <span className="h-2 w-2 rounded-full bg-orange-400" />
              Stock Ledger Active
            </span>
          )}
        </div>
      </div>

      {/* Tabs Header */}
      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-1.5 text-slate-100 shadow-xl shadow-black/20">
        <button
          className={`btn-tab !h-10 !px-4 ${activeTab === "overview" ? "btn-tab-active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          <Activity className="h-4 w-4" />
          Consolidated Overview
        </button>
        <button
          className={`btn-tab !h-10 !px-4 ${activeTab === "expense" ? "btn-tab-active" : ""}`}
          onClick={() => setActiveTab("expense")}
        >
          <ReceiptText className="h-4 w-4 text-emerald-400" />
          Expense Ledger
        </button>
        <button
          className={`btn-tab !h-10 !px-4 ${activeTab === "jazzload" ? "btn-tab-active" : ""}`}
          onClick={() => setActiveTab("jazzload")}
        >
          <FileSpreadsheet className="h-4 w-4 text-cyan-400" />
          Jazz Load
        </button>
        <button
          className={`btn-tab !h-10 !px-4 ${activeTab === "stock" ? "btn-tab-active" : ""}`}
          onClick={() => setActiveTab("stock")}
        >
          <PackageOpen className="h-4 w-4 text-orange-400" />
          Stock Ledger
        </button>
      </div>

      {/* TAB 1: Consolidated Overview */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Executive Stat Cards */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-4">
            <MetricCard
              label="Grand Volume"
              value={money(grandVolume)}
              helper="Combined sales and issues across all modules"
              icon={Activity}
              tone="cyan"
            />
            <MetricCard
              label="Grand Inflow / Payments"
              value={money(grandPayments)}
              helper="Total returns & payments processed"
              icon={Banknote}
              tone="emerald"
            />
            <MetricCard
              label="Combined Commissions"
              value={money(grandCommission)}
              helper="Total revenues earned from categories & lifting"
              icon={Coins}
              tone="amber"
            />
            <MetricCard
              label="Grand Credit Exposure"
              value={money(grandCredit)}
              helper="Total outstanding credit & due balances"
              icon={Landmark}
              tone="orange"
            />
          </div>

          {/* Module-by-Module Cards Grid */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {/* Expense & Ledger Card */}
            <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl">
              <div>
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="flex items-center gap-2 font-semibold text-emerald-400">
                    <Tags className="h-5 w-5" />
                    Expense & Ledger
                  </span>
                  <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                    Module 1
                  </span>
                </div>
                {month ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Issue Total</span>
                      <span className="font-semibold text-white">{money(month.homeSummary.monthlyIssueTotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Expense Spend</span>
                      <span className="font-semibold text-rose-300">-{money(month.homeSummary.monthlyExpenseTotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Final Return Balance</span>
                      <span className="font-semibold text-blue-300">{money(month.homeSummary.monthlyReturnBalance)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Credit Exposure</span>
                      <span className="font-semibold text-amber-300">{money(month.homeSummary.creditBalanceTotal)}</span>
                    </div>

                    <div className="mt-4 pt-2">
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                        <span>Spend-to-Issue Ratio</span>
                        <span>
                          {month.homeSummary.monthlyIssueTotal
                            ? Math.round((month.homeSummary.monthlyExpenseTotal / month.homeSummary.monthlyIssueTotal) * 100)
                            : 0}
                          %
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-emerald-400"
                          style={{
                            width: `${Math.min(
                              100,
                              month.homeSummary.monthlyIssueTotal
                                ? (month.homeSummary.monthlyExpenseTotal / month.homeSummary.monthlyIssueTotal) * 100
                                : 0
                            )}%`
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-8 text-center text-sm text-slate-500">No Expense ledger data for this month.</p>
                )}
              </div>
              <button
                className="btn-secondary mt-5 !h-9 !w-full"
                onClick={() => setActiveTab("expense")}
              >
                Go to Expense Dashboard
              </button>
            </div>

            {/* Jazz Load Card */}
            <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl">
              <div>
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="flex items-center gap-2 font-semibold text-cyan-400">
                    <FileSpreadsheet className="h-5 w-5" />
                    Jazz Load
                  </span>
                  <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-300">
                    Module 2
                  </span>
                </div>
                {jazzLoadSummary ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">ML Issuance</span>
                      <span className="font-semibold text-white">{money(jazzLoadSummary.totalIssuanceBase)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Payments Received</span>
                      <span className="font-semibold text-emerald-300">{money(jazzLoadSummary.totalPaymentsBase)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">In Hand Cash Balance</span>
                      <span className="font-semibold text-cyan-300">{money(jazzLoadSummary.latestInHandBalance)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Commissions Earned</span>
                      <span className="font-semibold text-amber-300">{money(jazzLoadSummary.totalCommission)}</span>
                    </div>

                    <div className="mt-4 pt-2">
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                        <span>Payment Recovery Rate</span>
                        <span>
                          {jazzLoadSummary.totalIssuanceBase
                            ? Math.round((jazzLoadSummary.totalPaymentsBase / jazzLoadSummary.totalIssuanceBase) * 100)
                            : 0}
                          %
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-cyan-400"
                          style={{
                            width: `${Math.min(
                              100,
                              jazzLoadSummary.totalIssuanceBase
                                ? (jazzLoadSummary.totalPaymentsBase / jazzLoadSummary.totalIssuanceBase) * 100
                                : 0
                            )}%`
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-8 text-center text-sm text-slate-500">No Jazz Load data for this month.</p>
                )}
              </div>
              <button
                className="btn-secondary mt-5 !h-9 !w-full"
                onClick={() => setActiveTab("jazzload")}
              >
                Go to Jazz Load Dashboard
              </button>
            </div>

            {/* Stock Ledger Card */}
            <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl">
              <div>
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="flex items-center gap-2 font-semibold text-orange-400">
                    <Package className="h-5 w-5" />
                    Stock Ledger
                  </span>
                  <span className="rounded bg-orange-500/10 px-2 py-0.5 text-xs text-orange-300">
                    Module 3
                  </span>
                </div>
                {stockSummary ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Sales Value</span>
                      <span className="font-semibold text-white">{money(stockSummary.totalAmount)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Payments Received</span>
                      <span className="font-semibold text-emerald-300">{money(stockSummary.totalPaymentReceived)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Retailer Due Balance</span>
                      <span className="font-semibold text-rose-300">{money(stockSummary.totalDueBalance)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">Payable to Jazz Company</span>
                      <span className="font-semibold text-amber-300">{money(stockSummary.closingJazzPayable ?? 0)}</span>
                    </div>

                    <div className="mt-4 pt-2">
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                        <span>Items Sold (Quantity)</span>
                        <span className="font-medium text-white">{stockSummary.totalQty.toLocaleString()} units</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-orange-400"
                          style={{
                            width: `${Math.min(
                              100,
                              stockSummary.totalAmount
                                ? (stockSummary.totalPaymentReceived / stockSummary.totalAmount) * 100
                                : 0
                            )}%`
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-8 text-center text-sm text-slate-500">No Stock Ledger data for this month.</p>
                )}
              </div>
              <button
                className="btn-secondary mt-5 !h-9 !w-full"
                onClick={() => setActiveTab("stock")}
              >
                Go to Stock Dashboard
              </button>
            </div>
          </div>

          {/* Consolidated Contribution BarChart */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
            <h3 className="text-lg font-semibold text-white">Module Volume Contribution</h3>
            <p className="text-sm text-slate-400">Comparison of total operations volume by module</p>
            <div className="mt-5 h-64 min-w-0 sm:h-72">
              {chartsReady && (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={consolidatedContributionData} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="name" stroke="#64748b" tickLine={false} interval={0} tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748b" tickFormatter={compactMoney} tickLine={false} width={54} tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                    formatter={tooltipMoney}
                  />
                  <Bar dataKey="Volume" radius={[8, 8, 0, 0]} fill="#34d399">
                    {consolidatedContributionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Expense & Ledger */}
      {activeTab === "expense" && (
        <>
          {month ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 className="text-xl font-semibold tracking-tight text-white">Expense & Credit Command Center</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    {month.days.length} ledger periods · {Math.round((month.days.filter((day) => day.dayNo <= 31).length / 31) * 100)}% daily completion
                  </p>
                </div>
                <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300">
                  {month.days.filter((day) => day.returnBalance < 0).length ? (
                    <AlertTriangle className="h-4 w-4 text-amber-300" />
                  ) : (
                    <BadgeCheck className="h-4 w-4 text-emerald-300" />
                  )}
                  {month.days.filter((day) => day.returnBalance < 0).length ? "Needs cash review" : "Ledger stable"}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-4">
                <MetricCard
                  label="Issue Total"
                  value={money(month.homeSummary.monthlyIssueTotal)}
                  helper="Total issued load from ledger"
                  icon={ArrowUpRight}
                  tone="emerald"
                />
                <MetricCard
                  label="Expense Total"
                  value={money(month.homeSummary.monthlyExpenseTotal)}
                  helper="Total recorded operational expenses"
                  icon={ReceiptText}
                  tone="rose"
                />
                <MetricCard
                  label="Final Balance"
                  value={money(month.homeSummary.monthlyReturnBalance)}
                  helper="Net cash return after issue & expenses"
                  icon={WalletCards}
                  tone={month.homeSummary.monthlyReturnBalance < 0 ? "rose" : "blue"}
                />
                <MetricCard
                  label="Credit Exposure"
                  value={money(month.homeSummary.creditBalanceTotal)}
                  helper={`${month.homeSummary.creditPartyBalances.length} active credit parties`}
                  icon={Landmark}
                  tone="amber"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5 xl:col-span-2">
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-white">Daily Flow</h3>
                      <p className="text-sm text-slate-400">Issue, expenses, and balance by period</p>
                    </div>
                    <ArrowDownRight className="h-5 w-5 text-slate-500" />
                  </div>
                  <div className="h-64 min-w-0 sm:h-80">
                    {chartsReady && (
                      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                      <AreaChart
                        data={month.homeSummary.dayRows.map((row) => ({
                          period: row.label ?? row.dayNo,
                          issue: row.issueBalance,
                          expense: row.expenseTotal,
                          balance: row.returnBalance,
                          credit: row.creditBalance
                        }))}
                        margin={{ top: 8, right: 4, left: -16, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient id="issue" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="5%" stopColor="#34d399" stopOpacity={0.35} />
                            <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="expense" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="5%" stopColor="#fb7185" stopOpacity={0.28} />
                            <stop offset="95%" stopColor="#fb7185" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                        <XAxis dataKey="period" stroke="#64748b" tickLine={false} minTickGap={18} tick={{ fontSize: 11 }} />
                        <YAxis stroke="#64748b" tickFormatter={compactMoney} tickLine={false} width={54} tick={{ fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                          formatter={tooltipMoney}
                        />
                        <Area dataKey="issue" stroke="#34d399" fill="url(#issue)" strokeWidth={2} />
                        <Area dataKey="expense" stroke="#fb7185" fill="url(#expense)" strokeWidth={2} />
                        <Area dataKey="balance" stroke="#60a5fa" fill="transparent" strokeWidth={2} />
                      </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
                  <h3 className="text-lg font-semibold text-white">Expense Mix</h3>
                  <p className="text-sm text-slate-400">Top expense categories</p>
                  <div className="mt-5 h-64 min-w-0 sm:h-72">
                    {chartsReady && (
                      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                      <PieChart>
                        <Pie
                          data={month.homeSummary.expenseByCategory.slice(0, 6).map((row) => ({
                            name: row.category,
                            value: row.amount
                          }))}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={58}
                          outerRadius={96}
                        >
                          {month.homeSummary.expenseByCategory.slice(0, 6).map((entry, index) => (
                            <Cell key={entry.category} fill={chartColors[index % chartColors.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                          formatter={tooltipMoney}
                        />
                      </PieChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                  <div className="space-y-2">
                    {month.homeSummary.expenseByCategory.slice(0, 6).map((row, index) => (
                      <div className="flex items-center justify-between gap-3 text-sm" key={row.category}>
                        <span className="flex items-center gap-2 text-slate-300">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: chartColors[index % chartColors.length] }}
                          />
                          {row.category}
                        </span>
                        <span className="font-semibold text-white">{money(row.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
                  <h3 className="text-lg font-semibold text-white">Commission Breakdown</h3>
                  <p className="text-sm text-slate-400">Category totals across the month</p>
                  <div className="mt-5 h-64 min-w-0 sm:h-72">
                    {chartsReady && (
                      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                      <BarChart
                        data={[...expenseCommissionTotals.entries()]
                          .map(([name, value]) => ({ name, value }))
                          .filter((row) => row.value !== 0)
                          .sort((a, b) => b.value - a.value)}
                        layout="vertical"
                        margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                      >
                        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" horizontal={false} />
                        <XAxis type="number" stroke="#64748b" tickFormatter={compactMoney} tickLine={false} tick={{ fontSize: 11 }} />
                        <YAxis dataKey="name" type="category" stroke="#94a3b8" tickLine={false} width={92} tick={{ fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                          formatter={tooltipMoney}
                        />
                        <Bar dataKey="value" radius={[0, 8, 8, 0]} fill="#34d399" />
                      </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-black/20">
                  <h3 className="text-lg font-semibold text-white">Operating Signals</h3>
                  <p className="text-sm text-slate-400">Immediate items for owner review</p>
                  <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                      <CalendarDays className="h-5 w-5 text-blue-300" />
                      <p className="mt-3 text-2xl font-semibold text-white">
                        {31 - month.days.filter((day) => day.dayNo <= 31).length}
                      </p>
                      <p className="text-sm text-slate-400">Missing days</p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                      <AlertTriangle className="h-5 w-5 text-amber-300" />
                      <p className="mt-3 text-2xl font-semibold text-white">
                        {month.days.filter((day) => day.returnBalance < 0).length}
                      </p>
                      <p className="text-sm text-slate-400">Negative balance periods</p>
                    </div>
                  </div>
                  <div className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4">
                    <p className="text-sm font-semibold text-emerald-200">Recommendation</p>
                    <p className="mt-1 text-sm text-emerald-50">
                      {month.days.filter((day) => day.dayNo <= 31).length < 31
                        ? "Complete missing days before closing the month."
                        : "Month is ready for owner review and export."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <section className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
                <Landmark className="h-6 w-6" />
              </div>
              <h2 className="mt-4 text-xl font-semibold text-white">No Expense Ledger data</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
                Expense Ledger is not loaded or configured for this month.
              </p>
            </section>
          )}
        </>
      )}

      {/* TAB 3: Jazz Load */}
      {activeTab === "jazzload" && (
        <>
          {jazzLoadSummary ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 className="text-xl font-semibold tracking-tight text-white">Jazz Load Performance</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Comprehensive load distribution and commission totals
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-4">
                <MetricCard
                  label="ML Issuance"
                  value={money(jazzLoadSummary.totalIssuanceBase)}
                  helper={`${money(jazzLoadSummary.totalIssuanceMl)} ML units issued`}
                  icon={ArrowUpRight}
                  tone="cyan"
                />
                <MetricCard
                  label="Total Payments"
                  value={money(jazzLoadSummary.totalPaymentsBase)}
                  helper="Total recovery base received"
                  icon={Banknote}
                  tone="emerald"
                />
                <MetricCard
                  label="In Hand Cash"
                  value={money(jazzLoadSummary.latestInHandBalance)}
                  helper="Current cash balance in drawer"
                  icon={WalletCards}
                  tone="blue"
                />
                <MetricCard
                  label="Total Commissions"
                  value={money(jazzLoadSummary.totalCommission)}
                  helper="Revenues earned from issuances & adjust"
                  icon={Coins}
                  tone="amber"
                />
              </div>

              {/* Daily Area Chart */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
                <h3 className="text-lg font-semibold text-white">Daily Flow (Jazz Load)</h3>
                <p className="text-sm text-slate-400">Daily Issuance vs Payments</p>
                <div className="mt-5 h-64 min-w-0 sm:h-80">
                  {chartsReady && (
                    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <AreaChart
                      data={jazzLoadSummary.dayRows}
                      margin={{ top: 8, right: 4, left: -16, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="jlIssuance" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="jlPayment" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.28} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="dayNo" stroke="#64748b" tickLine={false} tickFormatter={(v) => `Day ${v}`} minTickGap={18} tick={{ fontSize: 11 }} />
                      <YAxis stroke="#64748b" tickFormatter={compactMoney} tickLine={false} width={54} tick={{ fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                        formatter={tooltipMoney}
                      />
                      <Area dataKey="issuanceBase" stroke="#06b6d4" fill="url(#jlIssuance)" strokeWidth={2} name="Issuance" />
                      <Area dataKey="paymentBase" stroke="#10b981" fill="url(#jlPayment)" strokeWidth={2} name="Payment Rec." />
                    </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {/* DO Balances Table */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-black/20">
                <h3 className="text-lg font-semibold text-white">DO Balances & Activity</h3>
                <p className="text-sm text-slate-400 mb-4">Outstanding balances for load operators</p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>DO Operator</th>
                        <th>Opening</th>
                        <th>Issuance</th>
                        <th>Payments</th>
                        <th>Closing Outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jazzLoadSummary.doBalances.map((doRow) => (
                        <tr key={doRow.doName} className="hover:bg-slate-800/40">
                          <td className="font-semibold text-white">
                            {doRow.doName} <span className="text-xs text-slate-500 font-normal">{doRow.doLine ? `(${doRow.doLine})` : ""}</span>
                          </td>
                          <td>{money(doRow.openingBase)}</td>
                          <td className="text-cyan-300 font-medium">{money(doRow.issuanceBase)}</td>
                          <td className="text-emerald-300 font-medium">{money(doRow.paymentBase)}</td>
                          <td className={`font-semibold ${doRow.closingBase > 0 ? "text-amber-400" : "text-slate-400"}`}>
                            {money(doRow.closingBase)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <section className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
                <FileSpreadsheet className="h-6 w-6" />
              </div>
              <h2 className="mt-4 text-xl font-semibold text-white">No Jazz Load data</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
                Jazz Load is not loaded or configured for this month.
              </p>
            </section>
          )}
        </>
      )}

      {/* TAB 4: Stock Ledger */}
      {activeTab === "stock" && (
        <>
          {stockSummary ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h3 className="text-xl font-semibold tracking-tight text-white">Stock Ledger Control</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Product distributions, SIM accounts, and company payables
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-4">
                <MetricCard
                  label="Sales / Stock Out"
                  value={money(stockSummary.totalAmount)}
                  helper={`${stockSummary.totalQty.toLocaleString()} products sold`}
                  icon={ShoppingCart}
                  tone="orange"
                />
                <MetricCard
                  label="Payments Received"
                  value={money(stockSummary.totalPaymentReceived)}
                  helper="Total cash collections from outlets"
                  icon={Banknote}
                  tone="emerald"
                />
                <MetricCard
                  label="Retailer Due Balance"
                  value={money(stockSummary.totalDueBalance)}
                  helper="Total outstanding customer credit"
                  icon={Landmark}
                  tone="rose"
                />
                <MetricCard
                  label="Jazz Payable"
                  value={money(stockSummary.closingJazzPayable ?? 0)}
                  helper="Outstanding balance payable to parent brand"
                  icon={WalletCards}
                  tone="amber"
                />
              </div>

              {/* Daily Area Chart */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
                <h3 className="text-lg font-semibold text-white">Daily Flow (Stock Ledger)</h3>
                <p className="text-sm text-slate-400">Daily Sales Value vs Payments Received</p>
                <div className="mt-5 h-64 min-w-0 sm:h-80">
                  {chartsReady && (
                    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <AreaChart
                      data={stockSummary.dayRows}
                      margin={{ top: 8, right: 4, left: -16, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="stSales" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="5%" stopColor="#f97316" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="stPayment" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.28} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="dayNo" stroke="#64748b" tickLine={false} tickFormatter={(v) => `Day ${v}`} minTickGap={18} tick={{ fontSize: 11 }} />
                      <YAxis stroke="#64748b" tickFormatter={compactMoney} tickLine={false} width={54} tick={{ fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                        formatter={tooltipMoney}
                      />
                      <Area dataKey="totalAmount" stroke="#f97316" fill="url(#stSales)" strokeWidth={2} name="Sales Value" />
                      <Area dataKey="totalPaymentReceived" stroke="#10b981" fill="url(#stPayment)" strokeWidth={2} name="Payments Rec." />
                    </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {/* Side by side Product Breakdown & Account Balances */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {/* Product Breakdown Chart */}
                <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
                  <h3 className="text-lg font-semibold text-white">Product Sales Breakdown</h3>
                  <p className="text-sm text-slate-400 mb-4">Total revenue share per product</p>
                  <div className="h-72 min-w-0">
                  {chartsReady && (
                    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <BarChart
                      data={stockSummary.productTotals.slice(0, 8).sort((a, b) => b.amount - a.amount)}
                      layout="vertical"
                      margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" stroke="#64748b" tickFormatter={compactMoney} tickLine={false} tick={{ fontSize: 11 }} />
                      <YAxis dataKey="productName" type="category" stroke="#94a3b8" tickLine={false} width={92} tick={{ fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                        formatter={tooltipMoney}
                      />
                      <Bar dataKey="amount" radius={[0, 8, 8, 0]} fill="#f97316" name="Revenue" />
                    </BarChart>
                    </ResponsiveContainer>
                  )}
                  </div>
                </div>

                {/* Top Customer Accounts List */}
                <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-black/20">
                  <h3 className="text-lg font-semibold text-white">Top Customer Accounts</h3>
                  <p className="text-sm text-slate-400 mb-4">Active retailers & DSOs outstanding due balances</p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Account Name</th>
                          <th>Type</th>
                          <th>Qty Sold</th>
                          <th>Due Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stockSummary.accountTotals.slice(0, 6).map((acc) => (
                          <tr key={acc.accountId} className="hover:bg-slate-800/40">
                            <td className="font-semibold text-white">{acc.accountName}</td>
                            <td>
                              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300 uppercase">
                                {acc.accountType}
                              </span>
                            </td>
                            <td>{acc.totalQty.toLocaleString()} units</td>
                            <td className={`font-semibold ${acc.dueBalance > 0 ? "text-rose-400" : "text-slate-400"}`}>
                              {money(acc.dueBalance)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <section className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
                <PackageOpen className="h-6 w-6" />
              </div>
              <h2 className="mt-4 text-xl font-semibold text-white">No Stock Ledger data</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
                Stock Ledger is not loaded or configured for this month.
              </p>
            </section>
          )}
        </>
      )}
    </section>
  );
}
