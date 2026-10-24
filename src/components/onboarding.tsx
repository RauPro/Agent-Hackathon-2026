"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  validateDraft,
  type ChatRequest,
  type ChatState,
} from "@/lib/domain/onboarding-chat";
import { ProfilePreview } from "./profile-preview";

function Mark({ small = false }: { small?: boolean }) {
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

export function Onboarding() {
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

  function acceptState(state: { chat: ChatState; configured: boolean }) {
    setChat(state.chat);
    setConfigured(state.configured);
    setLoading(false);
    setNotice("");
    setProblem("");
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/onboarding", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then(acceptState)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setLoading(false);
        setNotice("No pudimos abrir tu conversación.");
      });
    return () => controller.abort();
  }, []);

  async function reconnect() {
    try {
      const response = await fetch("/api/onboarding", { cache: "no-store" });
      if (!response.ok) throw new Error();
      acceptState(await response.json());
      retry.current = null;
    } catch {
      setNotice(
        "No pudimos recuperar la conversación. Tu mensaje sigue aquí; vuelve a intentarlo.",
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          requestId: retry.current.requestId,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setNotice(
          result.message || "No pude responder ahora. Puedes reintentar.",
        );
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
        "No pudimos confirmar la respuesta. Tu mensaje sigue aquí; reintenta sin volver a escribirlo.",
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
        Ir a la conversación
      </a>
      <header className="site-header">
        <div className="brand">
          <Mark />
          <span>
            SF <strong>Sidekick</strong>
          </span>
        </div>
        <span className="city-label">
          <span className="location-dot" />
          San Francisco
        </span>
      </header>
      <main className="chat-layout">
        <section
          className="conversation-column"
          aria-labelledby="chat-title"
          id="conversation"
        >
          <div className="conversation-heading">
            <span className="eyebrow">EMPECEMOS POR TI</span>
            <h1 id="chat-title">
              Tu semana en SF,
              <br className="mobile-break" /> en tus palabras.
            </h1>
            <p>
              Cuéntame lo que buscas. Yo me encargo de ordenar los detalles.
            </p>
          </div>
          {loading ? (
            <div className="loading-state" role="status">
              Abriendo tu conversación…
            </div>
          ) : !chat ? (
            <div className="notice" role="alert">
              <p>{notice}</p>
              <button className="text-button" onClick={() => void reconnect()}>
                Volver a intentar
              </button>
            </div>
          ) : (
            <>
              <div
                className="chat-messages"
                role="log"
                aria-label="Conversación de onboarding"
                aria-live="polite"
                aria-relevant="additions"
              >
                {chat.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`message ${message.role}`}
                    aria-label={
                      message.role === "assistant" ? "Sidekick" : "Tú"
                    }
                  >
                    {message.role === "assistant" && (
                      <div className="assistant-avatar">
                        <Mark small />
                      </div>
                    )}
                    <div className="message-content">
                      <span className="message-author">
                        {message.role === "assistant" ? "Sidekick" : "Tú"}
                      </span>
                      <p>{message.content}</p>
                    </div>
                  </article>
                ))}
                {pendingMessage && (
                  <article
                    className="message user pending"
                    aria-label="Tu mensaje en curso"
                  >
                    <div className="message-content">
                      <span className="message-author">Tú</span>
                      <p>{pendingMessage}</p>
                    </div>
                  </article>
                )}
                {busy === "message" && (
                  <div className="thinking" role="status">
                    <span className="thinking-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    Sidekick está respondiendo…
                  </div>
                )}
                <div ref={lastMessage} />
              </div>

              {chat.confirmed && (
                <div className="confirmed-note" role="status">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>Perfil confirmado</strong>
                    <p>
                      Guardado en este navegador. Si algo cambia, cuéntamelo.
                    </p>
                  </div>
                </div>
              )}
              {ready && !chat.confirmed && (
                <section
                  className="review-prompt"
                  aria-label="Confirmación del perfil"
                >
                  <div>
                    <strong>Ya tenemos un punto de partida.</strong>
                    <p>Revisa lo que he entendido antes de confirmarlo.</p>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setShowReview((value) => !value)}
                    aria-expanded={showReview}
                  >
                    {showReview ? "Ocultar resumen" : "Revisar mi perfil"}
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
                        {busy === "confirm" ? "Guardando…" : "Confirmar perfil"}
                        <span aria-hidden="true">✓</span>
                      </button>
                      <p className="privacy-note">
                        Confirmar no autoriza introducciones ni cambios de
                        calendario.
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
                      Recuperar conversación
                    </button>
                  )}
                  {["profile_changed", "chat_limit"].includes(problem) && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() => void act("reload_saved")}
                    >
                      Empezar desde el perfil guardado
                    </button>
                  )}
                </div>
              )}

              <details className="mobile-profile">
                <summary>
                  Lo que voy entendiendo{" "}
                  <span>
                    {chat.confirmed ? "Confirmado" : "Ver perfil"}{" "}
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
                      <strong>Vista previa · OpenAI por conectar</strong>
                      <br />
                      Puedes escribir; tu mensaje no se enviará todavía.
                    </p>
                    <button
                      className="text-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() => void reconnect()}
                    >
                      Comprobar
                    </button>
                  </div>
                )}
                <form
                  onSubmit={send}
                  className="composer"
                  aria-label="Enviar un mensaje"
                >
                  <label htmlFor="chat-input" className="sr-only">
                    Tu mensaje
                  </label>
                  <textarea
                    ref={composer}
                    id="chat-input"
                    name="message"
                    rows={2}
                    value={input}
                    maxLength={3000}
                    disabled={!!busy}
                    placeholder={
                      chat.messages.length === 1 && !chat.confirmed
                        ? "Estoy en SF esta semana y me gustaría…"
                        : "Cuéntame más, o corrige algún detalle…"
                    }
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
                    <span>En tus palabras. Sin formularios.</span>
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
                      aria-label="Enviar mensaje"
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
                  {configured
                    ? "Conversación con OpenAI · tú confirmas el perfil."
                    : "El perfil solo se confirma cuando tú lo decides."}
                  <span className="keyboard-hint">
                    Mayús + Intro para una nueva línea.
                  </span>
                </p>
              </div>
            </>
          )}
        </section>
        {chat && (
          <aside
            className="desktop-profile"
            aria-label="Perfil en construcción"
          >
            <ProfilePreview chat={chat} />
            <p className="correction-hint">
              <span aria-hidden="true">↳</span> ¿Algo no encaja? Dímelo en el
              chat.
            </p>
          </aside>
        )}
      </main>
    </>
  );
}
