"use client";

import { useRef, useState, type FormEvent } from "react";
import { Brand } from "./brand";

export function AuthForm({ mode }: { mode: "register" | "login" }) {
  const registering = mode === "register";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
        body: JSON.stringify({ action: mode, email, password }),
      });
      const result = await response.json();
      if (!response.ok) {
        setNotice(result.message || "Could not continue. Try again.");
        setErrors(result.errors || {});
        return;
      }
      window.location.replace("/onboarding");
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
        <h1>{registering ? "Create your account" : "Welcome back"}</h1>
        <form
          onSubmit={submit}
          className="auth-form"
          aria-label={registering ? "Registration" : "Sign in"}
        >
          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
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
          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={registering ? "new-password" : "current-password"}
                required
                minLength={registering ? 15 : 1}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                aria-invalid={!!errors.password}
                aria-describedby={
                  errors.password
                    ? "password-error"
                    : registering
                      ? "password-hint"
                      : undefined
                }
              />
              <button
                type="button"
                className="text-button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {errors.password ? (
              <p className="field-error" id="password-error">
                {errors.password}
              </p>
            ) : (
              registering && (
                <p className="auth-hint" id="password-hint">
                  Use at least 15 characters.
                </p>
              )
            )}
          </div>
          {notice && (
            <div className="notice" role="alert">
              <p>{notice}</p>
            </div>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "Please wait…" : registering ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="auth-switch">
          {registering ? "Already have an account?" : "New to SF Sidekick?"}{" "}
          <a href={registering ? "/login" : "/register"}>
            {registering ? "Sign in" : "Create account"}
          </a>
        </p>
      </main>
    </>
  );
}
