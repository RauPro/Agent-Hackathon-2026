export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={small ? 28 : 32}
      height={small ? 28 : 32}
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
export function Brand() {
  return (
    <div className="brand">
      <Mark />
      <span>
        SF <strong>Sidekick</strong>
      </span>
    </div>
  );
}
