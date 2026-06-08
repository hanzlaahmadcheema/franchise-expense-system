import type { UserRole } from "../../../types/ledger";
import type { ActiveJazzLoadRates } from "../types/jazzLoad.types";

export type JazzLoadSaveBlockReason =
  | "Day closed"
  | "Read-only role"
  | "Invalid input"
  | "No active rate"
  | "Missing DO assignment"
  | "Selected date is future"
  | "Save already in progress";

export type JazzLoadValidationLike = {
  valid: boolean;
  errors: string[];
};

export type JazzLoadSaveStateInput = {
  role: UserRole | null;
  canWriteDaily: boolean;
  selectedDayFuture: boolean;
  selectedDayLive: boolean;
  adminCanEditSelectedDay?: boolean;
  monthClosed: boolean;
  dayClosed: boolean;
  hasDrafts: boolean;
  activeRates: ActiveJazzLoadRates;
  validation: JazzLoadValidationLike;
  saving?: boolean;
};

export type JazzLoadSaveState = {
  canSave: boolean;
  reason: JazzLoadSaveBlockReason | null;
  detail: string;
};

function hasAllActiveRates(activeRates: ActiveJazzLoadRates) {
  return Boolean(activeRates.mlRate?.active && activeRates.commission1Rate?.active && activeRates.commission2Rate?.active);
}

export function classifyJazzLoadValidationError(errors: string[]): Pick<JazzLoadSaveState, "reason" | "detail"> {
  const firstError = errors[0] ?? "Fix Jazz Load validation errors before saving.";
  if (errors.some((error) => error.toLowerCase().includes("missing do assignment") || error.toLowerCase().includes("do name is required"))) {
    return { reason: "Missing DO assignment", detail: errors.find((error) => error.toLowerCase().includes("missing do assignment")) ?? "Missing DO assignment." };
  }
  if (errors.some((error) => error.toLowerCase().includes("no active"))) {
    return { reason: "No active rate", detail: firstError };
  }
  return { reason: "Invalid input", detail: firstError };
}

export function getJazzLoadSaveState(input: JazzLoadSaveStateInput): JazzLoadSaveState {
  if (input.saving) return { canSave: false, reason: "Save already in progress", detail: "Save already in progress." };
  if (input.selectedDayFuture) return { canSave: false, reason: "Selected date is future", detail: "Future Jazz Load days are disabled." };
  if (!input.canWriteDaily) return { canSave: false, reason: "Read-only role", detail: "Read-only role." };
  if (input.role === "admin" && !input.selectedDayLive && !input.adminCanEditSelectedDay) {
    return { canSave: false, reason: "Read-only role", detail: "Admins can only edit the current Jazz Load day or an owner-reopened previous day while it is manually open." };
  }
  if (input.monthClosed) return { canSave: false, reason: "Day closed", detail: "This Jazz Load month is closed." };
  if (input.dayClosed) return { canSave: false, reason: "Day closed", detail: "Day closed." };
  if (!hasAllActiveRates(input.activeRates)) return { canSave: false, reason: "No active rate", detail: "No active rate." };
  if (!input.hasDrafts) return { canSave: false, reason: "Missing DO assignment", detail: "Missing DO assignment." };
  if (!input.validation.valid) {
    const classified = classifyJazzLoadValidationError(input.validation.errors);
    return { canSave: false, reason: classified.reason, detail: classified.detail };
  }
  return { canSave: true, reason: null, detail: "" };
}
