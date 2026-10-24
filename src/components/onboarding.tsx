"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  contextSchema,
  emptyContext,
  fieldErrors,
  GOALS,
  goalSchema,
  profileSchema,
  scheduleSchema,
  type ContextState,
  type FieldErrors,
  type UserContext,
} from "@/lib/domain/context";
import { ContextSummary } from "./context-summary";
import { Field, fieldAttributes, GoalIcon, Mark } from "./form-fields";
import { ScheduleFields } from "./schedule-fields";

const steps = ["Tu objetivo", "Tu experiencia", "Tu estancia", "Revisar"];
const headings = [
  "¿Qué quieres conseguir en SF?",
  "Cuéntanos un poco sobre ti.",
  "Hagamos espacio para conversar.",
  "Tu punto de partida.",
];
const descriptions = [
  "Elige una prioridad. Podrás cambiarla cuando cambien tus planes.",
  "Un poco de contexto para entender qué buscas y qué puedes aportar.",
  "Cuéntanos cuándo estarás aquí. Los horarios pueden esperar si aún no los tienes claros.",
  "Revisa que esto refleje lo que buscas. Tú decides qué se guarda.",
];
const goalExamples = [
  "Quiero conocer equipos pequeños de agentes que estén buscando un founding engineer.",
  "Me gustaría conocer a un founding engineer con experiencia en agentes para construir nuestro primer producto.",
  "Quiero encontrar dos equipos con los que explorar un piloto de mi producto.",
  "Quiero conocer a otros builders que estén trabajando en agentes y compartir ideas.",
];

