"use client";

import { useState, useEffect, type FormEvent } from "react";
import { type MeetingView } from "@/lib/domain/meetings";

type Action = (payload: Record<string, unknown>, endpoint?: string) => Promise<boolean>;
const timeLabel = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(value));

export function MeetingForm({
  userId,
  act,
  busy,
  suggestedArea,
}: {
  userId: string;
  act: Action;
  busy: boolean;
  suggestedArea?: string | null;
}) {
  const [purpose, setPurpose] = useState("");
  const [location, setLocation] = useState("");
  const [sent, setSent] = useState(false);
  const [modality, setModality] = useState<"in_person" | "online">("in_person");
  const [shareArea, setShareArea] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await act(
            { action: "propose", toUserId: userId, purpose, modality,
              ...(modality === "in_person" && location.trim() ? { location: location.trim() } : {}),
              ...(modality === "in_person" && shareArea && suggestedArea ? { sharedArea: suggestedArea } : {}),
              authorizeAvailability: true },
            "/api/meetings",
          )
        )
          setSent(true);
      }}
    >
      <label>
        What would you like to discuss?
        <textarea
          required
          minLength={5}
          maxLength={300}
          value={purpose}
          onChange={(event) => {
            setPurpose(event.target.value);
            setSent(false);
          }}
        />
      </label>
      <label>
        Meet
        <select value={modality} onChange={(event) => setModality(event.target.value as typeof modality)}>
          <option value="in_person">In person</option>
          <option value="online">Online · Google Meet</option>
        </select>
      </label>
      {modality === "in_person" && <label>
        Proposed meeting place (optional)
        <input
          minLength={2}
          maxLength={240}
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="A café or public meeting place"
        />
      </label>}
      {modality === "in_person" && suggestedArea && <label className="network-check">
        <input type="checkbox" checked={shareArea} onChange={(event) => setShareArea(event.target.checked)} />
        Share {suggestedArea} as a convenient area for this meeting
      </label>}
      {modality === "in_person" && <a className="text-button" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`cafes and restaurants ${suggestedArea || "San Francisco"}`)}`} target="_blank" rel="noreferrer">Find a café or restaurant</a>}
      <p className="network-muted">
        Your agent will check your calendar and send possible times to your connection’s agent. Both people approve the final 30-minute meeting.
      </p>
      <button className="primary-button" disabled={busy}>
        {busy ? "Checking availability…" : "Coordinate meeting"}
      </button>
      {sent && (
        <p className="network-status" role="status">
          Your agent has started coordinating. Any questions will appear in your main chat.
        </p>
      )}
    </form>
  );
}

export function MeetingCard({
  meeting,
  accountId,
  act,
  busy,
}: {
  meeting: MeetingView;
  accountId: string;
  act: Action;
  busy: boolean;
}) {
  const other = meeting.participants.find(
    (participant) => participant.userId !== accountId,
  );
  const consented = meeting.consentedUserIds.includes(accountId);
  const approved = meeting.approvedUserIds.includes(accountId);
  const [problem, setProblem] = useState("");
  const [place, setPlace] = useState(meeting.location || "");
  const active = ["awaiting_permission", "options_ready", "needs_user_input"].includes(
    meeting.status,
  );
  const labels: Record<MeetingView["status"], string> = {
    awaiting_permission: "Awaiting availability permission",
    options_ready: "Choose a time",
    needs_user_input: "Your input is needed",
    confirmed: "Both people approved",
    withdrawn: "Withdrawn",
    expired: "Expired",
    stale: "Needs a new proposal",
  };
  async function optIn(event: FormEvent) {
    event.preventDefault();
    setProblem("");
    try {
      await act(
        {
          action: "opt_in",
          meetingId: meeting.id,
          revision: meeting.revision,
        },
        "/api/meetings",
      );
    } catch {
      setProblem(
        "Could not check availability. Try again.",
      );
    }
  }
  const chosen = meeting.options.find(
    (option) => option.id === meeting.selectedOptionId,
  );
  return (
    <article className="network-card">
      <div className="network-card-heading">
        <h2>Meet {other?.name || "your connection"}</h2>
        <span className="network-badge">{labels[meeting.status]}</span>
      </div>
      <p>{meeting.purpose}</p>
      <p>
        <strong>{meeting.modality === "online" ? "Online:" : "Place:"}</strong> {meeting.modality === "online" ? "Google Meet" : meeting.location || "Choose a public meeting place"}
      </p>
      {meeting.sharedEvent && <p className="network-muted">Around {meeting.sharedEvent.title} · {timeLabel(meeting.sharedEvent.start)} SF time</p>}
      {meeting.sharedArea && <p>Suggested area: {meeting.sharedArea}</p>}
      {active && meeting.modality !== "online" && !meeting.location && <form onSubmit={(event) => {
        event.preventDefault();
        void act({ action: "set_location", meetingId: meeting.id, revision: meeting.revision, location: place }, "/api/meetings");
      }}>
        <label>Meeting place<input value={place} onChange={(event) => setPlace(event.target.value)} minLength={2} maxLength={240} required placeholder="Name a café or public place" /></label>
        <div className="network-actions">
          <button className="secondary-button" disabled={busy}>Propose this place</button>
          <a className="text-button" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`cafes and restaurants ${meeting.sharedArea || meeting.suggestedArea || "San Francisco"}`)}`}>Find a place nearby</a>
        </div>
      </form>}
      <p className="network-muted">30 minutes · San Francisco time</p>
      {meeting.error && <p className="notice">{meeting.error}</p>}
      {active && meeting.nextAction && <p className="network-status">
        {meeting.nextAction.prompt}{" "}
        <a href={`/onboarding?agents=0&meeting=${meeting.id}`}>Reply in your main chat</a>
      </p>}
      {active && !consented && !meeting.manualAvailabilityNeeded && (
        <form onSubmit={(event) => void optIn(event)}>
          <p className="network-muted">
            Allow Sidekick to check your calendar for this meeting. Your connection sees possible meeting times, never event details.
          </p>
          {problem && (
            <p role="alert" className="field-error">
              {problem}
            </p>
          )}
          <button className="primary-button" disabled={busy}>
            Find a time together
          </button>
        </form>
      )}
      {active && meeting.status !== "needs_user_input" &&
        consented &&
        !meeting.options.length &&
        (meeting.consentedUserIds.length < 2 ? (
          <p className="network-status">
            Waiting for your connection to share availability.
          </p>
        ) : (
          <div className="network-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void act(
                  {
                    action: "opt_in",
                    meetingId: meeting.id,
                    revision: meeting.revision,
                  },
                  "/api/meetings",
                )
              }
            >
              Retry availability
            </button>
          </div>
        ))}
      {meeting.status === "options_ready" && chosen && !approved && (
        <p className="network-status">
          {other?.name || "Your connection"} proposed {timeLabel(chosen.start)}{" "}
          SF time. Approve it or choose another option.
        </p>
      )}
      {meeting.status === "options_ready" && <p className="network-muted">Approving lets either person send a calendar invitation to your Sidekick account email.</p>}
      {meeting.status === "options_ready" &&
        meeting.options.map((option) => (
          <div className="network-slot" key={option.id}>
            <p>
              {timeLabel(option.start)}–
              {new Intl.DateTimeFormat("en-US", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/Los_Angeles",
              }).format(new Date(option.end))}
            </p>
            {approved && chosen?.id === option.id ? (
              <p className="network-status">
                You approved this time. Waiting for your connection.
              </p>
            ) : (
              <button
                className="primary-button"
                disabled={busy || (!meeting.location && meeting.modality !== "online")}
                onClick={() =>
                  void act(
                    {
                      action: "approve",
                      meetingId: meeting.id,
                      revision: meeting.revision,
                      optionId: option.id,
                    },
                    "/api/meetings",
                  )
                }
              >
                Approve this time and place
              </button>
            )}
          </div>
        ))}
      {meeting.status === "confirmed" && chosen && (
        <>
          <p className="network-slot">
            {timeLabel(chosen.start)} SF time · {meeting.location}
          </p>
          <MeetingPublish meeting={meeting} accountId={accountId} busy={busy} act={act} />
          {!meeting.calendarPublication && <a
            className="secondary-button"
            href={`/api/meetings/${meeting.id}/invitation`}
            download
          >
            Download calendar file
          </a>}
        </>
      )}
      {meeting.status !== "confirmed" && meeting.calendarPublication && <div className="meeting-publication">
        <p className="notice">The Sidekick proposal is no longer active. An invitation already created in Google Calendar has not been cancelled.</p>
        {meeting.calendarPublication.organizerUserId === accountId && meeting.calendarPublication.eventUrl && <a className="secondary-button" target="_blank" rel="noreferrer" href={meeting.calendarPublication.eventUrl}>Manage calendar event</a>}
      </div>}
      {active && (
        <div className="network-actions">
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void act(
                {
                  action: "withdraw",
                  meetingId: meeting.id,
                  revision: meeting.revision,
                },
                "/api/meetings",
              )
            }
          >
            Withdraw meeting proposal
          </button>
        </div>
      )}
    </article>
  );
}

