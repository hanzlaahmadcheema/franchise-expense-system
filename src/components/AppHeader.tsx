import React, { useState, useRef, useEffect } from "react";
import type { SyncState } from "../lib/syncStatus";
import {
  ArrowUpRight,
  BookOpen,
  Building2,
  Calendar,
  CalendarDays,
  ChevronDown,
  FileDown,
  FileSpreadsheet,
  LayoutDashboard,
  Lock,
  LogOut,
  Maximize2,
  Menu,
  Moon,
  PackageOpen,
  PlusCircle,
  RefreshCw,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Sun,
  Tags,
  Unlock,
  User as UserIcon,
  Users,
  X
} from "lucide-react";

export interface AppHeaderProps {
  franchiseName?: string;
  monthId: string;
  monthChoices: Array<[string, string]>;
  currentMonthStatus: string;
  isMonthCloseRequired?: boolean;
  onMonthChange: (nextMonthId: string) => void;
  selectedDay?: number;
  selectedDayStatus?: "open" | "closed" | "reopened" | "reopen" | string;
  isDayView?: boolean;
  onDaySelect?: (dayNo: number) => void;
  totalDaysInMonth?: number;
  daysState?: Array<{ dayNo: number; status: "open" | "closed" | "reopened" | "reopen" | string }>;
  syncState: SyncState;
  syncLabel: string;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  userEmail?: string;
  displayName: string;
  role: string;
  onSignOut: () => void;
  mobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  mobileMenuTriggerRef?: React.Ref<HTMLButtonElement>;

  // Navigation props
  currentView?: string;
  onNavigate?: (view: string) => void;
  expenseSection?: string;
  onSelectExpenseSection?: (section: "daily-entry" | "previous-records" | "settings") => void;
  canManageExpenseSettings?: boolean;
  jazzLoadSection?: string;
  onSelectJazzLoadSection?: (section: "daily" | "reports" | "settings" | "formulas") => void;
  canManageJazzLoadSettings?: boolean;
  stockSection?: string;
  onSelectStockSection?: (section: "daily" | "stockIn" | "reportsHub" | "settings") => void;
  canManageStockSettings?: boolean;
  onOpenUsers?: () => void;
  canManageUsers?: boolean;
  onOpenAuditLogs?: () => void;
  canViewAuditLogs?: boolean;
  onOpenImport?: () => void;
  canUseExcelImport?: boolean;
  onOpenBackup?: () => void;
  canUseBackup?: boolean;
  onTriggerMasterRefresh?: () => void;
  canRunMasterRefresh?: boolean;
  isRefreshing?: boolean;
  onCloseSelectedDay?: () => void | Promise<void>;
  canCloseSelectedDay?: boolean;
  closeDisabledReason?: string;
  onReopenSelectedDay?: () => void | Promise<void>;
  canReopenSelectedDay?: boolean;
  reopenDisabledReason?: string;

  // Month lifecycle props
  monthToggleLabel?: string;
  onToggleMonth?: () => void | Promise<void>;
  canToggleMonth?: boolean;
  monthToggleDisabledReason?: string;
  onInitializeNextMonth?: () => void | Promise<void>;
  canInitializeNextMonth?: boolean;
  nextMonthLabel?: string;
}

const PRIMARY_NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "expense", label: "Expense", icon: Tags },
  { id: "jazz-load", label: "Jazz Load", icon: FileSpreadsheet },
  { id: "stock-ledger", label: "Stock Ledger", icon: PackageOpen },
  { id: "dealers", label: "Dealers", icon: Users }
];

const EXPENSE_DROPDOWN_OPTIONS = [
  { id: "daily-entry" as const, label: "Daily Entry", icon: CalendarDays },
  { id: "previous-records" as const, label: "Monthly Summary & Ledger", icon: ScrollText },
  { id: "settings" as const, label: "Settings", icon: SlidersHorizontal }
];