export function Onboarding() {
  const [context, setContext] = useState<UserContext>(emptyContext);
  const [saved, setSaved] = useState<ContextState | null>(null);
  const [step, setStep] = useState(0);
  const [view, setView] = useState<"form" | "saved">("form");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState<
    "network" | "session" | "conflict" | null
  >(null);
  const [remote, setRemote] = useState<ContextState | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<{ signature: string; requestId: string } | null>(null);
  const requestInFlight = useRef(false);

  const load = useCallback(
    async (preserveDraft = false, signal?: AbortSignal) => {
      try {
        const response = await fetch("/api/state", {
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw new Error("unavailable");
        const state: ContextState = await response.json();
        setSaved(state);
        if (!preserveDraft) {
          setContext(state.context ?? emptyContext());
          setView(state.context ? "saved" : "form");
        }
        setConfirmed(false);
        setNotice("");
        setProblem(null);
        setLoading(false);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setNotice(
          "No pudimos recuperar tu perfil. Comprueba la conexión y vuelve a intentarlo.",
        );
        setProblem(preserveDraft ? "session" : "network");
        setLoading(false);
      }
    },
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/state", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<ContextState>;
      })
      .then((state) => {
        setSaved(state);
        setContext(state.context ?? emptyContext());
        setView(state.context ? "saved" : "form");
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setNotice(
          "No pudimos recuperar tu perfil. Comprueba la conexión y vuelve a intentarlo.",
        );
        setProblem("network");
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  function focusHeading() {
    requestAnimationFrame(() => {
      heading.current?.focus();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
  }
  function goTo(next: number) {
    setStep(next);
    setErrors({});
    setConfirmed(false);
    focusHeading();
  }
  function update(next: UserContext) {
    setContext(next);
    setConfirmed(false);
    setErrors({});
  }
  function focusError(next: FieldErrors) {
    requestAnimationFrame(() =>
      document.getElementById(Object.keys(next)[0])?.focus(),
    );
  }
  function showErrors(next: FieldErrors) {
    setErrors(next);
    focusError(next);
  }
  function errorStep(key: string) {
    return key.startsWith("goal")
      ? 0
      : key.startsWith("profile")
        ? 1
        : key === "confirmed"
          ? 3
          : 2;
  }
  function validateStep() {
    const result =
      step === 0
        ? goalSchema.safeParse(context.goal)
        : step === 1
          ? profileSchema.safeParse(context.profile)
          : scheduleSchema.safeParse({
              trip: context.trip,
              availability: context.availability,
              commitments: context.commitments,
              preferences: context.preferences,
            });
    if (result.success) return true;
    const prefix = step === 0 ? "goal." : step === 1 ? "profile." : "";
    showErrors(
      Object.fromEntries(
        Object.entries(fieldErrors(result.error)).map(([key, value]) => [
          prefix + key,
          value,
        ]),
      ),
    );
    return false;
  }
  async function readLatest() {
    try {
      const latest = await fetch("/api/state", { cache: "no-store" });
      if (!latest.ok) throw new Error();
      setRemote(await latest.json());
    } catch {
      setNotice(
        "Tu perfil cambió, pero no pudimos recuperar esa versión. Tus cambios siguen aquí; reintenta la lectura.",
      );
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step < 3) {
      if (validateStep()) goTo(step + 1);
      return;
    }
    if (requestInFlight.current) return;
    const parsed = contextSchema.safeParse(context);
    if (!parsed.success) {
      const next = fieldErrors(parsed.error);
      setStep(errorStep(Object.keys(next)[0]));
      showErrors(next);
      return;
    }
    if (!confirmed) {
      showErrors({ confirmed: "Confirma el resumen para guardar." });
      return;
    }
    if (!saved || problem === "conflict" || problem === "session") return;
    requestInFlight.current = true;
    setSaving(true);
    setNotice("");
    setProblem(null);
    const baseRevision = saved.revision;
    const signature = JSON.stringify({ context: parsed.data, baseRevision });
    if (retry.current?.signature !== signature)
      retry.current = { signature, requestId: crypto.randomUUID() };
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: parsed.data,
          baseRevision,
          requestId: retry.current.requestId,
          confirmed: true,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setNotice(result.message || "No se pudo guardar. Vuelve a intentarlo.");
        if (response.status === 409) {
          setProblem("conflict");
          setRemote(null);
          await readLatest();
        } else if (response.status === 401) setProblem("session");
        else if (result.errors) {
          const next = Object.fromEntries(
            Object.entries(result.errors as FieldErrors).map(([key, value]) => [
              key.replace(/^context\./, ""),
              value,
            ]),
          );
          setStep(errorStep(Object.keys(next)[0]));
          showErrors(next);
        }
        return;
      }
      setSaved(result);
      setContext(result.context);
      setView("saved");
      setConfirmed(false);
      retry.current = null;
      focusHeading();
    } catch {
      setNotice(
        "No pudimos confirmar el guardado. Tus datos siguen aquí; reintenta cuando vuelva la conexión.",
      );
    } finally {
      requestInFlight.current = false;
      setSaving(false);
    }
  }
  const attrs = (id: string, hint = false) => fieldAttributes(id, errors, hint);

  return (
    <>
      <a className="skip-link" href="#main">
        Ir al contenido
      </a>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="SF Sidekick, inicio">
          <Mark />
          <span>
            SF <strong>Sidekick</strong>
          </span>
        </Link>
        <span className="city-label">
          <span className="location-dot" /> San Francisco
        </span>
      </header>
      <main id="main" className="app-shell">
        <aside className="journey-sidebar">
          <span className="eyebrow">UN POCO DE CONTEXTO</span>
          <h2>
            Tu tiempo aquí
            <br />
            puede abrir puertas.
          </h2>
          <p>
            Empecemos por lo que quieres conseguir y lo que hace que una
            conversación valga la pena para ti.
          </p>
          <nav aria-label="Pasos del onboarding" className="steps">
            <ol>
              {steps.map((label, index) => (
                <li
                  key={label}
                  className={
                    view === "saved" || index < step
                      ? "complete"
                      : index === step
                        ? "active"
                        : ""
                  }
                >
                  <button
                    type="button"
                    disabled={
                      loading ||
                      saving ||
                      !saved ||
                      view === "saved" ||
                      index >= step
                    }
                    aria-current={
                      view === "form" && index === step ? "step" : undefined
                    }
                    onClick={() => goTo(index)}
                  >
                    <span className="step-number" aria-hidden="true">
                      {view === "saved" || index < step ? "✓" : index + 1}
                    </span>
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <p className="sidebar-note">
            <span aria-hidden="true">↳</span> Empieza con un objetivo.
            <br />
            El resto puede ir tomando forma.
          </p>
        </aside>
        <div className="content-column">
          {loading ? (
            <div className="loading-panel" role="status">
              <span className="loading-dot" /> Preparando tu espacio…
            </div>
          ) : !saved ? (
            <div className="connection-panel" role="alert">
              <h1>No pudimos abrir tu espacio.</h1>
              <p>{notice}</p>
              <button
                className="primary-button"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
              >
                Volver a intentar
              </button>
            </div>
          ) : (
            <>
              <div className="mobile-progress">
                <span>
                  {view === "saved"
                    ? "Tu perfil está listo"
                    : `Paso ${step + 1} de 4`}
                </span>
                <span>
                  {view === "saved" ? "Confirmado por ti" : steps[step]}
                </span>
                <div className="progress-track">
                  {steps.map((_, i) => (
                    <span
                      key={i}
                      className={view === "saved" || i <= step ? "filled" : ""}
                    />
                  ))}
                </div>
              </div>
              {view === "saved" ? (
                <div className="saved-view">
                  <span className="saved-badge">
                    <span aria-hidden="true">✓</span> Perfil guardado
                  </span>
                  <h1 ref={heading} tabIndex={-1}>
                    Ya tenemos un punto de partida.
                  </h1>
                  <p className="intro-copy">
                    {context.profile.name}, este es el contexto que has
                    confirmado. Puedes volver y ajustarlo cuando lo necesites.
                  </p>
                  <ContextSummary context={context} />
                  <div className="saved-footer">
                    <span>Confirmado por ti · versión {saved.revision}</span>
                    <button
                      className="primary-button"
                      onClick={() => {
                        setView("form");
                        goTo(0);
                      }}
                    >
                      Editar mi perfil <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                  <p className="local-note">
                    Este perfil se recupera en este navegador. Todavía no se
                    comparte con otras personas.
                  </p>
                </div>
              ) : (
                <form className="onboarding-form" noValidate onSubmit={submit}>
                  <div className="form-intro">
                    <span className="eyebrow">
                      {step === 3
                        ? "ANTES DE EMPEZAR"
                        : `PASO ${String(step + 1).padStart(2, "0")}`}
                    </span>
                    <h1 ref={heading} tabIndex={-1}>
                      {headings[step]}
                    </h1>
                    <p className="intro-copy">{descriptions[step]}</p>
                  </div>
                  {notice && (
                    <div className="notice" role="alert">
                      <p>{notice}</p>
                      {problem === "session" && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => void load(true)}
                        >
                          Reconectar y conservar mis datos
                        </button>
                      )}
                      {problem === "conflict" &&
                        (!remote ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void readLatest()}
                          >
                            Reintentar lectura
                          </button>
                        ) : (
                          <>
                            <details>
                              <summary>Ver la versión guardada</summary>
                              {remote.context && (
                                <ContextSummary context={remote.context} />
                              )}
                            </details>
                            <div className="conflict-actions">
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => {
                                  setSaved(remote);
                                  setContext(remote.context ?? emptyContext());
                                  setRemote(null);
                                  setNotice("");
                                  setProblem(null);
                                  goTo(0);
                                }}
                              >
                                Cargar versión guardada
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => {
                                  setSaved(remote);
                                  setRemote(null);
                                  setNotice(
                                    "Al confirmar, tus cambios reemplazarán la versión guardada. Revisa ambas versiones antes de continuar.",
                                  );
                                  setProblem(null);
                                  setConfirmed(false);
                                  retry.current = null;
                                }}
                              >
                                Revisar mis cambios
                              </button>
                            </div>
                          </>
                        ))}
                    </div>
                  )}
                  {Object.keys(errors).length > 0 && (
                    <p className="validation-notice" role="alert">
                      Hay información por revisar. Comprueba los campos
                      señalados.
                    </p>
                  )}
                  <fieldset className="form-fields" disabled={saving}>
                    <legend className="sr-only">{steps[step]}</legend>
                    {step === 0 && (
                      <>
                        <fieldset className="goal-grid">
                          <legend className="sr-only">
                            Tu objetivo principal
                          </legend>
                          {GOALS.map((goal, index) => (
                            <label className="goal-option" key={goal.value}>
                              <input
                                type="radio"
                                name="goal-type"
                                value={goal.value}
                                checked={context.goal.type === goal.value}
                                onChange={() =>
                                  update({
                                    ...context,
                                    goal: { ...context.goal, type: goal.value },
                                  })
                                }
                              />
                              <span className="goal-icon">
                                <GoalIcon index={index} />
                              </span>
                              <span className="goal-copy">
                                <strong>{goal.label}</strong>
                                <span>{goal.detail}</span>
                              </span>
                              <span className="radio-mark" aria-hidden="true" />
                            </label>
                          ))}
                        </fieldset>
                        <Field
                          id="goal.text"
                          label="¿Cómo sería una buena semana para ti?"
                          hint="Algo concreto nos ayuda más que una lista larga de intereses."
                          error={errors["goal.text"]}
                        >
                          <textarea
                            {...attrs("goal.text", true)}
                            rows={4}
                            maxLength={1000}
                            value={context.goal.text}
                            onChange={(e) =>
                              update({
                                ...context,
                                goal: { ...context.goal, text: e.target.value },
                              })
                            }
                            placeholder={
                              goalExamples[
                                GOALS.findIndex(
                                  (goal) => goal.value === context.goal.type,
                                )
                              ]
                            }
                          />
                        </Field>
                        <p className="quiet-note">
                          Una prioridad ahora. Puedes cambiar de rumbo después.
                        </p>
                      </>
                    )}
                    {step === 1 && (
                      <>
                        <Field
                          id="profile.name"
                          label="¿Cómo te llamas?"
                          error={errors["profile.name"]}
                        >
                          <input
                            {...attrs("profile.name")}
                            autoComplete="name"
                            maxLength={80}
                            value={context.profile.name}
                            onChange={(e) =>
                              update({
                                ...context,
                                profile: {
                                  ...context.profile,
                                  name: e.target.value,
                                },
                              })
                            }
                            placeholder="Tu nombre"
                          />
                        </Field>
                        <Field
                          id="profile.bio"
                          label="Cuéntanos sobre tu experiencia"
                          hint="Puedes pegar una bio breve o escribir en tus propias palabras."
                          error={errors["profile.bio"]}
                        >
                          <textarea
                            {...attrs("profile.bio", true)}
                            rows={4}
                            maxLength={2000}
                            value={context.profile.bio}
                            onChange={(e) =>
                              update({
                                ...context,
                                profile: {
                                  ...context.profile,
                                  bio: e.target.value,
                                },
                              })
                            }
                            placeholder="Soy ingeniero de producto. He construido agentes en producción y disfruto trabajando en equipos pequeños."
                          />
                        </Field>
                        <Field
                          id="profile.offers"
                          label="¿Qué puedes aportar a una conversación?"
                          hint="Un proyecto, una habilidad, una experiencia o un problema que conoces bien."
                          error={errors["profile.offers"]}
                        >
                          <textarea
                            {...attrs("profile.offers", true)}
                            rows={3}
                            maxLength={1000}
                            value={context.profile.offers}
                            onChange={(e) =>
                              update({
                                ...context,
                                profile: {
                                  ...context.profile,
                                  offers: e.target.value,
                                },
                              })
                            }
                            placeholder="Experiencia llevando prototipos de agentes a producción y aprendiendo de sus primeros usuarios."
                          />
                        </Field>
                      </>
                    )}
                    {step === 2 && (
                      <ScheduleFields
                        context={context}
                        update={update}
                        errors={errors}
                      />
                    )}
                    {step === 3 && (
                      <>
                        <ContextSummary context={context} onEdit={goTo} />
                        <div className="confirm-box">
                          <label>
                            <input
                              {...attrs("confirmed")}
                              type="checkbox"
                              checked={confirmed}
                              onChange={(e) => {
                                setConfirmed(e.target.checked);
                                setErrors({});
                              }}
                            />
                            <span>
                              Este resumen refleja lo que busco y lo que puedo
                              aportar.
                            </span>
                          </label>
                          {errors.confirmed && (
                            <p className="field-error" id="confirmed-error">
                              {errors.confirmed}
                            </p>
                          )}
                        </div>
                        <p className="quiet-note">
                          Guardar este perfil no autoriza presentaciones ni
                          cambios en tu calendario.
                        </p>
                      </>
                    )}
                  </fieldset>
                  <div className="form-actions">
                    <div>
                      {step > 0 && (
                        <button
                          type="button"
                          className="back-button"
                          disabled={saving}
                          onClick={() => goTo(step - 1)}
                        >
                          <span aria-hidden="true">←</span> Atrás
                        </button>
                      )}
                    </div>
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={
                        saving ||
                        problem === "conflict" ||
                        problem === "session"
                      }
                    >
                      {saving
                        ? "Guardando…"
                        : step === 3
                          ? "Confirmar y guardar"
                          : "Continuar"}
                      <span aria-hidden="true">{saving ? "" : "→"}</span>
                    </button>
                  </div>
                  <p className="form-footnote">
                    {step < 3
                      ? "Tus datos se guardan al confirmar el resumen."
                      : "Podrás editarlo cuando quieras."}
                  </p>
                </form>
              )}
            </>
          )}
        </div>
      </main>
      <footer className="site-footer">
        <span>SF Sidekick</span>
        <span>Menos ruido. Mejores conversaciones.</span>
      </footer>
    </>
  );
}
