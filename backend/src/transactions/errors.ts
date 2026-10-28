/**
 * Phase 5: Operational Transaction Error Utilities
 *
 * Translates domain errors, PostgreSQL constraints, and closed-day triggers
 * into clean, standardized HTTP responses without leaking database internals.
 */
import type { Response } from "express";
import { ZodError } from "zod";

export class DayClosedError extends Error {
  constructor(message = "Cannot create or modify transactions on a closed accounting day. Day must be reopened by an authorized Owner.") {
    super(message);
    this.name = "DayClosedError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Record not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message = "Validation failed.") {
    super(message);
    this.name = "ValidationError";
  }
}

export class InvalidReferenceError extends Error {
  constructor(message = "Referenced master catalog record not found in this franchise.") {
    super(message);
    this.name = "InvalidReferenceError";
  }
}

export class RevisionConflictError extends Error {
  constructor(public currentRevision: number, public providedRevision: number) {
    super(`Revision conflict: Record is at revision ${currentRevision}, but baseRevision ${providedRevision} was provided. Refresh your state and retry.`);
    this.name = "RevisionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key has already been used with a different request payload.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class DuplicateSettlementError extends Error {
  constructor(message = "Duplicate or excess settlement: amount exceeds remaining receivable for this period.") {
    super(message);
    this.name = "DuplicateSettlementError";
  }
}

export class ConflictError extends Error {
  constructor(message = "Conflict occurred.") {
    super(message);
    this.name = "ConflictError";
  }
}

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

export function isIdempotencyUniqueViolation(err: unknown): boolean {
  const pgErr = err as PgError;
  return pgErr?.code === "23505" && typeof pgErr?.constraint === "string" && pgErr.constraint.includes("mutation_idempotency");
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as PgError)?.code === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return (err as PgError)?.code === "23503";
}

export function isCheckViolation(err: unknown): boolean {
  return (err as PgError)?.code === "23514";
}

export function isClosedDayTriggerViolation(err: unknown): boolean {
  const pgErr = err as PgError;
  return pgErr?.code === "55000" || (typeof pgErr?.message === "string" && pgErr.message.includes("closed accounting day"));
}

export function sendValidationError(res: Response, err: ZodError): void {
  res.status(400).json({
    error: "VALIDATION_ERROR",
    message: "Request validation failed.",
    issues: err.errors.map((e) => ({
      path: e.path.join("."),
      message: e.message
    }))
  });
}

export function sendDuplicateError(res: Response, message = "A record with these unique constraints already exists."): void {
  res.status(409).json({
    error: "DUPLICATE_VALUE",
    message
  });
}

export function sendNotFound(res: Response, entity = "Record"): void {
  res.status(404).json({
    error: "NOT_FOUND",
    message: `${entity} not found.`
  });
}

export function sendDayClosedError(res: Response, message?: string): void {
  res.status(422).json({
    error: "DAY_CLOSED",
    message: message ?? "Cannot mutate transactions on a closed accounting day. Day must be reopened by an authorized Owner."
  });
}

export function sendInvalidReferenceError(res: Response, message?: string): void {
  res.status(400).json({
    error: "INVALID_REFERENCE",
    message: message ?? "Referenced master catalog record does not exist or does not belong to your franchise."
  });
}

export function sendInternalError(res: Response, context: string, err: unknown): void {
  console.error(`[${context}]`, err instanceof Error ? err.message : err);
  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An unexpected error occurred while processing the transaction."
  });
}

export function handleTransactionError(res: Response, context: string, err: unknown): void {
  if (err instanceof ZodError) {
    return void sendValidationError(res, err);
  }
  if (err instanceof ValidationError) {
    return void res.status(400).json({
      error: "VALIDATION_ERROR",
      message: err.message
    });
  }
  if (err instanceof RevisionConflictError) {
    return void res.status(409).json({
      error: "REVISION_CONFLICT",
      code: "REVISION_CONFLICT",
      message: "The record has been modified by another operation. Refresh and retry.",
      current_revision: err.currentRevision,
      currentRevision: err.currentRevision,
      provided_revision: err.providedRevision,
      providedRevision: err.providedRevision
    });
  }
  if (err instanceof IdempotencyConflictError) {
    return void res.status(409).json({
      error: "IDEMPOTENCY_KEY_REUSED",
      code: "IDEMPOTENCY_KEY_REUSED",
      message: err.message
    });
  }
  if (err instanceof DuplicateSettlementError) {
    return void res.status(422).json({
      error: "DUPLICATE_SETTLEMENT",
      code: "DUPLICATE_SETTLEMENT",
      message: err.message
    });
  }
  if (err instanceof ConflictError) {
    return void res.status(409).json({
      error: "CONFLICT",
      message: err.message
    });
  }
  if (err instanceof DayClosedError || isClosedDayTriggerViolation(err)) {
    return void sendDayClosedError(res, err instanceof Error ? err.message : undefined);
  }
  if (err instanceof NotFoundError) {
    return void sendNotFound(res, err.message);
  }
  if (err instanceof InvalidReferenceError) {
    return void sendInvalidReferenceError(res, err.message);
  }
  if (isUniqueViolation(err)) {
    return void sendDuplicateError(res);
  }
  if (isCheckViolation(err)) {
    return void res.status(400).json({
      error: "CONSTRAINT_VIOLATION",
      message: "Transaction values violate database accounting invariants."
    });
  }
  if (isForeignKeyViolation(err)) {
    return void sendInvalidReferenceError(res, "Referenced foreign key entity does not exist or belongs to another tenant.");
  }
  sendInternalError(res, context, err);
}
