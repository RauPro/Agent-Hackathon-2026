"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { Account } from "@/lib/domain/auth";
import { AccountMenu } from "./account-menu";
import { Mark } from "./brand";
import "@/app/app-header.css";

export function AppHeader({
  account,
  active,
  disabled = false,
}: {
  account: Account;
  active: "chat" | "network";
  disabled?: boolean;
}) {
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const accountToggle = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent | FocusEvent) => {
      const menu = accountMenu.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !accountMenu.current?.open) return;
      event.preventDefault();
      accountMenu.current.open = false;
      accountToggle.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link
          className="app-header-brand"
          href="/onboarding"
          aria-label="Sidekick home"
        >
          <Mark />
          <span>Sidekick</span>
        </Link>
        <nav aria-label="Main">
          <Link
            href="/onboarding"
            aria-current={active === "chat" ? "page" : undefined}
          >
            Chat
          </Link>
          <Link
            href="/network"
            aria-current={active === "network" ? "page" : undefined}
          >
            Network
          </Link>
        </nav>
        <details className="app-header-account" ref={accountMenu}>
          <summary aria-label="Account menu" ref={accountToggle}>
            {account.email.slice(0, 1).toUpperCase()}
          </summary>
          <AccountMenu account={account} disabled={disabled} />
        </details>
      </div>
    </header>
  );
}
