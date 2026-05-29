import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  CalendarDays,
  Landmark,
  ReceiptText,
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
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { MonthComputed } from "../types/ledger";

type Props = {
  month: MonthComputed | null;
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

function useChartWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(280, Math.floor(entry.contentRect.width)));
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
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
  tone?: "emerald" | "blue" | "amber" | "rose";
}) {
  const tones = {
    emerald: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
    blue: "bg-blue-400/10 text-blue-300 ring-blue-400/20",
    amber: "bg-amber-400/10 text-amber-300 ring-amber-400/20",
    rose: "bg-rose-400/10 text-rose-300 ring-rose-400/20"
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

export function HomeDashboard({ month }: Props) {
  const [chartsReady, setChartsReady] = useState(false);
  const flowChart = useChartWidth();
  const expenseChart = useChartWidth();
  const commissionChart = useChartWidth();

  useEffect(() => {
    setChartsReady(false);
    const id = window.setTimeout(() => setChartsReady(true), 150);
    return () => window.clearTimeout(id);
  }, [month?.monthId, month?.days.length]);

  if (!month) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
          <Landmark className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-white">No dashboard data yet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
          Import a workbook or save a daily entry. The dashboard will turn raw ledger entries into totals,
          charts, risk signals, and credit exposure.
        </p>
      </section>
    );
  }

  const enteredDays = new Set(month.days.filter((day) => day.dayNo <= 31).map((day) => day.dayNo));
  const missingDays = Array.from({ length: 31 }, (_, index) => index + 1).filter(
    (dayNo) => !enteredDays.has(dayNo)
  );
  const topExpenseDay = [...month.days].sort((a, b) => b.expenseTotal - a.expenseTotal)[0];
  const topIssueDay = [...month.days].sort((a, b) => b.issueBalance - a.issueBalance)[0];
  const negativeReturnDays = month.days.filter((day) => day.returnBalance < 0);
  const completionRate = Math.round((enteredDays.size / 31) * 100);
  const dailyChart = month.homeSummary.dayRows.map((row) => ({
    period: row.label ?? row.dayNo,
    issue: row.issueBalance,
    expense: row.expenseTotal,
    balance: row.returnBalance,
    credit: row.creditBalance
  }));
  const categoryData = month.homeSummary.expenseByCategory.slice(0, 6).map((row) => ({
    name: row.category,
    value: row.amount
  }));
  const commissionTotals = new Map<string, number>();
  for (const row of month.homeSummary.commissionMatrix) {
    for (const [category, amount] of Object.entries(row.byCategory)) {
      commissionTotals.set(category, (commissionTotals.get(category) ?? 0) + amount);
    }
  }
  const commissionData = [...commissionTotals.entries()]
    .map(([name, value]) => ({ name, value }))
    .filter((row) => row.value !== 0)
    .sort((a, b) => b.value - a.value);
  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-300">
            Monthly Command Center
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {month.monthId ?? "Current month"}
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            {month.days.length} ledger periods · {completionRate}% daily completion
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300">
          {negativeReturnDays.length ? (
            <AlertTriangle className="h-4 w-4 text-amber-300" />
          ) : (
            <BadgeCheck className="h-4 w-4 text-emerald-300" />
          )}
          {negativeReturnDays.length ? "Needs cash review" : "Ledger stable"}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-4">
        <MetricCard
          label="Issue Total"
          value={money(month.homeSummary.monthlyIssueTotal)}
          helper={topIssueDay ? `Best period: ${topIssueDay.label ?? `Day ${topIssueDay.dayNo}`}` : "No issue entries yet"}
          icon={ArrowUpRight}
        />
        <MetricCard
          label="Expense Total"
          value={money(month.homeSummary.monthlyExpenseTotal)}
          helper={topExpenseDay ? `Highest spend: ${topExpenseDay.label ?? `Day ${topExpenseDay.dayNo}`}` : "No expenses yet"}
          icon={ReceiptText}
          tone="rose"
        />
        <MetricCard
          label="Final Balance"
          value={money(month.homeSummary.monthlyReturnBalance)}
          helper={`${negativeReturnDays.length} negative balance periods`}
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
          <div className="h-64 min-w-0 sm:h-80" ref={flowChart.ref}>
            {chartsReady && (
              <AreaChart data={dailyChart} width={flowChart.width} height={flowChart.width < 520 ? 256 : 320}>
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
                <XAxis dataKey="period" stroke="#64748b" tickLine={false} />
                <YAxis stroke="#64748b" tickFormatter={compactMoney} tickLine={false} width={48} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                  formatter={tooltipMoney}
                />
                <Area dataKey="issue" stroke="#34d399" fill="url(#issue)" strokeWidth={2} />
                <Area dataKey="expense" stroke="#fb7185" fill="url(#expense)" strokeWidth={2} />
                <Area dataKey="balance" stroke="#60a5fa" fill="transparent" strokeWidth={2} />
              </AreaChart>
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
          <h3 className="text-lg font-semibold text-white">Expense Mix</h3>
          <p className="text-sm text-slate-400">Top expense categories</p>
          <div className="mt-5 h-64 min-w-0 sm:h-72" ref={expenseChart.ref}>
            {chartsReady && (
              <PieChart width={expenseChart.width} height={expenseChart.width < 520 ? 256 : 288}>
                <Pie data={categoryData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={96}>
                  {categoryData.map((entry, index) => (
                    <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                  formatter={tooltipMoney}
                />
              </PieChart>
            )}
          </div>
          <div className="space-y-2">
            {categoryData.map((row, index) => (
              <div className="flex items-center justify-between gap-3 text-sm" key={row.name}>
                <span className="flex items-center gap-2 text-slate-300">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: chartColors[index % chartColors.length] }}
                  />
                  {row.name}
                </span>
                <span className="font-semibold text-white">{money(row.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
          <h3 className="text-lg font-semibold text-white">Commission Breakdown</h3>
          <p className="text-sm text-slate-400">Category totals across the month</p>
          <div className="mt-5 h-64 min-w-0 sm:h-72" ref={commissionChart.ref}>
            {chartsReady && (
              <BarChart data={commissionData} layout="vertical" margin={{ left: 8 }} width={commissionChart.width} height={commissionChart.width < 520 ? 256 : 288}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" stroke="#64748b" tickFormatter={compactMoney} tickLine={false} />
                <YAxis dataKey="name" type="category" stroke="#94a3b8" tickLine={false} width={110} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 12 }}
                  formatter={tooltipMoney}
                />
                <Bar dataKey="value" radius={[0, 8, 8, 0]} fill="#34d399" />
              </BarChart>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-black/20">
          <h3 className="text-lg font-semibold text-white">Operating Signals</h3>
          <p className="text-sm text-slate-400">Immediate items for owner review</p>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
              <CalendarDays className="h-5 w-5 text-blue-300" />
              <p className="mt-3 text-2xl font-semibold text-white">{missingDays.length}</p>
              <p className="text-sm text-slate-400">Missing days</p>
              <p className="mt-2 text-xs text-slate-500">{missingDays.slice(0, 10).join(", ") || "None"}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
              <AlertTriangle className="h-5 w-5 text-amber-300" />
              <p className="mt-3 text-2xl font-semibold text-white">{negativeReturnDays.length}</p>
              <p className="text-sm text-slate-400">Negative balance periods</p>
              <p className="mt-2 text-xs text-slate-500">
                {negativeReturnDays.map((day) => day.label ?? day.dayNo).slice(0, 8).join(", ") || "None"}
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4">
            <p className="text-sm font-semibold text-emerald-200">Recommendation</p>
            <p className="mt-1 text-sm text-emerald-50">
              {missingDays.length
                ? "Complete missing days before closing the month."
                : "Month is ready for owner review and export."}
            </p>
          </div>
        </div>
      </div>

    </section>
  );
}
