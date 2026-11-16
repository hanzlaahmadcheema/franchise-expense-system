import React, { forwardRef, useState, useEffect, useRef } from "react";

export interface CurrencyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value?: number | null;
  onChange?: (value: number | null, rawText: string) => void;
  onValueChange?: (value: number | null) => void;
  allowNegative?: boolean;
  allowDecimals?: boolean;
  precision?: number;
  prefix?: string;
  error?: string;
  helperText?: string;
}

function formatWithCommas(
  val: number | null,
  allowDecimals: boolean,
  precision: number
): string {
  if (val === null || val === undefined || isNaN(val)) return "";
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: allowDecimals ? precision : 0,
    maximumFractionDigits: allowDecimals ? precision : 0,
    useGrouping: true,
  });
  return formatter.format(val);
}

function sanitizeRawInput(
  raw: string,
  allowNegative: boolean,
  allowDecimals: boolean
): string {
  let cleaned = raw.replace(/,/g, "").trim();
  const isNegative = allowNegative && cleaned.startsWith("-");
  
  cleaned = cleaned.replace(/[^0-9.]/g, "");
  
  if (allowDecimals) {
    const parts = cleaned.split(".");
    if (parts.length > 2) {
      cleaned = parts[0] + "." + parts.slice(1).join("");
    }
  } else {
    cleaned = cleaned.replace(/\./g, "");
  }

  if (isNegative && cleaned.length > 0) {
    cleaned = "-" + cleaned;
  }
  return cleaned;
}

export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  (
    {
      value = null,
      onChange,
      onValueChange,
      allowNegative = false,
      allowDecimals = true,
      precision = 2,
      prefix,
      error,
      helperText,
      className = "",
      disabled = false,
      readOnly = false,
      placeholder = "0.00",
      onFocus,
      onBlur,
      id,
      ...props
    },
    ref
  ) => {
    const [isFocused, setIsFocused] = useState(false);
    const [rawDisplay, setRawDisplay] = useState<string>(() => {
      if (value === null || value === undefined) return "";
      return formatWithCommas(value, allowDecimals, precision);
    });

    // Synchronize internal text when external value changes while not actively focused
    useEffect(() => {
      if (!isFocused) {
        if (value === null || value === undefined) {
          setRawDisplay("");
        } else {
          setRawDisplay(formatWithCommas(value, allowDecimals, precision));
        }
      }
    }, [value, isFocused, allowDecimals, precision]);

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      if (value !== null && value !== undefined && !isNaN(value)) {
        // Show plain number without grouping commas for easier editing
        setRawDisplay(value.toString());
      }
      onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);
      const cleaned = sanitizeRawInput(rawDisplay, allowNegative, allowDecimals);
      if (cleaned === "" || cleaned === "-") {
        setRawDisplay("");
        onChange?.(null, "");
        onValueChange?.(null);
      } else {
        const parsed = parseFloat(cleaned);
        if (isNaN(parsed)) {
          setRawDisplay("");
          onChange?.(null, "");
          onValueChange?.(null);
        } else {
          setRawDisplay(formatWithCommas(parsed, allowDecimals, precision));
          onChange?.(parsed, cleaned);
          onValueChange?.(parsed);
        }
      }
      onBlur?.(e);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const inputVal = e.target.value;
      const cleaned = sanitizeRawInput(inputVal, allowNegative, allowDecimals);
      setRawDisplay(cleaned);

      if (cleaned === "" || cleaned === "-") {
        onChange?.(null, cleaned);
        onValueChange?.(null);
      } else {
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed)) {
          onChange?.(parsed, cleaned);
          onValueChange?.(parsed);
        } else {
          onChange?.(null, cleaned);
          onValueChange?.(null);
        }
      }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const pasteData = e.clipboardData.getData("text");
      const cleaned = sanitizeRawInput(pasteData, allowNegative, allowDecimals);
      setRawDisplay(cleaned);

      if (cleaned === "" || cleaned === "-") {
        onChange?.(null, cleaned);
        onValueChange?.(null);
      } else {
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed)) {
          onChange?.(parsed, cleaned);
          onValueChange?.(parsed);
        } else {
          onChange?.(null, cleaned);
          onValueChange?.(null);
        }
      }
    };

    const hasError = Boolean(error);
    const inputId = id || props.name;

    return (
      <div className="w-full">
        <div className="relative flex items-center">
          {prefix && (
            <span className="pointer-events-none absolute left-3 select-none text-xs font-semibold text-slate-500">
              {prefix}
            </span>
          )}
          <input
            {...props}
            ref={ref}
            id={inputId}
            type="text"
            inputMode="decimal"
            disabled={disabled}
            readOnly={readOnly}
            placeholder={placeholder}
            value={rawDisplay}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPaste={handlePaste}
            aria-invalid={hasError}
            aria-describedby={
              hasError && inputId
                ? `${inputId}-error`
                : helperText && inputId
                ? `${inputId}-helper`
                : undefined
            }
            className={`w-full min-w-0 rounded-lg border bg-slate-950/70 py-2 text-sm font-mono tabular-nums text-slate-100 outline-none transition placeholder:text-slate-500 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 text-right ${
              prefix ? "pl-12 pr-3" : "px-3"
            } ${
              hasError
                ? "border-rose-500 focus:border-rose-400 focus:ring-rose-500/20"
                : "border-slate-700 focus:border-emerald-400 focus:ring-emerald-400/20"
            } ${className}`}
          />
        </div>
        {hasError && (
          <p
            id={inputId ? `${inputId}-error` : undefined}
            className="mt-1 text-xs text-rose-400"
            role="alert"
          >
            {error}
          </p>
        )}
        {!hasError && helperText && (
          <p
            id={inputId ? `${inputId}-helper` : undefined}
            className="mt-1 text-xs text-slate-400"
          >
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

CurrencyInput.displayName = "CurrencyInput";
