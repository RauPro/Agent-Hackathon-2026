"use client";
import { useState } from "react";
import type { Account } from "@/lib/domain/auth";

export function AccountMenu({
  account,
  disabled,
}: {
  account: Account;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function logout() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidekick-Account": account.id,
        },
        body: JSON.stringify({ action: "logout" }),
      });
      if (!response.ok) throw new Error();
      sessionStorage.removeItem(`onboarding-unsent-${account.id}`);
      window.location.replace("/login");
    } catch {
      setError("Could not sign out. Try again.");
      setBusy(false);
    }
  }
  async function deleteAccount() {
    if (busy) return;
    if (
      !window.confirm(
        "Delete your account, profile, connections, meetings and calendar access? This cannot be undone.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidekick-Account": account.id,
        },
        body: JSON.stringify({ action: "delete_account" }),
      });
      if (!response.ok) throw new Error();
      sessionStorage.removeItem(`onboarding-unsent-${account.id}`);
      window.location.replace("/login");
    } catch {
      setError("Could not delete your account. Try again.");
      setBusy(false);
    }
  }
  return (
    <div className="account-menu">
      <div className="account-identity">
        <span>{account.email}</span>
        {!account.emailVerified && <small>Email unverified</small>}
      </div>
      <button
        className="text-button"
        disabled={busy || disabled}
        onClick={() => void logout()}
      >
        {busy ? "Please wait…" : "Sign out"}
      </button>
      <a className="text-button" href="/privacy">
        Privacy
      </a>
      <button
        className="text-button danger-text"
        disabled={busy || disabled}
        onClick={() => void deleteAccount()}
      >
        Delete account
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
