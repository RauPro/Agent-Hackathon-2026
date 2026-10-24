import { GOALS } from "@/lib/domain/context";
import { validateDraft, type ChatState } from "@/lib/domain/onboarding-chat";

function dateLabel(value: string) {
  if (!value) return "Por definir";
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? `${value} · por revisar`
    : new Intl.DateTimeFormat("es", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(date);
}

export function ProfilePreview({ chat }: { chat: ChatState }) {
  const draft = chat.draft;
  const ready = validateDraft(draft).success;
  return (
    <>
      <div className="profile-heading">
        <span className="eyebrow">TU PERFIL</span>
        <span className={`profile-status ${chat.confirmed ? "confirmed" : ""}`}>
          {chat.confirmed ? "Confirmado" : "Borrador"}
        </span>
      </div>
      <h2>{draft.name || "Te voy conociendo"}</h2>
      <p className="profile-intro">
        {chat.confirmed
          ? "Este es el perfil que has confirmado."
          : "Lo que voy entendiendo, para que puedas corregirme."}
      </p>
      <dl className="profile-facts">
        <div>
          <dt>Qué buscas</dt>
          <dd>
            {draft.goalText || (
              <span className="unknown">Empecemos por aquí.</span>
            )}
          </dd>
          {draft.goalType && (
            <dd className="fact-tag">
              {GOALS.find((goal) => goal.value === draft.goalType)?.label}
            </dd>
          )}
        </div>
        <div>
          <dt>Tu experiencia</dt>
          <dd>
            {draft.bio || <span className="unknown">Todavía por conocer.</span>}
          </dd>
        </div>
        <div>
          <dt>Qué puedes aportar</dt>
          <dd>
            {draft.offers || (
              <span className="unknown">Lo descubrimos conversando.</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Tu estancia en SF</dt>
          <dd>
            {draft.arrival || draft.departure ? (
              `${dateLabel(draft.arrival)} — ${dateLabel(draft.departure)}`
            ) : (
              <span className="unknown">Fechas por definir.</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Disponibilidad</dt>
          <dd>
            {draft.availability.status === "unknown" ? (
              <span className="unknown">Por definir; puede esperar.</span>
            ) : (
              draft.availability.windows.map((window, i) => (
                <span className="fact-row" key={i}>
                  {dateLabel(window.date)} · {window.start}–{window.end}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt>Compromisos fijos</dt>
          <dd>
            {draft.commitments.status === "unknown" ? (
              <span className="unknown">Todavía por revisar.</span>
            ) : draft.commitments.status === "none" ? (
              "Has indicado que no tienes."
            ) : (
              draft.commitments.items.map((item, i) => (
                <span className="fact-row" key={i}>
                  {item.title} · {dateLabel(item.date)}, {item.start}–{item.end}
                </span>
              ))
            )}
          </dd>
        </div>
        {(draft.preferences.meetingFormat !== "any" ||
          draft.preferences.budgetUsd !== null) && (
          <div>
            <dt>Preferencias</dt>
            <dd>
              {draft.preferences.meetingFormat === "one_to_one"
                ? "Conversaciones 1 a 1. "
                : draft.preferences.meetingFormat === "small_groups"
                  ? "Grupos pequeños. "
                  : ""}
              {draft.preferences.budgetUsd !== null
                ? `Hasta $${draft.preferences.budgetUsd} USD por evento.`
                : ""}
            </dd>
          </div>
        )}
      </dl>
      <p className="profile-footnote">
        {chat.confirmed
          ? `Guardado · versión ${chat.baseRevision}`
          : ready
            ? "Listo para revisar y confirmar."
            : "Seguimos completándolo. Nada se confirma automáticamente."}
      </p>
    </>
  );
}
