"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  validateDraft,
  type ChatRequest,
  type ChatState,
} from "@/lib/domain/onboarding-chat";
import { ProfilePreview } from "./profile-preview";
import { CalendarConnect } from "./calendar-connect";
import { Mark } from "./brand";
import { AppHeader } from "./app-header";
import { ChatAgentPanel, useAgentPanel } from "./chat-agent-panel";
import "@/app/chat-workspace.css";
import { EventRecommendations } from "./event-recommendations";
import type { Account } from "@/lib/domain/auth";

export function Onboarding({ account }: { account: Account }) {
  const inputKey = `onboarding-unsent-${account.id}`;
  const agents = useAgentPanel();
  const agentTrigger = useRef<HTMLButtonElement>(null);
  const [chat, setChat] = useState<ChatState | null>(null);
  const [configured, setConfigured] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<ChatRequest["action"] | null>(null);
  const [pendingMessage, setPendingMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(true);
  const [showReview, setShowReview] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const lastMessage = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const retry = useRef<{ signature: string; requestId: string } | null>(null);

  const acceptState = useCallback(
    (state: { chat: ChatState; configured: boolean; account: Account }) => {
      if (state.account.id !== account.id) {
        window.location.replace("/onboarding");
        return;
      }
      setChat(state.chat);
      setConfigured(state.configured);
      setLoading(false);
      setNotice("");
      setProblem("");
    },
    [account.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      try {
        setInput(sessionStorage.getItem(inputKey) || "");
      } catch {
        // The conversation remains usable when browser storage is unavailable.
      }
    });
    fetch("/api/onboarding", {
      cache: "no-store",
      signal: controller.signal,
      headers: { "X-Sidekick-Account": account.id },
    })
      .then((response) => {
        if (response.status === 401) window.location.replace("/login");
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then(acceptState)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setLoading(false);
        setNotice("Could not open your conversation.");
      });
    return () => controller.abort();
  }, [account.id, inputKey, acceptState]);

  function preserveInput(value: string) {
    try {
      if (value) sessionStorage.setItem(inputKey, value);
      else sessionStorage.removeItem(inputKey);
    } catch {
      // Keep the current draft in memory if storage is disabled or full.
    }
  }

  async function reconnect() {
    try {
      const response = await fetch("/api/onboarding", {
        cache: "no-store",
        headers: { "X-Sidekick-Account": account.id },
      });
      if (response.status === 401) window.location.replace("/login");
      if (!response.ok) throw new Error();
      acceptState(await response.json());
      retry.current = null;
    } catch {
      setNotice(
        "Could not load the conversation. Your message is still here; try again.",
      );
    }
  }

  function scrollToReply() {
    requestAnimationFrame(() =>
      lastMessage.current?.scrollIntoView({
        block: "center",
        behavior: "instant",
      }),
    );
  }

  async function act(action: ChatRequest["action"]) {
    if (
      !chat ||
      inFlight.current ||
      (action === "message" &&
        (!input.trim() || !configured || problem === "chat_limit"))
    )
      return;
    const payload =
      action === "message"
        ? { action, message: input.trim(), revision: chat.revision }
        : { action, revision: chat.revision };
    const signature = JSON.stringify(payload);
    if (retry.current?.signature !== signature)
      retry.current = { signature, requestId: crypto.randomUUID() };
    inFlight.current = true;
    setBusy(action);
    setNotice("");
    setProblem("");
    if (action === "message") {
      setPendingMessage(input.trim());
      scrollToReply();
    }
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidekick-Account": account.id,
        },
        body: JSON.stringify({
          ...payload,
          requestId: retry.current.requestId,
        }),
      });
      const result = await response.json();
      if (response.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!response.ok) {
        setNotice(result.message || "Could not get a reply. Try again.");
        setProblem(result.code || "unavailable");
        if (result.code === "not_configured") setConfigured(false);
        return;
      }
      setChat(result);
      retry.current = null;
      if (action === "message") {
        setInput("");
        preserveInput("");
        if (composer.current) composer.current.style.height = "auto";
      }
      if (action === "confirm") setShowReview(false);
      scrollToReply();
    } catch {
      setNotice(
        "Could not confirm the reply. Your message is still here; try again.",
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
      setPendingMessage("");
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    void act("message");
  }
  const blocked = [
    "stale_revision",
    "profile_changed",
    "session_missing",
    "request_reused",
  ].includes(problem);
  const ready = chat ? validateDraft(chat.draft).success : false;

  return (
    <>
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      <AppHeader account={account} active="chat" disabled={!!busy} />
      <main className="chat-layout chat-workspace" data-agents-open={agents.open}>
        <section
          className="conversation-column"
          aria-labelledby="chat-title"
          id="conversation"
        >
          <div className="conversation-heading">
            <h1 id="chat-title">Your plans in SF</h1>
            <button
              ref={agentTrigger}
              className="secondary-button agent-panel-trigger"
              type="button"
              aria-controls="chat-agent-panel"
              aria-expanded={agents.open}
              aria-haspopup={agents.desktop ? undefined : "dialog"}
              onClick={() => agents.setOpen(!agents.open)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="M14 4v16" />
              </svg>
              Agent conversations
            </button>
          </div>
          {loading ? (
            <div className="loading-state" role="status">
              Opening conversation…
            </div>
          ) : !chat ? (
            <div className="notice" role="alert">
              <p>{notice}</p>
              <button className="text-button" onClick={() => void reconnect()}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <CalendarConnect
                accountId={account.id}
                chatRevision={chat.revision}
                disabled={!!busy}
                beforeConnect={() => preserveInput(input)}
              />
              <div
                className="chat-messages"
                role="log"
                aria-label="Onboarding conversation"
                aria-relevant="additions"
              >
                {chat.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`message ${message.role}`}
                  >
                    {message.role === "assistant" && (
                      <div className="assistant-avatar">
                        <Mark small />
                      </div>
                    )}
                    <div className="message-content">
                      <span className="message-author">
                        {message.role === "assistant" ? "Sidekick" : "You"}
                      </span>
                      <p>{message.content}</p>
                    </div>
                  </article>
                ))}
                {pendingMessage && (
                  <article className="message user pending">
                    <div className="message-content">
                      <span className="message-author">You</span>
                      <p>{pendingMessage}</p>
                    </div>
                  </article>
                )}
                {busy === "message" && (
                  <div className="thinking">
                    <span className="thinking-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    Sidekick is replying…
                  </div>
                )}
                <div ref={lastMessage} />
              </div>

              {chat.confirmed && (
                <div className="confirmed-note" role="status">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>Profile saved</strong>
                  </div>
                </div>
              )}
              {chat.baseRevision > 0 && (
                <EventRecommendations
                  key={`${account.id}-${chat.baseRevision}`}
                  accountId={account.id}
                  revision={chat.baseRevision}
                  draftChanged={!chat.confirmed}
                />
              )}
              {ready && !chat.confirmed && (
                <section
                  className="review-prompt"
                  aria-label="Profile confirmation"
                >
                  <div>
                    <strong>Your profile is ready to review.</strong>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setShowReview((value) => !value)}
                    aria-expanded={showReview}
                  >
                    {showReview ? "Hide summary" : "Review profile"}
                  </button>
                  {showReview && (
                    <div className="inline-review">
                      <ProfilePreview chat={chat} />
                      <button
                        className="primary-button"
                        disabled={!!busy || blocked}
                        type="button"
                        onClick={() => void act("confirm")}
                      >
                        {busy === "confirm" ? "Saving…" : "Confirm profile"}
                        <span aria-hidden="true">✓</span>
                      </button>
                      <p className="privacy-note">
                        Introductions and calendar changes require separate
                        approval.
                      </p>
                    </div>
                  )}
                </section>
              )}

              {notice && (
                <div className="notice" role="alert">
                  <p>{notice}</p>
                  {[
                    "stale_revision",
                    "session_missing",
                    "request_reused",
                  ].includes(problem) && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void reconnect()}
                    >
                      Load conversation
                    </button>
                  )}
                  {["profile_changed", "chat_limit"].includes(problem) && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() => void act("reload_saved")}
                    >
                      Start from saved profile
                    </button>
                  )}
                </div>
              )}

              <details className="mobile-profile workspace-profile">
                <summary>
                  Profile{" "}
                  <span>
                    {chat.confirmed ? "Confirmed" : "Draft"}
                  </span>
                </summary>
                <div>
                  <ProfilePreview chat={chat} />
                </div>
              </details>
              <div className={`composer-wrap${showReview ? " reviewing" : ""}`}>
                {!configured && (
                  <div className="connection-note">
                    <span className="connection-indicator" />
                    <p>
                      <strong>OpenAI is not connected</strong>
                      <br />
                      Messages cannot be sent yet.
                    </p>
                    <button
                      className="text-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() => void reconnect()}
                    >
                      Check connection
                    </button>
                  </div>
                )}
                <form
                  onSubmit={send}
                  className="composer"
                  aria-label="Message composer"
                >
                  <label htmlFor="chat-input" className="sr-only">
                    Your message
                  </label>
                  <textarea
                    ref={composer}
                    id="chat-input"
                    name="message"
                    rows={2}
                    value={input}
                    maxLength={3000}
                    disabled={!!busy}
                    placeholder="Message Sidekick…"
                    onChange={(event) => {
                      setInput(event.target.value);
                      preserveInput(event.target.value);
                      event.target.style.height = "auto";
                      event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        event.keyCode !== 229
                      ) {
                        event.preventDefault();
                        if (!blocked && problem !== "chat_limit")
                          event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    aria-describedby="composer-hint"
                  />
                  <div className="composer-bottom">
                    <button
                      className="send-button"
                      type="submit"
                      disabled={
                        !configured ||
                        !input.trim() ||
                        !!busy ||
                        blocked ||
                        problem === "chat_limit"
                      }
                      aria-label="Send message"
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 19V5m-6 6 6-6 6 6" />
                      </svg>
                    </button>
                  </div>
                </form>
                <p id="composer-hint" className="composer-hint">
                  {configured && <span>Messages are processed by OpenAI.</span>}
                  <span className="keyboard-hint">
                    Shift + Enter for a new line.
                  </span>
                </p>
              </div>
            </>
          )}
        </section>
        <ChatAgentPanel
          account={account}
          open={agents.open}
          desktop={agents.desktop}
          onClose={() => agents.setOpen(false)}
          triggerRef={agentTrigger}
        />
      </main>
    </>
  );
}
