import type { ReactNode } from "react";
import type { FieldErrors } from "@/lib/domain/context";

export function fieldAttributes(id: string, errors: FieldErrors, hint = false) {
  return {
    id,
    name: id,
    "aria-invalid": !!errors[id],
    "aria-describedby":
      [hint ? `${id}-hint` : "", errors[id] ? `${id}-error` : ""]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function Mark() {
  return (
    <svg
      viewBox="0 0 32 32"
      width="32"
      height="32"
      fill="none"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="10" fill="currentColor" />
      <path
        d="M9 21V11m14 10V11M6 15h20M9 12c3 7 11 7 14 0M13 16v5m6-5v5M6 23h20"
        stroke="#f8fbf5"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function GoalIcon({ index }: { index: number }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {index === 0 ? (
        <>
          <rect x="4" y="7" width="16" height="13" rx="3" />
          <path d="M9 7V4h6v3M4 12c5 3 11 3 16 0M12 12v3" />
        </>
      ) : index === 1 ? (
        <>
          <circle cx="10" cy="8" r="3" />
          <path d="M4 20v-2a6 6 0 0 1 12 0v2M19 7v6m-3-3h6" />
        </>
      ) : index === 2 ? (
        <>
          <path d="m4 17 5-5 4 3 7-9M14 6h6v6M4 4v16h16" />
        </>
      ) : (
        <>
          <circle cx="8" cy="9" r="3" />
          <path d="M2 20v-2a6 6 0 0 1 12 0v2M16 6a3 3 0 0 1 0 6m2 3a5 5 0 0 1 4 5" />
        </>
      )}
    </svg>
  );
}
