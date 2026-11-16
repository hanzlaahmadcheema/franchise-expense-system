import React, { forwardRef } from "react";
import { LoaderCircle } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "warning" | "ghost" | "outline";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingText?: string;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 font-semibold shadow-sm shadow-emerald-950/20 border border-emerald-400/30",
  secondary:
    "border border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-500 hover:bg-slate-800 active:bg-slate-700 shadow-sm",
  destructive:
    "border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 active:bg-rose-500/30 shadow-sm",
  warning:
    "border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 active:bg-amber-500/30 shadow-sm",
  ghost:
    "border border-transparent bg-transparent text-slate-300 hover:border-slate-800 hover:bg-slate-900/60 hover:text-slate-100 active:bg-slate-800",
  outline:
    "border border-slate-700 bg-transparent text-slate-200 hover:border-slate-500 hover:bg-slate-900 active:bg-slate-800",
};

const sizeStyles: Record<ButtonSize, string> = {
  xs: "min-h-7 h-7 px-2.5 text-xs rounded-md gap-1.5",
  sm: "min-h-8 h-8 px-3 text-xs rounded-lg gap-1.5",
  md: "min-h-10 h-10 px-4 text-sm rounded-lg gap-2",
  lg: "min-h-12 h-12 px-5 text-base rounded-lg gap-2.5",
  icon: "min-h-8 h-8 w-8 p-0 rounded-lg shrink-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      loadingText,
      icon,
      iconPosition = "left",
      disabled = false,
      className = "",
      children,
      type = "button",
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;
    const baseStyle =
      "inline-flex items-center justify-center font-medium leading-tight transition-all focus:outline-none focus:ring-2 focus:ring-emerald-400/40 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-50 select-none";

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        className={`${baseStyle} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        {loading ? (
          <>
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-current" aria-hidden="true" />
            {loadingText ? <span>{loadingText}</span> : children ? <span>{children}</span> : null}
          </>
        ) : (
          <>
            {icon && iconPosition === "left" && <span className="shrink-0 leading-none">{icon}</span>}
            {children && <span>{children}</span>}
            {icon && iconPosition === "right" && <span className="shrink-0 leading-none">{icon}</span>}
          </>
        )}
      </button>
    );
  }
);

Button.displayName = "Button";
