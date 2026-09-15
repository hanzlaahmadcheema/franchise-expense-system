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