function MeetingPublish({ meeting, accountId, busy, act }: { meeting: MeetingView; accountId: string; busy: boolean; act: Action }) {
  const [writeReady, setWriteReady] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const publication = meeting.calendarPublication;
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/calendar", { cache: "no-store", signal: controller.signal, headers: { "X-Sidekick-Account": accountId } })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((status) => setWriteReady(!!status.meetingPublishingReady))
      .catch(() => { if (!controller.signal.aborted) setError("Could not check calendar permissions. Reload to try again."); });
    return () => controller.abort();
  }, [accountId]);
  async function allowPublishing() {
    setConnecting(true); setError("");
    try {
      const response = await fetch("/api/calendar/connect", { method: "POST", headers: { "Content-Type": "application/json", "X-Sidekick-Account": accountId }, body: JSON.stringify({ purpose: "meeting", meetingId: meeting.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not connect Google Calendar.");
      window.location.assign(result.url);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not connect Google Calendar."); setConnecting(false); }
  }
  if (publication?.status === "scheduled") return <div className="meeting-publication">
    <p className="network-status">Calendar invitation sent.</p>
    {publication.error && <p className="notice" role="alert">{publication.error}</p>}
    <div className="network-actions">
      {publication.meetUrl && <a className="primary-button" href={publication.meetUrl} target="_blank" rel="noreferrer">Join Google Meet</a>}
      {publication.eventUrl && <a className="secondary-button" href={publication.eventUrl} target="_blank" rel="noreferrer">Open calendar event</a>}
    </div>
  </div>;
  return <div className="meeting-publication">
    <p className="network-muted">{publication?.status === "conference_pending" ? "The calendar invitation exists. Google is still preparing the Meet link." : publication ? "The calendar invitation needs a check before retrying." : "Both people approved. Send a Google Calendar invitation to your connection’s account email, or download the calendar file."}</p>
    {publication?.error && <p className="notice">{publication.error}</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {publication && publication.organizerUserId !== accountId ? <p>Your connection is preparing the invitation.</p>
      : writeReady === false ? <button className="primary-button" disabled={busy || connecting} onClick={() => void allowPublishing()}>{connecting ? "Opening Google…" : "Allow calendar invitations"}</button>
      : <button className="primary-button" disabled={busy || writeReady === null} onClick={() => void act({ action: "publish", meetingId: meeting.id, revision: meeting.revision }, "/api/meetings")}>{publication ? "Check calendar invitation" : meeting.modality === "online" ? "Send invitation with Google Meet" : "Send calendar invitation"}</button>}
  </div>;
}
