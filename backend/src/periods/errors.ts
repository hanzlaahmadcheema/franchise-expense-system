/**
 * Phase 7B: Period and Seed Domain Error Classes
 *
 * Provides typed, structured domain errors with HTTP status codes
 * and stable machine-readable codes.
 */

export class PeriodError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    statusCode = 400,
    details: Record<string, unknown> = {}
  ) {
    super(`[${code}] ${message}`);
    this.name = "PeriodError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class PeriodNotFoundError extends PeriodError {
  constructor(periodId: string) {
    super("PERIOD_NOT_FOUND", `Accounting period '${periodId}' not found.`, 404, {
      periodId
    });
  }
}

export class PeriodAlreadyExistsError extends PeriodError {
  constructor(periodKey: string, details: Record<string, unknown> = {}) {
    super(
      "PERIOD_ALREADY_EXISTS",
      `Accounting period '${periodKey}' already exists.`,
      409,
      { periodKey, ...details }
    );
  }
}

export class InvalidPeriodKeyError extends PeriodError {
  constructor(periodKey: string, reason: string) {
    super("INVALID_PERIOD_KEY", `Invalid period key '${periodKey}': ${reason}`, 400, {
      periodKey,
      reason
    });
  }
}

export class SeedValidationFailedError extends PeriodError {
  constructor(errors: string[], warnings: string[] = []) {
    super(
      "SEED_VALIDATION_FAILED",
      `Opening seed validation failed: ${errors.join("; ")}`,
      422,
      { errors, warnings, isValid: false }
    );
  }
}

export class MissingFinancialSeedError extends PeriodError {
  constructor(periodId: string) {
    super(
      "MISSING_FINANCIAL_SEED",
      `Missing required period_financial_seeds for period '${periodId}'.`,
      422,
      { periodId }
    );
  }
}

export class MissingCatalogSeedError extends PeriodError {
  constructor(catalogType: string, missingItems: string[]) {
    super(
      "MISSING_CATALOG_SEED",
      `Missing required opening seeds for active ${catalogType}: ${missingItems.join(", ")}`,
      422,
      { catalogType, missingItems }
    );
  }
}

export class SeedsNotVerifiedError extends PeriodError {
  constructor(periodId: string) {
    super(
      "SEEDS_NOT_VERIFIED",
      `Opening seeds for period '${periodId}' must be verified before activation.`,
      422,
      { periodId }
    );
  }
}

export class PeriodNotReadyError extends PeriodError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("PERIOD_NOT_READY", message, 422, details);
  }
}

export class DayActivationBlockedError extends PeriodError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("DAY_ACTIVATION_BLOCKED", message, 422, details);
  }
}

export class TenantIsolationError extends PeriodError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("INV_TENANT_ISOLATION", message, 403, details);
  }
}

export class DayNotFoundError extends PeriodError {
  constructor(dayNo: number, periodId: string) {
    super("DAY_NOT_FOUND", `Accounting day ${dayNo} for period '${periodId}' not found.`, 404, { dayNo, periodId });
  }
}

export class DayAlreadyClosedError extends PeriodError {
  constructor(dayNo: number, details: Record<string, unknown> = {}) {
    super("DAY_ALREADY_CLOSED", `Accounting day ${dayNo} is already closed.`, 409, { dayNo, ...details });
  }
}

export class PreviousDayNotClosedError extends PeriodError {
  constructor(prevDayNo: number, details: Record<string, unknown> = {}) {
    super("PREVIOUS_DAY_NOT_CLOSED", `Previous day ${prevDayNo} must be closed before the next day can open.`, 422, { prevDayNo, ...details });
  }
}

export class MultipleOpenDaysError extends PeriodError {
  constructor(openDayNo: number, details: Record<string, unknown> = {}) {
    super("MULTIPLE_OPEN_DAYS_PROHIBITED", `Cannot open day while day ${openDayNo} is already open. Only one day may be open at a time.`, 409, { openDayNo, ...details });
  }
}

export class NonSequentialDayError extends PeriodError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("NON_SEQUENTIAL_DAY_OPEN", message, 422, details);
  }
}

export class PeriodAlreadyClosedError extends PeriodError {
  constructor(periodKey: string, details: Record<string, unknown> = {}) {
    super("PERIOD_ALREADY_CLOSED", `Accounting period '${periodKey}' is already closed.`, 409, { periodKey, ...details });
  }
}

export class PeriodNotClosedError extends PeriodError {
  constructor(periodKey: string, details: Record<string, unknown> = {}) {
    super("PERIOD_NOT_CLOSED", `Accounting period '${periodKey}' must be closed before this action.`, 422, { periodKey, ...details });
  }
}

export class PeriodHasOpenDaysError extends PeriodError {
  constructor(unclosedCount: number, details: Record<string, unknown> = {}) {
    super("PERIOD_HAS_OPEN_DAYS", `Cannot close period while ${unclosedCount} day(s) remain open or unclosed.`, 422, { unclosedCount, ...details });
  }
}

export class HistoricalPeriodImmutableError extends PeriodError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("HISTORICAL_PERIOD_IMMUTABLE", message, 422, details);
  }
}

export class OverSettlementError extends PeriodError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("OVER_SETTLEMENT", message, 422, details);
  }
}

export class FinalSettlementImmutableError extends PeriodError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("FINAL_SETTLEMENT_IMMUTABLE", message, 409, details);
  }
}

