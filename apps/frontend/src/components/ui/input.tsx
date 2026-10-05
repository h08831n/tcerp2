import { forwardRef, type InputHTMLAttributes } from "react";

export type InputSize = "sm" | "md";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: InputSize;
}

const sizeClasses: Record<InputSize, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-10 px-3 text-sm",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ inputSize = "md", className = "", ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={`w-full rounded-md border border-slate-300 bg-white text-slate-800 placeholder:text-slate-400 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${sizeClasses[inputSize]} ${className}`}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";