const JAZZ_LOAD_DROPDOWN_OPTIONS = [
  { id: "daily" as const, label: "Daily Lifting & Issuance", icon: CalendarDays },
  { id: "reports" as const, label: "Monthly Reports & Summaries", icon: FileSpreadsheet },
  { id: "settings" as const, label: "DO Profiles & Rates", icon: Settings },
  { id: "formulas" as const, label: "Formulas & Reference", icon: BookOpen }
];

const STOCK_DROPDOWN_OPTIONS = [
  { id: "daily" as const, label: "Daily Stock Issuance", icon: ArrowUpRight },
  { id: "stockIn" as const, label: "Stock Lifting (Stock In)", icon: PlusCircle },
  { id: "reportsHub" as const, label: "Reports & Summaries", icon: FileSpreadsheet },
  { id: "settings" as const, label: "Products & Accounts", icon: Settings }
];

export function AppHeader({
  franchiseName = "Jazz Franchise - 7301",
  monthId,
  monthChoices,
  currentMonthStatus,
  isMonthCloseRequired = false,
  onMonthChange,
  selectedDay,
  selectedDayStatus = "open",
  isDayView = false,
  onDaySelect,
  totalDaysInMonth = 31,
  daysState = [],
  syncState,
  syncLabel,
  theme,
  onToggleTheme,
  userEmail,
  displayName,
  role,
  onSignOut,
  mobileMenuOpen,
  onToggleMobileMenu,
  mobileMenuTriggerRef,
  currentView = "dashboard",
  onNavigate,
  expenseSection,
  onSelectExpenseSection,
  canManageExpenseSettings = true,
  jazzLoadSection,
  onSelectJazzLoadSection,
  canManageJazzLoadSettings = true,
  stockSection,
  onSelectStockSection,
  canManageStockSettings = true,
  onOpenUsers,
  canManageUsers = false,
  onOpenAuditLogs,
  canViewAuditLogs = false,
  onOpenImport,
  canUseExcelImport = false,
  onOpenBackup,
  canUseBackup = false,
  onTriggerMasterRefresh,
  canRunMasterRefresh = false,
  isRefreshing = false,
  onCloseSelectedDay,
  canCloseSelectedDay = false,
  closeDisabledReason,
  onReopenSelectedDay,
  canReopenSelectedDay = false,
  reopenDisabledReason,
  monthToggleLabel,
  onToggleMonth,
  canToggleMonth = false,
  monthToggleDisabledReason,
  onInitializeNextMonth,
  canInitializeNextMonth = false,
  nextMonthLabel
}: AppHeaderProps) {
  const [dayPopoverOpen, setDayPopoverOpen] = useState(false);
  const [expandedCalendarOpen, setExpandedCalendarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const dayPopoverRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const dayButtonRef = useRef<HTMLButtonElement>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);

  // Close popovers when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dayPopoverRef.current && !dayPopoverRef.current.contains(event.target as Node)) {
        setDayPopoverOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
      if (openDropdown && !((event.target as HTMLElement).closest?.(".nav-dropdown-container"))) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openDropdown]);

  // DEF-03: Escape key dismissal and focus restoration for non-modal popovers
  useEffect(() => {
    if (!dayPopoverOpen && !userMenuOpen && !openDropdown) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (openDropdown) {
          event.preventDefault();
          event.stopPropagation();
          setOpenDropdown(null);
        } else if (dayPopoverOpen) {
          event.preventDefault();
          event.stopPropagation();
          setDayPopoverOpen(false);
          dayButtonRef.current?.focus();
        } else if (userMenuOpen) {
          event.preventDefault();
          event.stopPropagation();
          setUserMenuOpen(false);
          userButtonRef.current?.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dayPopoverOpen, userMenuOpen, openDropdown]);

  useEffect(() => {
    if (!expandedCalendarOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setExpandedCalendarOpen(false);
        dayButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expandedCalendarOpen]);

  function formatMonthLabel(mId: string): string {
    const [year, month] = mId.split("-");
    const d = new Date(Number(year), Number(month) - 1, 1);
    return d.toLocaleString("en-US", { month: "short", year: "numeric" });
  }

  const roleBadgeColor =
    role === "owner"
      ? "bg-purple-500/20 text-purple-300 border-purple-500/30"
      : role === "admin"
      ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
      : "bg-slate-500/20 text-slate-300 border-slate-500/30";

  return (
    <header className="sticky top-0 z-40 flex h-14 w-full items-center justify-between border-b border-slate-800 bg-slate-950/95 px-2 sm:px-4 backdrop-blur">
      {/* LEFT: Mobile Toggle + Brand + Primary Navigation Tabs */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
        {/* Mobile/Tablet Menu Button */}
        <button
          ref={mobileMenuTriggerRef}
          type="button"
          className="btn-ghost !h-9 !w-9 !px-0 lg:hidden text-slate-300 hover:text-white shrink-0"
          onClick={onToggleMobileMenu}
          aria-expanded={mobileMenuOpen}
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          title={mobileMenuOpen ? "Close menu" : "Open menu"}
        >
          {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        {/* Brand identity */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-bold text-xs shrink-0">
            <Building2 className="h-4 w-4" />
          </div>
          <div className="hidden sm:block">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm text-slate-100 tracking-tight">{franchiseName}</span>
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30">
                v2.0
              </span>
            </div>
          </div>
        </div>

        {/* Primary Desktop/Tablet Navigation Tabs */}
        <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-1.5 ml-1 lg:ml-2">
          {PRIMARY_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            const dropdownOptions =
              item.id === "expense"
                ? EXPENSE_DROPDOWN_OPTIONS
                : item.id === "jazz-load"
                ? JAZZ_LOAD_DROPDOWN_OPTIONS
                : item.id === "stock-ledger"
                ? STOCK_DROPDOWN_OPTIONS
                : null;
            const isDropdownOpen = openDropdown === item.id;

            if (dropdownOptions) {
              return (
                <div key={item.id} className="relative nav-dropdown-container">
                  <div
                    className={`inline-flex items-center rounded-lg transition-all ${
                      isActive
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-950/40"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (currentView !== item.id) {
                          onNavigate?.(item.id);
                        } else {
                          setOpenDropdown((prev) => (prev === item.id ? null : item.id));
                        }
                      }}
                      className={`flex items-center gap-1.5 py-1.5 transition ${
                        isActive
                          ? "pl-3 pr-1 text-sm lg:text-base font-bold text-white tracking-tight"
                          : "px-2 lg:px-2.5 text-xs font-semibold"
                      }`}
                      title={item.label}
                      aria-current={isActive ? "page" : undefined}
                      aria-haspopup="menu"
                      aria-expanded={isDropdownOpen}
                    >
                      <Icon className={isActive ? "h-4 w-4 text-emerald-400 shrink-0" : "h-3.5 w-3.5 shrink-0"} />
                      <span className={isActive ? "inline" : "hidden lg:inline"}>{item.label}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`${item.label} menu options`}
                      title={`${item.label} options`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenDropdown((prev) => (prev === item.id ? null : item.id));
                      }}
                      className={`flex items-center justify-center py-1.5 pr-2 pl-0.5 rounded-r-lg hover:text-white transition ${
                        isActive ? "text-emerald-400" : "text-slate-400"
                      }`}
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform duration-150 ${
                          isDropdownOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                  </div>

                  {isDropdownOpen && (
                    <div
                      role="menu"
                      aria-label={`${item.label} sections`}
                      className="absolute left-0 top-full mt-1.5 w-60 rounded-xl border border-slate-800 bg-slate-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-md z-50 animate-in fade-in slide-in-from-top-1 duration-150"
                    >
                      <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-800/80 mb-1">
                        {item.label} Sections
                      </div>
                      {dropdownOptions.map((opt) => {
                        const OptIcon = opt.icon;
                        const isOptActive =
                          currentView === item.id &&
                          ((item.id === "expense" &&
                            (expenseSection === opt.id ||
                              (opt.id === "settings" &&
                                (expenseSection === "expense-categories" ||
                                  expenseSection === "credit-parties" ||
                                  expenseSection === "commission-categories")))) ||
                            (item.id === "jazz-load" && jazzLoadSection === opt.id) ||
                            (item.id === "stock-ledger" &&
                              (stockSection === opt.id ||
                                (opt.id === "reportsHub" && stockSection === "backup"))));
                        const isLocked =
                          (item.id === "expense" && opt.id === "settings" && !canManageExpenseSettings) ||
                          (item.id === "jazz-load" && opt.id === "settings" && !canManageJazzLoadSettings) ||
                          (item.id === "stock-ledger" && opt.id === "settings" && !canManageStockSettings);

                        return (
                          <button
                            key={opt.id}
                            role="menuitem"
                            type="button"
                            disabled={isLocked}
                            onClick={() => {
                              if (isLocked) return;
                              if (item.id === "expense") onSelectExpenseSection?.(opt.id as any);
                              else if (item.id === "jazz-load") onSelectJazzLoadSection?.(opt.id as any);
                              else if (item.id === "stock-ledger") onSelectStockSection?.(opt.id as any);
                              if (currentView !== item.id) {
                                onNavigate?.(item.id);
                              }
                              setOpenDropdown(null);
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs font-semibold transition ${
                              isLocked
                                ? "cursor-not-allowed opacity-50 text-slate-500"
                                : isOptActive
                                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                                : "text-slate-300 hover:bg-slate-800 hover:text-white"
                            }`}
                            title={isLocked ? "Settings restricted to authorized roles." : opt.label}
                          >
                            <div className="flex items-center gap-2">
                              <OptIcon
                                className={`h-4 w-4 ${isOptActive ? "text-emerald-400" : "text-slate-400"}`}
                              />
                              <span>{opt.label}</span>
                            </div>
                            {isOptActive && (
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate?.(item.id)}
                className={`flex items-center gap-1.5 rounded-lg py-1.5 transition shrink-0 ${
                  isActive
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-950/40 px-3 text-sm lg:text-base font-bold text-white tracking-tight"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent px-2 lg:px-2.5 text-xs font-semibold"
                }`}
                title={item.label}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className={isActive ? "h-4 w-4 text-emerald-400 shrink-0" : "h-3.5 w-3.5 shrink-0"} />
                <span className={isActive ? "inline" : "hidden lg:inline"}>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* CENTER: Active Month (Instant-Switch) + Day Quick Indicator */}
      <div className="flex items-center gap-1 sm:gap-2 min-w-0">
        {/* Active Month Selector + Action */}
        <div className="flex items-center gap-1 sm:gap-1.5">
          <div className="relative">
            <select
              value={monthId}
              onChange={(e) => {
                if (e.target.value === "__init_next__") {
                  onInitializeNextMonth?.();
                } else {
                  onMonthChange(e.target.value);
                }
              }}
              className="!h-9 !py-1 !pl-2 !pr-6 sm:!pl-2.5 sm:!pr-7 text-[11px] sm:!text-xs font-semibold bg-slate-900 border-slate-700 rounded-lg text-slate-100 hover:border-slate-600 focus:border-emerald-400 cursor-pointer appearance-none max-w-[95px] sm:max-w-none truncate"
              title="Active Month"
            >
              {monthChoices.map(([id, status]) => (
                <option key={id} value={id}>
                  {formatMonthLabel(id)} ({status})
                </option>
              ))}
              {canInitializeNextMonth && nextMonthLabel && (
                <option value="__init_next__">
                  + Open {nextMonthLabel}
                </option>
              )}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 sm:right-2 top-2.5 h-3.5 w-3.5 text-slate-400" />
          </div>

          {/* Month Lifecycle Action: Close Month / Reopen Month / Open Next Month */}
          {canToggleMonth && onToggleMonth && (
            <button
              type="button"
              disabled={isRefreshing}
              onClick={onToggleMonth}
              title={monthToggleDisabledReason ?? monthToggleLabel ?? "Toggle Month Status"}
              className={`flex h-9 items-center gap-1 sm:gap-1.5 rounded-lg border px-2 sm:px-2.5 text-[11px] sm:text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0 ${
                isMonthCloseRequired
                  ? "border-amber-500/60 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 ring-1 ring-amber-400/40 animate-pulse"
                  : currentMonthStatus === "closed"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                  : "border-slate-700 bg-slate-900/90 text-slate-300 hover:border-slate-600 hover:text-white"
              }`}
            >
              {currentMonthStatus === "closed" ? (
                <Unlock className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              ) : (
                <Lock className={`h-3.5 w-3.5 shrink-0 ${isMonthCloseRequired ? "text-amber-400" : "text-slate-400"}`} />
              )}
              <span className="hidden sm:inline">{monthToggleLabel}</span>
              <span className="sm:hidden">
                {currentMonthStatus === "closed" ? "Reopen" : "Close Mo."}
              </span>
            </button>
          )}

          {isMonthCloseRequired && !onToggleMonth && (
            <span
              className="hidden md:inline-flex items-center rounded border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-300"
              title="Month is verified but not closed"
            >
              Close Required
            </span>
          )}
        </div>

        {/* Day Quick Indicator & Popover (when on a day-based ledger view) */}
        {isDayView && selectedDay !== undefined && (
          <div className="relative" ref={dayPopoverRef}>
            <button
              ref={dayButtonRef}
              type="button"
              aria-expanded={dayPopoverOpen}
              aria-haspopup="dialog"
              onClick={() => setDayPopoverOpen((open) => !open)}
              className={`flex h-9 items-center gap-1 sm:gap-1.5 rounded-lg border px-1.5 sm:px-2.5 text-[11px] sm:text-xs font-semibold transition shrink-0 ${
                selectedDayStatus === "closed"
                  ? "border-slate-700 bg-slate-900/80 text-slate-400"
                  : selectedDayStatus === "reopened" || selectedDayStatus === "reopen"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400"
              }`}
              title="Click to quickly switch days"
            >
              <Calendar className="h-3.5 w-3.5 shrink-0" />
              <span>
                {selectedDay === 32 ? "Day 32" : `Day ${selectedDay}`}
              </span>
              <span
                className={`ml-0.5 rounded px-1 text-[9px] sm:text-[10px] uppercase font-bold hidden sm:inline ${
                  selectedDayStatus === "closed"
                    ? "bg-slate-800 text-slate-400"
                    : selectedDayStatus === "reopened" || selectedDayStatus === "reopen"
                    ? "bg-amber-500/20 text-amber-300"
                    : "bg-emerald-500/20 text-emerald-300"
                }`}
              >
                {selectedDayStatus}
              </span>
              <ChevronDown className="h-3 w-3 text-slate-400 shrink-0" />
            </button>

            {/* Compact Day Switcher Popover */}
            {dayPopoverOpen && onDaySelect && (
              <div
                ref={dayPopoverRef}
                role="dialog"
                aria-label="Day selection calendar"
                className="fixed sm:absolute top-14 sm:top-11 left-1/2 -translate-x-1/2 z-50 w-[min(calc(100vw-1rem),16rem)] rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-2xl shadow-black/80"
              >
                <div className="mb-2 flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    {formatMonthLabel(monthId)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">{totalDaysInMonth} Days</span>
                    <button
                      type="button"
                      onClick={() => {
                        setDayPopoverOpen(false);
                        setExpandedCalendarOpen(true);
                      }}
                      className="p-1 text-sky-400 hover:text-sky-300 hover:bg-slate-800 rounded transition"
                      title="Expand calendar into center pop-up"
                      aria-label="Expand calendar into center pop-up"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Weekday headers with Sunday at last */}
                <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase text-slate-500 mb-1">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, idx) => (
                    <span key={day} className={idx === 6 ? "text-amber-400/80 font-bold" : ""}>
                      {day}
                    </span>
                  ))}
                </div>

                {/* Grid */}
                <div className="grid grid-cols-7 gap-1">
                  {(() => {
                    const [y, m] = monthId.split("-");
                    const firstDate = new Date(Number(y), Number(m) - 1, 1);
                    const mondayOffset = (firstDate.getDay() + 6) % 7;
                    return Array.from({ length: mondayOffset }, (_, i) => (
                      <span key={`empty-hdr-${i}`} className="h-7 w-7" aria-hidden="true" />
                    ));
                  })()}
                  {Array.from({ length: totalDaysInMonth }, (_, i) => i + 1).map((d) => {
                    const dayInfo = daysState.find((item) => item.dayNo === d);
                    const status = dayInfo?.status ?? "open";
                    const isSelected = d === selectedDay;
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => {
                          onDaySelect(d);
                          setDayPopoverOpen(false);
                          dayButtonRef.current?.focus();
                        }}
                        className={`flex h-7 w-7 items-center justify-center rounded text-xs font-semibold transition ${
                          isSelected
                            ? "bg-emerald-500 text-slate-950 ring-2 ring-emerald-400/40 font-bold"
                            : status === "closed"
                            ? "bg-slate-800/50 text-slate-500 border border-slate-700/40 hover:bg-slate-800 hover:text-slate-400"
                            : status === "reopened" || status === "reopen"
                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30"
                            : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20"
                        }`}
                        title={`Day ${d} (${status})`}
                      >
                        {d}
                      </button>
                    );
                  })}
                  {/* Day 32 FINAL option */}
                  <button
                    type="button"
                    onClick={() => {
                      onDaySelect(32);
                      setDayPopoverOpen(false);
                      dayButtonRef.current?.focus();
                    }}
                    className={`col-span-7 mt-1.5 flex h-7 items-center justify-center rounded text-xs font-semibold transition ${
                      selectedDay === 32
                        ? "bg-emerald-500 text-slate-950 font-bold"
                        : "bg-purple-500/10 border border-purple-500/30 text-purple-300 hover:bg-purple-500/20"
                    }`}
                    title="FINAL Month-End Settlement"
                  >
                    Day 32 · FINAL Month-End
                  </button>
                </div>
              </div>
            )}

            {/* Centered Expanded Calendar Modal from Header */}
            {expandedCalendarOpen && onDaySelect && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Expanded Calendar Modal"
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setExpandedCalendarOpen(false);
                }}
              >
                <div className="relative w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl shadow-black/90">
                  {/* Modal Header */}
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                        <Calendar className="h-4 w-4" />
                      </span>
                      <div>
                        <h3 className="text-sm font-bold text-white tracking-tight">
                          {formatMonthLabel(monthId)} · Full Calendar View
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          Days of the week with Sunday at last. Click any day to switch.
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpandedCalendarOpen(false)}
                      className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition"
                      title="Close Calendar"
                      aria-label="Close Calendar"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Status Legend */}
                  <div className="flex flex-wrap items-center gap-3 text-[11px] mb-3 p-2 rounded-lg bg-slate-950/60 border border-slate-800">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Legend:</span>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      <span className="text-emerald-300 font-medium">Open (Green)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-amber-400" />
                      <span className="text-amber-300 font-medium">Re-opened (Orange/Yellow)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-slate-600" />
                      <span className="text-slate-400 font-medium">Closed (Disabled)</span>
                    </div>
                  </div>

                  {/* Weekdays */}
                  <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-bold uppercase text-slate-400 mb-1.5">
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, idx) => (
                      <span key={day} className={idx === 6 ? "text-amber-400/90 font-extrabold" : ""}>
                        {day}
                      </span>
                    ))}
                  </div>

                  {/* Modal Grid */}
                  <div className="grid grid-cols-7 gap-1.5">
                    {(() => {
                      const [y, m] = monthId.split("-");
                      const firstDate = new Date(Number(y), Number(m) - 1, 1);
                      const mondayOffset = (firstDate.getDay() + 6) % 7;
                      return Array.from({ length: mondayOffset }, (_, i) => (
                        <div key={`modal-hdr-empty-${i}`} className="h-12 rounded-lg" aria-hidden="true" />
                      ));
                    })()}
                    {Array.from({ length: totalDaysInMonth }, (_, i) => i + 1).map((d) => {
                      const dayInfo = daysState.find((item) => item.dayNo === d);
                      const status = dayInfo?.status ?? "open";
                      const isSelected = d === selectedDay;
                      return (
                        <button
                          key={`modal-hdr-day-${d}`}
                          type="button"
                          onClick={() => {
                            onDaySelect(d);
                            setExpandedCalendarOpen(false);
                            dayButtonRef.current?.focus();
                          }}
                          className={`h-12 flex-col rounded-lg border p-1 text-xs font-semibold flex items-center justify-center transition ${
                            isSelected
                              ? "bg-emerald-500 text-slate-950 ring-2 ring-emerald-400/40 font-bold"
                              : status === "closed"
                              ? "border-slate-800/60 bg-slate-950/40 text-slate-500 hover:bg-slate-900/50"
                              : status === "reopened" || status === "reopen"
                              ? "border-amber-500/40 bg-amber-500/15 text-amber-200 hover:border-amber-400"
                              : "border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:border-emerald-400"
                          }`}
                          title={`Day ${d} (${status})`}
                        >
                          <span className="text-xs font-bold">{d}</span>
                          <span className={`mt-0.5 px-1 rounded text-[8px] font-bold uppercase ${
                            status === "closed"
                              ? "bg-slate-800 text-slate-500"
                              : status === "reopened" || status === "reopen"
                              ? "bg-amber-500/20 text-amber-300"
                              : "bg-emerald-500/20 text-emerald-300"
                          }`}>
                            {status}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Day 32 */}
                  <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">Month-End Settlement</span>
                    <button
                      type="button"
                      onClick={() => {
                        onDaySelect(32);
                        setExpandedCalendarOpen(false);
                        dayButtonRef.current?.focus();
                      }}
                      className={`h-8 inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${
                        selectedDay === 32
                          ? "bg-emerald-500 text-slate-950 font-bold"
                          : "bg-purple-500/10 border border-purple-500/30 text-purple-300 hover:bg-purple-500/20"
                      }`}
                      title="Day 32 FINAL Settlement"
                    >
                      <span>Day 32 · FINAL</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* UNIVERSAL BUTTONS: Close Day / Reopen Day */}
        {isDayView && selectedDay !== undefined && selectedDay !== 32 && (
          <>
            {selectedDayStatus === "closed" ? (
              <button
                type="button"
                disabled={!canReopenSelectedDay}
                title={!canReopenSelectedDay ? (reopenDisabledReason ?? "Only owner can reopen days.") : `Reopen Day ${selectedDay}`}
                onClick={onReopenSelectedDay}
                className="flex h-9 items-center gap-1 sm:gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 sm:px-2.5 text-[11px] sm:text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <Unlock className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">Reopen Day</span>
                <span className="sm:hidden">Reopen</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={!canCloseSelectedDay}
                title={!canCloseSelectedDay ? (closeDisabledReason ?? "This day cannot be closed.") : `Close Day ${selectedDay}`}
                onClick={onCloseSelectedDay}
                className="flex h-9 items-center gap-1 sm:gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 sm:px-2.5 text-[11px] sm:text-xs font-bold text-amber-300 hover:bg-amber-500/20 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">Close Day</span>
                <span className="sm:hidden">Close</span>
              </button>
            )}
          </>
        )}

        {/* UNIVERSAL BUTTON: Refresh (Master Calculation Refresh) */}
        {canRunMasterRefresh && (
          <button
            type="button"
            disabled={isRefreshing}
            onClick={onTriggerMasterRefresh}
            title="Master Calculation Refresh: Recalculate opening balances and day projections across days"
            className="flex h-9 items-center gap-1 sm:gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-2 sm:px-2.5 text-[11px] sm:text-xs font-semibold text-slate-200 hover:border-slate-600 hover:text-white transition disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-emerald-400 shrink-0 ${isRefreshing ? "animate-spin" : ""}`} />
            <span className="hidden md:inline">Refresh</span>
          </button>
        )}
      </div>

      {/* RIGHT: Sync Status + Theme + User Menu */}
      <div className="flex items-center gap-1 sm:gap-2.5 shrink-0">
        {/* Sync Status Pill */}
        <div
          className={`flex items-center gap-1.5 rounded-full border px-2 sm:px-2.5 py-1 text-[11px] font-medium transition ${
            syncState === "synced"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : syncState === "syncing"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
              : syncState === "error"
              ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
              : "border-slate-500/30 bg-slate-500/10 text-slate-400"
          }`}
          title={syncLabel}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              syncState === "synced"
                ? "bg-emerald-400 animate-pulse"
                : syncState === "syncing"
                ? "bg-amber-400 animate-spin"
                : syncState === "error"
                ? "bg-rose-400"
                : "bg-slate-400"
            }`}
          />
          <span className="hidden md:inline capitalize">{syncState}</span>
        </div>

        {/* Theme Toggle */}
        <button
          type="button"
          className="btn-ghost !h-8 !w-8 sm:!h-9 sm:!w-9 !px-0 text-slate-400 hover:text-white"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* User Menu Dropdown */}
        <div className="relative" ref={userMenuRef}>
          <button
            ref={userButtonRef}
            type="button"
            aria-expanded={userMenuOpen}
            aria-haspopup="menu"
            onClick={() => setUserMenuOpen((open) => !open)}
            className="flex items-center gap-1.5 sm:gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-1.5 sm:px-2 py-1 text-xs font-semibold text-slate-200 hover:border-slate-700 transition"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-800 text-slate-300">
              <UserIcon className="h-3.5 w-3.5" />
            </div>
            <span className="hidden sm:inline max-w-[120px] truncate">{displayName}</span>
            <span className={`rounded border px-1.5 py-0.2 text-[10px] font-semibold uppercase hidden xs:inline ${roleBadgeColor}`}>
              {role}
            </span>
            <ChevronDown className="h-3 w-3 text-slate-400" />
          </button>

          {userMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-11 z-50 w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-slate-800 bg-slate-900 p-2.5 shadow-2xl shadow-black/80"
            >
              <div className="border-b border-slate-800 pb-2 px-1">
                <p className="text-xs font-semibold text-white truncate">{displayName}</p>
                {userEmail && <p className="text-[11px] text-slate-400 truncate mt-0.5">{userEmail}</p>}
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 uppercase font-semibold">Role</span>
                  <span className={`rounded border px-1.5 py-0.2 text-[10px] font-semibold uppercase ${roleBadgeColor}`}>
                    {role}
                  </span>
                </div>
              </div>

              {/* Secondary Admin / System destinations */}
              {(canManageUsers || canViewAuditLogs || canUseExcelImport || canUseBackup || canRunMasterRefresh || canToggleMonth || canInitializeNextMonth) && (
                <div className="border-b border-slate-800 py-1.5 my-1 flex flex-col gap-0.5">
                  <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    System & Administration
                  </span>
                  {canManageUsers && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onOpenUsers?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white transition"
                    >
                      <Users className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span>Users & Permissions</span>
                    </button>
                  )}
                  {canViewAuditLogs && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onOpenAuditLogs?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white transition"
                    >
                      <ScrollText className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span>Audit Logs</span>
                    </button>
                  )}
                  {canUseExcelImport && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onOpenImport?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white transition"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span>Excel Import</span>
                    </button>
                  )}
                  {canUseBackup && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onOpenBackup?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white transition"
                    >
                      <FileDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span>System Backup & Restore</span>
                    </button>
                  )}
                  {canRunMasterRefresh && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onTriggerMasterRefresh?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-amber-300 hover:bg-amber-500/10 transition"
                    >
                      <RefreshCw className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      <span>Recalculate Balances (Master Refresh)</span>
                    </button>
                  )}
                  {canToggleMonth && onToggleMonth && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onToggleMonth?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white transition"
                    >
                      {currentMonthStatus === "closed" ? (
                        <Unlock className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <Lock className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      )}
                      <span>{monthToggleLabel} ({formatMonthLabel(monthId)})</span>
                    </button>
                  )}
                  {canInitializeNextMonth && onInitializeNextMonth && nextMonthLabel && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        onInitializeNextMonth?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-blue-300 hover:bg-blue-500/10 transition"
                    >
                      <PlusCircle className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                      <span>Initialize &amp; Open {nextMonthLabel}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Sign Out */}
              <div className="pt-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false);
                    onSignOut();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 transition"
                >
                  <LogOut className="h-4 w-4 shrink-0" />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
