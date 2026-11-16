import React from "react";
import { LoaderCircle } from "lucide-react";

export interface LedgerColumn<T> {
  key: string;
  header: React.ReactNode;
  align?: "left" | "right" | "center";
  isNumeric?: boolean;
  width?: string;
  className?: string;
  render?: (item: T, index: number) => React.ReactNode;
  footerRender?: (items: T[]) => React.ReactNode;
}

export interface LedgerTableProps<T> {
  columns: LedgerColumn<T>[];
  data: T[];
  rowKey?: (item: T, index: number) => string | number;
  onRowClick?: (item: T, index: number) => void;
  loading?: boolean;
  loadingText?: string;
  emptyText?: string;
  emptyAction?: React.ReactNode;
  hasTotalsRow?: boolean;
  totalsRowClassName?: string;
  className?: string;
  tableClassName?: string;
  ariaLabel?: string;
  stickyHeader?: boolean;
}

export function LedgerTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  loading = false,
  loadingText = "Loading records...",
  emptyText = "No ledger entries found.",
  emptyAction,
  hasTotalsRow = false,
  totalsRowClassName = "",
  className = "",
  tableClassName = "",
  ariaLabel = "Accounting Ledger Table",
  stickyHeader = true,
}: LedgerTableProps<T>) {
  const getCellAlignment = (col: LedgerColumn<T>) => {
    if (col.align) return col.align;
    return col.isNumeric ? "right" : "left";
  };

  const getAlignmentClass = (align: "left" | "right" | "center") => {
    switch (align) {
      case "right":
        return "text-right";
      case "center":
        return "text-center";
      case "left":
      default:
        return "text-left";
    }
  };

  return (
    <div
      className={`table-wrap relative overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40 ${className}`}
    >
      <table
        className={`w-full min-w-full border-collapse text-sm ${tableClassName}`}
        aria-label={ariaLabel}
      >
        <thead>
          <tr
            className={`border-b border-slate-800 ${
              stickyHeader ? "sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm" : "bg-slate-900/90"
            }`}
          >
            {columns.map((col) => {
              const align = getCellAlignment(col);
              return (
                <th
                  key={col.key}
                  scope="col"
                  style={{ width: col.width }}
                  className={`px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-400 ${getAlignmentClass(
                    align
                  )} ${col.isNumeric ? "font-mono tabular-nums" : ""} ${col.className || ""}`}
                >
                  {col.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {loading ? (
            <tr>
              <td
                colSpan={columns.length}
                className="py-12 text-center text-slate-400"
              >
                <div className="flex flex-col items-center justify-center gap-2">
                  <LoaderCircle className="h-6 w-6 animate-spin text-emerald-400" />
                  <span className="text-sm">{loadingText}</span>
                </div>
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="py-12 text-center text-slate-400"
              >
                <div className="flex flex-col items-center justify-center gap-2">
                  <p className="text-sm font-medium text-slate-300">{emptyText}</p>
                  {emptyAction && <div className="mt-2">{emptyAction}</div>}
                </div>
              </td>
            </tr>
          ) : (
            data.map((item, rowIndex) => {
              const key = rowKey ? rowKey(item, rowIndex) : rowIndex;
              const isClickable = Boolean(onRowClick);

              return (
                <tr
                  key={key}
                  onClick={() => onRowClick?.(item, rowIndex)}
                  className={`transition-colors border-b border-slate-800/60 ${
                    rowIndex % 2 === 0 ? "bg-slate-900/20" : "bg-slate-900/40"
                  } ${
                    isClickable
                      ? "cursor-pointer hover:bg-slate-800/50"
                      : "hover:bg-slate-800/30"
                  }`}
                >
                  {columns.map((col) => {
                    const align = getCellAlignment(col);
                    const value = col.render
                      ? col.render(item, rowIndex)
                      : (item as Record<string, any>)[col.key];

                    return (
                      <td
                        key={col.key}
                        className={`px-4 py-3 text-slate-200 ${getAlignmentClass(align)} ${
                          col.isNumeric ? "font-mono tabular-nums font-medium" : ""
                        } ${col.className || ""}`}
                      >
                        {value}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>

        {hasTotalsRow && data.length > 0 && !loading && (
          <tfoot>
            <tr
              className={`border-t-2 border-slate-700 bg-slate-900/90 font-bold text-slate-100 ${totalsRowClassName}`}
            >
              {columns.map((col) => {
                const align = getCellAlignment(col);
                return (
                  <td
                    key={col.key}
                    className={`px-4 py-3 ${getAlignmentClass(align)} ${
                      col.isNumeric ? "font-mono tabular-nums text-emerald-300" : ""
                    } ${col.className || ""}`}
                  >
                    {col.footerRender ? col.footerRender(data) : null}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
