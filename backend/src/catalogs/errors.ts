/**
 * Phase 4: Catalog Error Utilities
 *
 * Centralised helpers for translating PostgreSQL constraint violations
 * into clean HTTP responses without leaking SQL internals.
 */
import type { Response } from "express";
import { ZodError } from "zod";

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

/**
 * Returns true if the error is a PostgreSQL unique violation (23505).
 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as PgError)?.code === "23505";
}

/**
 * Returns true if the error is a PostgreSQL foreign-key violation (23503).
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return (err as PgError)?.code === "23503";
}

/**
 * Returns true if the error is a PostgreSQL check constraint violation (23514).
 */
export function isCheckViolation(err: unknown): boolean {
  return (err as PgError)?.code === "23514";
}

/**
 * Sends a standardised 400 validation error response from a ZodError.
 */
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

/**
 * Sends a standardised 409 duplicate error response.
 */
export function sendDuplicateError(res: Response, field = "slug"): void {
  res.status(409).json({
    error: "DUPLICATE_VALUE",
    message: `A record with this ${field} already exists in your franchise.`
  });
}

/**
 * Sends a standardised 404 not-found response.
 */
export function sendNotFound(res: Response, entity: string): void {
  res.status(404).json({
    error: "NOT_FOUND",
    message: `${entity} not found.`
  });
}

/**
 * Sends a standardised 500 internal error response.
 * Never includes SQL or connection details.
 */
export function sendInternalError(res: Response, context: string, err: unknown): void {
  console.error(`[${context}]`, err instanceof Error ? err.message : err);
  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An unexpected error occurred. Please try again."
  });
}
