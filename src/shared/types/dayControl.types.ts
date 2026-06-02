import type { ReactNode } from "react";
import type { UserRole } from "../../types/ledger";

export type ModuleKey = "expense" | "jazzLoad" | "stock";

export type UniversalDayStatus =
  | "missing"
  | "open"
  | "closed"
  | "locked"
  | "reopened"
  | "today"
  | "futureDisabled";

export type AutoSaveStatus =
  | "idle"
  | "typing"
  | "unsaved"
  | "saving"
  | "saved"
  | "pendingSync"
  | "pendingRecalculation"
  | "error"
  | "readOnly"
  | "closed";

export type UniversalDaySnapshot = {
  moduleKey: ModuleKey;
  monthId: string;
  dayNo: number;
  status: UniversalDayStatus;
  dateLabel?: string;
  saved?: boolean;
  reopenedUntilAt?: number;
  disabledReason?: string;
};

export type DayControlPermissions = {
  canCloseSelectedDay: boolean;
  canReopenSelectedDay: boolean;
  canReopenAllDays: boolean;
  canClosePreviousDaysExceptToday: boolean;
  canRunMasterRefresh: boolean;
  closeDisabledReason?: string;
  reopenDisabledReason?: string;
  reopenAllDisabledReason?: string;
  closePreviousDisabledReason?: string;
  masterRefreshDisabledReason?: string;
};

export type UniversalDayControlBarProps = {
  moduleKey: ModuleKey;
  selectedDateLabel: string;
  selectedMonthLabel: string;
  selectedStatus: UniversalDayStatus;
  role: UserRole | null;
  permissions: DayControlPermissions;
  autoSaveStatus?: AutoSaveStatus;
  busy?: boolean;
  density?: "regular" | "compact";
  onCloseSelectedDay: () => void | Promise<void>;
  onReopenSelectedDay: () => void | Promise<void>;
  onReopenAllDays: () => void | Promise<void>;
  onClosePreviousDaysExceptToday: () => void | Promise<void>;
  onRunMasterRefresh: () => void | Promise<void>;
  extraActions?: ReactNode;
};

export type MasterRefreshProgress = {
  step: string;
  detail?: string;
};

export type MasterRefreshResult = {
  daysChecked: number;
  mismatchesCorrected: number;
  monthlySummariesUpdated: number;
  message?: string;
};

export type MasterRefreshModalState = {
  open: boolean;
  title: string;
  progress: MasterRefreshProgress[];
  currentStep?: string;
  result?: MasterRefreshResult;
  error?: string;
};

export type ValidationResult = {
  valid: boolean;
  errors?: string[];
};

export type RecalculatedDayResult = {
  dayNo: number;
  changed: boolean;
  summary?: string;
};

export type MasterRecalculationAdapter = {
  moduleKey: ModuleKey;
  monthId: string;
  label: string;
  canRun: () => boolean;
  disabledReason?: () => string | undefined;
  run: (emit: (progress: MasterRefreshProgress) => void) => Promise<MasterRefreshResult>;
};
