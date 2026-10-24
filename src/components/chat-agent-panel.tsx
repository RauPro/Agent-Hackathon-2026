"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Account } from "@/lib/domain/auth";
import { Network } from "./network";

const desktopQuery = "(min-width: 1100px)";

export function useAgentPanel() {
  const [open, updateOpen] = useState(false);
  const [desktop, updateDesktop] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(desktopQuery);
    const syncLocation = () => {
      const setting = new URL(window.location.href).searchParams.get("agents");
      updateDesktop(media.matches);
      updateOpen(setting === "1" || (setting === null && media.matches));
    };
    syncLocation();
    window.addEventListener("popstate", syncLocation);
    media.addEventListener("change", syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      media.removeEventListener("change", syncLocation);
    };
  }, []);

  function setOpen(value: boolean) {
    updateOpen(value);
    const url = new URL(window.location.href);
    url.searchParams.set("agents", value ? "1" : "0");
    window.history.pushState(null, "", url);
  }

  return { open, desktop, setOpen };
}

export function ChatAgentPanel({
  account,
  open,
  desktop,
  onClose,
  triggerRef,
}: {
  account: Account;
  open: boolean;
  desktop: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);
  const wasDesktop = useRef(false);

  useEffect(() => {
    const dialog = panel.current;
    if (!dialog) return;
    const modeChanged = desktop !== wasDesktop.current;
    const focusedControl = open && wasOpen.current && modeChanged &&
      document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)
      ? document.activeElement
      : null;
    if (dialog.open && (!open || modeChanged)) dialog.close();
    if (open && !dialog.open) {
      if (desktop) {
        // Setting open avoids the focus change that show() performs on desktop.
        dialog.setAttribute("open", "");
      } else {
        dialog.showModal();
      }
    }
    // A responsive mode change must not strand focus on the hidden desktop trigger.
    focusedControl?.focus({ preventScroll: true });
    if (!open && wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
    wasDesktop.current = desktop;
  }, [open, desktop, triggerRef]);

  useEffect(() => {
    if (!open || desktop) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open, desktop]);

  return (
    <dialog
      ref={panel}
      id="chat-agent-panel"
      className="chat-agent-panel"
      role={desktop ? "complementary" : "dialog"}
      aria-modal={desktop ? undefined : true}
      aria-labelledby="agent-panel-title"
      onKeyDown={(event) => {
        if (desktop || event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          "a[href], button, input, textarea, select, summary, [tabindex]",
        )).filter((element) => {
          if (element.tabIndex < 0 || element.matches(":disabled") ||
            !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") return false;
          let closed = element.closest("details:not([open])");
          while (closed) {
            if (!closed.querySelector(":scope > summary")?.contains(element)) return false;
            closed = closed.parentElement?.closest("details:not([open])") ?? null;
          }
          return true;
        });
        const first = controls[0];
        const last = controls.at(-1);
        // Native dialogs can send the last Tab stop to browser chrome. Keep the
        // keyboard loop in this focused mobile view, including reverse Tab.
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (desktop || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <div className="chat-agent-panel-heading">
        <h2 id="agent-panel-title">Agent conversations</h2>
        <button
          className="agent-panel-close"
          type="button"
          aria-label="Close agent conversations"
          onClick={onClose}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className="chat-agent-panel-body">
        <Network account={account} embedded active={open} />
      </div>
    </dialog>
  );
}
