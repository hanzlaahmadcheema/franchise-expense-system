import { useEffect, useMemo, useRef, useState } from "react";
import type { AutoSaveStatus } from "../types/dayControl.types";

type ValidationResult = boolean | string | string[];

type Options<T> = {
  data: T;
  enabled: boolean;
  disabled?: boolean;
  debounceMs?: number;
  resetKey?: string | number;
  validate?: (data: T) => ValidationResult;
  save: (data: T) => Promise<void>;
  serialize?: (data: T) => string;
};

function isValidationOk(result: ValidationResult | undefined) {
  if (result === undefined) return true;
  if (typeof result === "boolean") return result;
  if (typeof result === "string") return result.trim().length === 0;
  return result.length === 0;
}

let activeSavingCount = 0;

export function useAutoSaveEntry<T>({
  data,
  enabled,
  disabled,
  debounceMs = 800,
  resetKey,
  validate,
  save,
  serialize = JSON.stringify
}: Options<T>) {
  const [status, setStatus] = useState<AutoSaveStatus>(disabled ? "readOnly" : "saved");
  const [error, setError] = useState("");
  const lastSavedRef = useRef("");
  const inFlightRef = useRef(false);
  const signature = useMemo(() => serialize(data), [data, serialize]);

  useEffect(() => {
    lastSavedRef.current = signature;
    setStatus(disabled ? "readOnly" : "saved");
    setError("");
  }, [disabled, resetKey]);

  useEffect(() => {
    if (disabled) {
      setStatus("readOnly");
      return;
    }
    if (!enabled) return;
    if (signature === lastSavedRef.current) return;
    const validation = validate?.(data);
    if (!isValidationOk(validation)) {
      const valStr = Array.isArray(validation) ? (validation[0] ?? "") : typeof validation === "string" ? validation : "";
      const isNoMovement = valStr.includes("movement") || valStr.includes("Select");
      setStatus(isNoMovement ? "saved" : "unsaved");
      setError(valStr || "Validation failed.");
      return;
    }
    setStatus("unsaved");
    const timer = window.setTimeout(() => {
      if (signature === lastSavedRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      setStatus("saving");
      setError("");
      activeSavingCount++;
      window.dispatchEvent(new CustomEvent("autosave-active-count", { detail: activeSavingCount }));
      void save(data)
        .then(() => {
          lastSavedRef.current = signature;
          setStatus(navigator.onLine ? "saved" : "pendingSync");
        })
        .catch((err) => {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Error saving");
        })
        .finally(() => {
          inFlightRef.current = false;
          activeSavingCount = Math.max(0, activeSavingCount - 1);
          window.dispatchEvent(new CustomEvent("autosave-active-count", { detail: activeSavingCount }));
        });
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [data, debounceMs, disabled, enabled, save, signature, validate]);

  return {
    autoSaveStatus: status,
    autoSaveError: error,
    hasPendingAutoSave: status === "unsaved" || status === "saving" || status === "error"
  };
}
