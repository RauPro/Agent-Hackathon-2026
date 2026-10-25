import { GOALS } from "@/lib/domain/context";
import { profileGaps, type ChatState } from "@/lib/domain/onboarding-chat";

function dateLabel(value: string) {
  if (!value) return "Not set";
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? `${value} · needs review`
    : new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(date);
}

export function ProfilePreview({ chat }: { chat: ChatState }) {
  const draft = chat.draft;
  const gaps = profileGaps(draft, chat.profileGaps);
  return (
    <>
      <div className="profile-heading">
        <span className="eyebrow">PROFILE</span>
        <span className={`profile-status ${chat.confirmed ? "confirmed" : ""}`}>
          {chat.confirmed ? "Confirmed" : "Draft"}
        </span>
      </div>
      {draft.name && <h2>{draft.name}</h2>}
      <dl className="profile-facts">
        <div>
          <dt>Goal</dt>
          {!chat.confirmed && draft.goalText && gaps.includes("goalText") && <dd className="unknown">Needs more detail</dd>}
          <dd>
            {draft.goalText || <span className="unknown">Not provided</span>}
          </dd>
          {draft.goalType && (
            <dd className="fact-tag">
              {GOALS.find((goal) => goal.value === draft.goalType)?.label}
            </dd>
          )}
        </div>
        <div>
          <dt>Experience</dt>
          {!chat.confirmed && draft.bio && gaps.includes("bio") && <dd className="unknown">Needs more detail</dd>}
          <dd>{draft.bio || <span className="unknown">Not provided</span>}</dd>
        </div>
        <div>
          <dt>What you can offer</dt>
          {!chat.confirmed && draft.offers && gaps.includes("offers") && <dd className="unknown">Needs more detail</dd>}
          <dd>
            {draft.offers || <span className="unknown">Not provided</span>}
          </dd>
        </div>
        <div>
          <dt>Dates in SF</dt>
          <dd>
            {draft.arrival || draft.departure ? (
              `${dateLabel(draft.arrival)} — ${dateLabel(draft.departure)}`
            ) : (
              <span className="unknown">Not set</span>
            )}
          </dd>
        </div>
        {draft.availability.status === "provided" && (
          <div>
            <dt>Preferred meeting times</dt>
            <dd>
              {draft.availability.windows.map((window, i) => (
                <span className="fact-row" key={i}>
                  {dateLabel(window.date)} · {window.start}–{window.end}
                </span>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>Additional commitments</dt>
          <dd>
            {draft.commitments.status === "unknown" ? (
              <span className="unknown">Not mentioned</span>
            ) : draft.commitments.status === "none" ? (
              "None reported"
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
            <dt>Preferences</dt>
            <dd>
              {draft.preferences.meetingFormat === "one_to_one"
                ? "One-to-one conversations. "
                : draft.preferences.meetingFormat === "small_groups"
                  ? "Small groups. "
                  : ""}
              {draft.preferences.budgetUsd !== null
                ? `Up to $${draft.preferences.budgetUsd} USD per event.`
                : ""}
            </dd>
          </div>
        )}
      </dl>
      {chat.confirmed && (
        <p className="profile-footnote">Saved · version {chat.baseRevision}</p>
      )}
    </>
  );
}
