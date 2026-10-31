"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Brand } from "./brand";

export function AuthForm({ next = "/onboarding" }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [info, setInfo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const lock = useRef(false);

  async function post(body: Record<string, string>) {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, result: await response.json() };
  }

  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    setErrors({});
    try {
      await work();
    } catch {
      setNotice("Could not reach SF Sidekick. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const requestCode = () =>
    run(async () => {
      const { response, result } = await post({ action: "request_code", email });
      if (!response.ok) {
        setNotice(result.message || "Could not send a code. Try again.");
        setErrors(result.errors || {});
        return;
      }
      setStep("code");
      if (result.devCode) {
        setCode(result.devCode);
        setInfo("Development mode: the code was filled in for you.");
      } else {
        setCode("");
        setInfo(`We sent a 6-digit code to ${email.trim()}.`);
      }
    });

  const verify = () =>
    run(async () => {
      const { response, result } = await post({ action: "verify", email, code });
      if (!response.ok) {
        setNotice(result.message || "Could not sign in. Try again.");
        setErrors(result.errors || {});
        return;
      }
      window.location.replace(next);
    });

  function submit(event: FormEvent) {
    event.preventDefault();
    void (step === "email" ? requestCode() : verify());
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
              disabled={busy || step === "code"}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
            />
            {errors.email && (
              <p className="field-error" id="email-error">
                {errors.email}
              </p>
            )}
          </div>
          {step === "code" && (
            <div className="auth-field">
              <label htmlFor="code">Sign-in code</label>
              <input
                id="code"
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, ""))
                }
                disabled={busy}
                aria-invalid={!!errors.code}
                aria-describedby={errors.code ? "code-error" : "code-info"}
              />
              <p className="field-hint" id="code-info">
                {info}
              </p>
              {errors.code && (
                <p className="field-error" id="code-error">
                  {errors.code}
                </p>
              )}
            </div>
          )}
          {notice && (
            <div className="notice" role="alert">
              <p>{notice}</p>
            </div>
          )}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "Please wait…" : step === "email" ? "Continue" : "Sign in"}
          </button>
          {step === "code" && (
            <div className="auth-secondary">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void requestCode()}
              >
                Send a new code
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setNotice("");
                  setErrors({});
                }}
              >
                Use a different email
              </button>
            </div>
          )}
        </form>
        <p className="auth-legal">
          By continuing you agree to how we handle your data in our{" "}
          <Link href="/privacy">privacy notice</Link>.
        </p>
      </main>
    </>
  );
}
