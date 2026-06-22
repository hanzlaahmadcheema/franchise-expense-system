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
  savedStatus?: AutoSaveStatus;
  validationKey?: string | number | boolean | null;
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
  serialize = JSON.stringify,
  savedStatus = "pendingRecalculation",
  validationKey
}: Options<T>) {
  const [status, setStatus] = useState<AutoSaveStatus>(disabled ? "readOnly" : "saved");
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const lastSavedRef = useRef("");
  const inFlightRef = useRef(false);
  const saveAfterInFlightRef = useRef(false);
  const enabledRef = useRef(enabled);
  const disabledRef = useRef(Boolean(disabled));
  const generationRef = useRef(0);
  const saveRef = useRef(save);
  const validateRef = useRef(validate);
  const signature = useMemo(() => serialize(data), [data, serialize]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    validateRef.current = validate;
  }, [validate]);

  useEffect(() => {
    enabledRef.current = enabled;
    disabledRef.current = Boolean(disabled);
    generationRef.current += 1;
  }, [disabled, enabled, resetKey]);

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
    const validation = validateRef.current?.(data);
    if (!isValidationOk(validation)) {
      const valStr = Array.isArray(validation) ? (validation[0] ?? "") : typeof validation === "string" ? validation : "";
      const isNoMovement = valStr.includes("movement") || valStr.includes("Select");
      setStatus(isNoMovement ? "saved" : "unsaved");
      setError(valStr || "Validation failed.");
      return;
    }
    setStatus("typing");
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      if (
        generation !== generationRef.current ||
        disabledRef.current ||
        !enabledRef.current ||
        signature === lastSavedRef.current
      ) return;
      if (inFlightRef.current) {
        saveAfterInFlightRef.current = true;
        return;
      }
      inFlightRef.current = true;
      setStatus("saving");
      setError("");
      activeSavingCount++;
      window.dispatchEvent(new CustomEvent("autosave-active-count", { detail: activeSavingCount }));
      void saveRef.current(data)
        .then(() => {
          lastSavedRef.current = signature;
          setStatus(navigator.onLine ? savedStatus : "pendingSync");
        })
        .catch((err) => {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Error saving");
        })
        .finally(() => {
          inFlightRef.current = false;
          activeSavingCount = Math.max(0, activeSavingCount - 1);
          window.dispatchEvent(new CustomEvent("autosave-active-count", { detail: activeSavingCount }));
          if (saveAfterInFlightRef.current) {
            saveAfterInFlightRef.current = false;
            setRetryToken((current) => current + 1);
          }
        });
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, disabled, enabled, retryToken, savedStatus, signature, validationKey]);

  return {
    autoSaveStatus: status,
    autoSaveError: error,
    hasPendingAutoSave: status === "typing" || status === "unsaved" || status === "saving" || status === "error"
  };
}
