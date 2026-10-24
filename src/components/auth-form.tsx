"use client";

import { useRef, useState, type FormEvent } from "react";
import { Brand } from "./brand";

export function AuthForm({ next = "/onboarding" }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const lock = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    setErrors({});
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue", email }),
      });
      const result = await response.json();
      if (!response.ok) {
        setNotice(result.message || "Could not continue. Try again.");
        setErrors(result.errors || {});
        return;
      }
      window.location.replace(next);
    } catch {
      setNotice("Could not reach SF Sidekick. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <header className="site-header">
        <Brand />
      </header>
      <main className="auth-layout">
        <h1>Welcome to Sidekick</h1>
        <form
          onSubmit={submit}
          className="auth-form"
          aria-label="Continue with email"
          aria-busy={busy}
        >
          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
            />
            {errors.email && (
              <p className="field-error" id="email-error">
                {errors.email}
              </p>
            )}
          </div>
          {notice && (
            <div className="notice" role="alert">
              <p>{notice}</p>
            </div>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "Please wait…" : "Continue"}
          </button>
        </form>
      </main>
    </>
  );
}
