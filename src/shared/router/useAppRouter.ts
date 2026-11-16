import { useEffect, useRef } from "react";
import type { View, ExpenseSection } from "../../App";
import type { JazzLoadSection } from "../../modules/jazzLoad/components/JazzLoadModule";
import type { StockSection } from "../../modules/stock/components/StockLedgerModule";

export interface RouteState {
  view: View;
  monthId: string;
  selectedDay: number;
  expenseSection: ExpenseSection;
  jazzLoadSection: JazzLoadSection;
  stockSection: StockSection;
}

export interface ParsedRoute {
  view?: View;
  monthId?: string;
  selectedDay?: number;
  expenseSection?: ExpenseSection;
  jazzLoadSection?: JazzLoadSection;
  stockSection?: StockSection;
}

// Slugs mapping for Stock Ledger sections
export const STOCK_SECTION_TO_SLUG: Record<StockSection, string> = {
  daily: "daily",
  reportsHub: "reports",
  stockIn: "stock-in",
  balances: "balances",
  records: "records",
  jazzPayable: "jazz-payable",
  dues: "dues",
  products: "products",
  accounts: "accounts",
  settings: "settings",
  backup: "backup"
};

export const SLUG_TO_STOCK_SECTION: Record<string, StockSection> = {
  daily: "daily",
  reports: "reportsHub",
  report: "reportsHub",
  reportsHub: "reportsHub",
  "stock-in": "stockIn",
  stockin: "stockIn",
  balances: "balances",
  records: "records",
  "jazz-payable": "jazzPayable",
  jazzpayable: "jazzPayable",
  dues: "dues",
  products: "products",
  accounts: "accounts",
  settings: "settings",
  backup: "backup",
  dashboard: "reportsHub"
};

// Slugs mapping for Jazz Load sections
export const JAZZ_LOAD_SECTION_TO_SLUG: Record<JazzLoadSection, string> = {
  daily: "daily",
  reports: "reports",
  settings: "settings",
  formulas: "formulas"
};

export const SLUG_TO_JAZZ_LOAD_SECTION: Record<string, JazzLoadSection> = {
  daily: "daily",
  reports: "reports",
  report: "reports",
  settings: "settings",
  formulas: "formulas"
};

// Slugs mapping for Expense sections
export const EXPENSE_SECTION_TO_SLUG: Record<ExpenseSection, string> = {
  "daily-entry": "daily",
  "previous-records": "records",
  settings: "settings",
  "expense-categories": "categories",
  "credit-parties": "credit-parties",
  "commission-categories": "commission-categories"
};

export const SLUG_TO_EXPENSE_SECTION: Record<string, ExpenseSection> = {
  daily: "daily-entry",
  "daily-entry": "daily-entry",
  records: "previous-records",
  "previous-records": "previous-records",
  settings: "settings",
  categories: "expense-categories",
  "expense-categories": "expense-categories",
  "credit-parties": "credit-parties",
  "commission-categories": "commission-categories"
};

/**
 * Normalizes a view slug into a canonical View identifier.
 */
export function normalizeViewSlug(raw: string): View | null {
  const slug = raw.toLowerCase().trim();
  if (slug === "dashboard" || slug === "home") return "dashboard";
  if (slug === "stock-ledger" || slug === "stock" || slug === "stockledger") return "stock-ledger";
  if (slug === "jazz-load" || slug === "jazzload" || slug === "load" || slug === "jazz") return "jazz-load";
  if (slug === "expense" || slug === "expenses") return "expense";
  if (slug === "users" || slug === "user") return "users";
  if (slug === "backup" || slug === "backups") return "backup";
  if (slug === "audit-logs" || slug === "audit" || slug === "auditlogs") return "audit-logs";
  if (slug === "import" || slug === "imports") return "import";
  return null;
}

/**
 * Parses a browser pathname into route state tokens.
 */
