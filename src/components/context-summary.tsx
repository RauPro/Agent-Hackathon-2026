import type { ReactNode } from "react";
import { GOALS, type UserContext } from "@/lib/domain/context";

export function displayDate(value: string) {
  if (!value) return "Por definir";
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function ContextSummary({
  context,
  onEdit,
}: {
  context: UserContext;
  onEdit?: (step: number) => void;
}) {
  const section = (title: string, step: number, children: ReactNode) => (
    <section className="summary-section">
      <div className="summary-heading">
        <h2>{title}</h2>
        {onEdit && (
          <button
            type="button"
            className="text-button"
            onClick={() => onEdit(step)}
            aria-label={`Editar ${title.toLowerCase()}`}
          >
            Editar <span aria-hidden="true">↗</span>
          </button>
        )}
      </div>
      {children}
    </section>
  );
  return (
    <div className="context-summary">
      {section(
        "Busco",
        0,
        <>
          <span className="pill">
            {GOALS.find((goal) => goal.value === context.goal.type)?.label}
          </span>
          <p>{context.goal.text}</p>
        </>,
      )}
      {section(
        "Puedo aportar",
        1,
        <>
          <p className="summary-name">{context.profile.name}</p>
          <p>{context.profile.bio}</p>
          <p className="offer-copy">{context.profile.offers}</p>
        </>,
      )}
      {section(
        "Estoy en SF",
        2,
        <>
          <p>
            {displayDate(context.trip.start)} — {displayDate(context.trip.end)}
          </p>
          <span className="muted">San Francisco · hora del Pacífico</span>
        </>,
      )}
      {section(
        "Disponible",
        2,
        <>
          {context.availability.status === "unknown" ? (
            <p className="muted">Franjas por definir.</p>
          ) : (
            <ul className="summary-list">
              {context.availability.windows.map((window, index) => (
                <li key={index}>
                  {displayDate(window.date)}{" "}
                  <strong>
                    {window.start}–{window.end}
                  </strong>
                </li>
              ))}
            </ul>
          )}
          <div className="commitment-summary">
            <span className="eyebrow">Compromisos fijos</span>
            {context.commitments.status === "unknown" ? (
              <p className="muted">Todavía por revisar.</p>
            ) : context.commitments.status === "none" ? (
              <p>Has indicado que no tienes compromisos fijos.</p>
            ) : (
              <ul className="summary-list">
                {context.commitments.items.map((item, index) => (
                  <li key={index}>
                    <strong>{item.title}</strong>
                    <span>
                      {displayDate(item.date)} · {item.start}–{item.end}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(context.preferences.meetingFormat !== "any" ||
            context.preferences.budgetUsd !== null) && (
            <p className="muted preferences-copy">
              {context.preferences.meetingFormat === "one_to_one"
                ? "Prefieres conversaciones 1 a 1. "
                : context.preferences.meetingFormat === "small_groups"
                  ? "Prefieres grupos pequeños. "
                  : ""}
              {context.preferences.budgetUsd !== null
                ? `Presupuesto máximo por evento: $${context.preferences.budgetUsd} USD.`
                : ""}
            </p>
          )}
        </>,
      )}
    </div>
  );
}
