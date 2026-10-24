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
import { Brand, Mark } from "./brand";
import { AccountMenu } from "./account-menu";
import type { Account } from "@/lib/domain/auth";

export function Onboarding({ account }: { account: Account }) {
  const inputKey = `onboarding-unsent-${account.id}`;
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
      .then(() => {
        const savedInput = sessionStorage.getItem(inputKey);
        if (savedInput) {
          setInput(savedInput);
          sessionStorage.removeItem(inputKey);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setLoading(false);
        setNotice("Could not open your conversation.");
      });
    return () => controller.abort();
  }, [account.id, inputKey, acceptState]);

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
      <header className="site-header">
        <Brand />
        <AccountMenu account={account} disabled={!!busy} />
      </header>
      <main className="chat-layout">
        <section
          className="conversation-column"
          aria-labelledby="chat-title"
          id="conversation"
        >
          <div className="conversation-heading">
            <h1 id="chat-title">Your plans in SF</h1>
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
                beforeConnect={() => sessionStorage.setItem(inputKey, input)}
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

              <details className="mobile-profile">
                <summary>
                  Profile{" "}
                  <span>
                    {chat.confirmed ? "Confirmed" : "Draft"}{" "}
                    <span aria-hidden="true">↗</span>
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
        {chat && (
          <aside className="desktop-profile" aria-label="Profile preview">
            <ProfilePreview chat={chat} />
          </aside>
        )}
      </main>
    </>
  );
}