export function parseRoute(pathname: string): ParsedRoute {
  const clean = pathname.replace(/^\/+|\/+$/g, "");
  if (!clean) return {};

  const parts = clean.split("/").map(decodeURIComponent);
  const rawView = parts[0];
  const view = normalizeViewSlug(rawView);
  if (!view) return {};

  const result: ParsedRoute = { view };

  // Simple admin views without date scope
  if (view === "users" || view === "backup" || view === "audit-logs" || view === "import") {
    return result;
  }

  // Segment 1: Month ID (YYYY-MM)
  if (parts.length > 1) {
    const rawMonth = parts[1];
    if (/^\d{4}-\d{2}$/.test(rawMonth)) {
      result.monthId = rawMonth;
    }
  }

  // Segment 2: Day or Section
  if (parts.length > 2) {
    const rawSegment = parts[2].toLowerCase();

    // Check if it's day-XX or dayXX or just a number
    const dayMatch = rawSegment.match(/^(?:day-?|d)?(\d{1,2})$/);
    if (dayMatch) {
      const dayNum = parseInt(dayMatch[1], 10);
      if (dayNum >= 1 && dayNum <= 31) {
        result.selectedDay = dayNum;
        if (view === "stock-ledger") result.stockSection = "daily";
        if (view === "jazz-load") result.jazzLoadSection = "daily";
        if (view === "expense") result.expenseSection = "daily-entry";
        return result;
      }
    }

    // Otherwise it's a section slug
    if (view === "stock-ledger") {
      const mapped = SLUG_TO_STOCK_SECTION[rawSegment];
      if (mapped) result.stockSection = mapped;
    } else if (view === "jazz-load") {
      const mapped = SLUG_TO_JAZZ_LOAD_SECTION[rawSegment];
      if (mapped) result.jazzLoadSection = mapped;
    } else if (view === "expense") {
      const mapped = SLUG_TO_EXPENSE_SECTION[rawSegment];
      if (mapped) result.expenseSection = mapped;
    }
  }

  return result;
}

/**
 * Constructs the canonical URL path for a given application state.
 */
export function buildRoutePath(state: RouteState): string {
  const { view, monthId, selectedDay, expenseSection, jazzLoadSection, stockSection } = state;

  if (view === "users") return "/users";
  if (view === "backup") return "/backup";
  if (view === "audit-logs") return "/audit-logs";
  if (view === "import") return "/import";

  const safeMonth = monthId || "2026-11";
  const daySlug = `day-${String(Math.min(31, Math.max(1, selectedDay || 1))).padStart(2, "0")}`;

  if (view === "dashboard") {
    return `/dashboard/${safeMonth}`;
  }

  if (view === "stock-ledger") {
    if (stockSection === "daily") {
      return `/stock-ledger/${safeMonth}/${daySlug}`;
    }
    const slug = STOCK_SECTION_TO_SLUG[stockSection] || "daily";
    return `/stock-ledger/${safeMonth}/${slug}`;
  }

  if (view === "jazz-load") {
    if (jazzLoadSection === "daily") {
      return `/jazz-load/${safeMonth}/${daySlug}`;
    }
    const slug = JAZZ_LOAD_SECTION_TO_SLUG[jazzLoadSection] || "daily";
    return `/jazz-load/${safeMonth}/${slug}`;
  }

  if (view === "expense") {
    if (expenseSection === "daily-entry") {
      return `/expense/${safeMonth}/${daySlug}`;
    }
    const slug = EXPENSE_SECTION_TO_SLUG[expenseSection] || "daily";
    return `/expense/${safeMonth}/${slug}`;
  }

  return `/dashboard/${safeMonth}`;
}

export interface UseAppRouterProps {
  state: RouteState;
  onApplyRoute: (route: ParsedRoute) => void;
  isReady: boolean;
}

/**
 * Bi-directional router hook synchronizing application state with browser location.
 */
export function useAppRouter({ state, onApplyRoute, isReady }: UseAppRouterProps) {
  const isApplyingFromUrlRef = useRef(false);
  const lastPushedPathRef = useRef<string>("");

  // 1. Listen for browser Back / Forward events
  useEffect(() => {
    function handlePopState() {
      const parsed = parseRoute(window.location.pathname);
      isApplyingFromUrlRef.current = true;
      try {
        onApplyRoute(parsed);
      } finally {
        setTimeout(() => {
          isApplyingFromUrlRef.current = false;
        }, 50);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [onApplyRoute]);

  // 2. Synchronize application state to browser URL
  useEffect(() => {
    if (!isReady) return;
    if (isApplyingFromUrlRef.current) return;

    const targetPath = buildRoutePath(state);
    const currentPath = window.location.pathname;

    if (currentPath !== targetPath && lastPushedPathRef.current !== targetPath) {
      lastPushedPathRef.current = targetPath;
      // If landing on root "/", replaceState so history doesn't trap a blank entry; otherwise pushState
      if (currentPath === "/" || currentPath === "") {
        window.history.replaceState(null, "", targetPath);
      } else {
        window.history.pushState(null, "", targetPath);
      }
    }
  }, [isReady, state]);
}
