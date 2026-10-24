"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Account } from "@/lib/domain/auth";
import type {
  OpportunityView as Opportunity,
  NetworkEvent,
} from "@/lib/domain/discovery";
import {
  NETWORK_FIELDS,
  type AgentMessage,
  type ConnectionAction,
  type ConnectionView,
  type InformationResult,
  type NetworkField,
  type NetworkSettings,
  type Visibility,
} from "@/lib/domain/network";
import { manualMeetingSlot, type MeetingView } from "@/lib/domain/meetings";
import { Brand } from "./brand";
import { AccountMenu } from "./account-menu";
import { QRScanner } from "./qr-scanner";
import "@/app/network.css";

type NetworkState = {
  accountId: string;
  demo?: boolean;
  settings: NetworkSettings;
  connections: ConnectionView[];
  messages: AgentMessage[];
  opportunities: Opportunity[];
  events: NetworkEvent[];
  meetings: MeetingView[];
};
type Action = (
  payload: Record<string, unknown>,
  endpoint?: string,
) => Promise<boolean>;
const fieldLabels: Record<NetworkField, string> = {
  profile: "Experience and projects",
  goal: "Professional goal",
  trip: "SF dates and neighborhood",
  events: "Events",
};
const fieldDescriptions: Record<NetworkField, string> = {
  profile: "Your confirmed experience and what you offer.",
  goal: "What you are looking for and why.",
  trip: "Your arrival, departure, and optional neighborhood.",
  events:
    "Events you explicitly add here. Each event also has its own visibility.",
};
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value.length === 10 ? `${value}T12:00:00-08:00` : value));
const timeLabel = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(new Date(value));

function Header({
  account,
  disabled = false,
}: {
  account: Account;
  disabled?: boolean;
}) {
  return (
    <header className="site-header network-header">
      <Brand />
      <nav aria-label="Main">
        <a href="/onboarding">Profile</a>
        <a href="/network">Network</a>
      </nav>
      <AccountMenu account={account} disabled={disabled} />
    </header>
  );
}

export function Network({ account }: { account: Account }) {
  const [state, setState] = useState<NetworkState | null>(null);
  const [tab, setTab] = useState<"opportunities" | "connections" | "requests">(
    "opportunities",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState(false);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const retry = useRef<{ signature: string; requestId: string } | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch("/api/network", {
        cache: "no-store",
        signal,
        headers: { "X-Sidekick-Account": account.id },
      });
      if (response.status === 401) {
        window.location.replace("/login?next=%2Fnetwork");
        return;
      }
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.message || "Could not load your network. Try again.",
        );
      if (result.accountId !== account.id) {
        window.location.reload();
        return;
      }
      setState(result);
      setLoading(false);
    },
    [account.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => refresh(controller.signal))
      .catch((problem: unknown) => {
        if (problem instanceof Error && problem.name === "AbortError") return;
        setError(
          problem instanceof Error
            ? problem.message
            : "Could not load your network.",
        );
        setLoading(false);
      });
    const update = () => {
      if (document.visibilityState === "visible" && !inFlight.current)
        void refresh(controller.signal).catch(() => {});
    };
    const interval = setInterval(update, 15000);
    window.addEventListener("focus", update);
    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener("focus", update);
    };
  }, [refresh]);

  const act: Action = async (payload, endpoint = "/api/network") => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify({ endpoint, payload });
    if (retry.current?.signature !== signature)
      retry.current = { signature, requestId: crypto.randomUUID() };
    const body = ["query", "propose"].includes(String(payload.action))
      ? { ...payload, requestId: retry.current.requestId }
      : payload;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidekick-Account": account.id,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (response.status === 401) {
        window.location.replace("/login?next=%2Fnetwork");
        return false;
      }
      if (!response.ok) {
        await refresh().catch(() => {});
        throw new Error(
          result.message || "Could not save this change. Try again.",
        );
      }
      retry.current = null;
      await refresh();
      return true;
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not reach Sidekick. Your input is still here.",
      );
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const pending = state
    ? state.connections.filter(
        (connection) =>
          connection.status === "pending" &&
          connection.direction === "incoming",
      ).length +
      state.messages.filter(
        (message) =>
          message.toUserId === account.id && message.status === "needs_user",
      ).length +
      state.meetings.filter(
        (meeting) =>
          (meeting.status === "awaiting_permission" &&
            !meeting.consentedUserIds.includes(account.id)) ||
          (meeting.status === "options_ready" &&
            !meeting.approvedUserIds.includes(account.id)),
      ).length
    : 0;

  return (
    <>
      <a className="skip-link" href="#network">
        Skip to network
      </a>
      <Header account={account} disabled={busy} />
      <main className="network-layout" id="network">
        <h1>Your network</h1>
        {state?.demo && <p className="network-badge">Demo data</p>}
        {error && (
          <div className="notice network-notice" role="alert">
            <p>{error}</p>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                setError("");
                void refresh().catch((problem: Error) =>
                  setError(problem.message),
                );
              }}
            >
              Retry
            </button>
          </div>
        )}
        {loading && <p className="loading-state">Loading your network…</p>}
        {state && (
          <>
            <details className="network-settings">
              <summary>Discovery and sharing</summary>
              <Settings
                key={state.settings.revision}
                settings={state.settings}
                act={act}
                busy={busy}
              />
            </details>
            <div className="network-actions">
              <button
                className="secondary-button"
                aria-expanded={tools}
                onClick={() => setTools(!tools)}
              >
                {tools ? "Close QR tools" : "Connect with QR"}
              </button>
            </div>
            {tools && (
              <section className="network-tools" aria-label="QR connections">
                <MyQR token={state.settings.qrToken} act={act} busy={busy} />
                <QRScanner />
              </section>
            )}
            <nav className="network-tabs" aria-label="Network views">
              <button
                aria-current={tab === "opportunities" ? "page" : undefined}
                onClick={() => setTab("opportunities")}
              >
                Opportunities
              </button>
              <button
                aria-current={tab === "connections" ? "page" : undefined}
                onClick={() => setTab("connections")}
              >
                Connections
              </button>
              <button
                aria-current={tab === "requests" ? "page" : undefined}
                onClick={() => setTab("requests")}
              >
                Requests{pending > 0 ? ` (${pending})` : ""}
              </button>
            </nav>
            {tab === "opportunities" && (
              <section aria-label="Opportunities">
                {!state.settings.discoverable && (
                  <p className="network-muted">
                    Discovery is off. Enable it in Discovery and sharing to
                    receive recommendations from the network.
                  </p>
                )}
                {!state.opportunities.length && (
                  <p className="network-empty">
                    No new matches yet. Sidekick checks for shared goals and
                    overlapping SF dates as profiles and events change.
                  </p>
                )}
                {state.opportunities.slice(0, 3).map((opportunity) => (
                  <OpportunityCard
                    key={opportunity.id}
                    opportunity={opportunity}
                    act={act}
                    busy={busy}
                    connection={state.connections.find(
                      (item) => item.userId === opportunity.userId,
                    )}
                  />
                ))}
                <EventList events={state.events} act={act} busy={busy} />
              </section>
            )}
            {tab === "connections" && (
              <section aria-label="Connections">
                {!state.connections.filter(
                  (connection) => connection.status !== "removed",
                ).length && (
                  <p className="network-empty">
                    No connections yet. Share your QR code with someone you
                    meet.
                  </p>
                )}
                {state.connections
                  .filter((connection) => connection.status !== "removed")
                  .map((connection) => (
                    <ConnectionCard
                      key={connection.userId}
                      connection={connection}
                      act={act}
                      busy={busy}
                    />
                  ))}
              </section>
            )}
            {tab === "requests" && (
              <section aria-label="Requests">
                {state.connections
                  .filter(
                    (connection) =>
                      connection.status === "pending" &&
                      connection.direction === "incoming",
                  )
                  .map((connection) => (
                    <ConnectionCard
                      key={connection.userId}
                      connection={connection}
                      act={act}
                      busy={busy}
                    />
                  ))}
                {!pending &&
                  !state.messages.length &&
                  !state.meetings.length && (
                    <p className="network-empty">No requests yet.</p>
                  )}
                {state.meetings.map((meeting) => (
                  <MeetingCard
                    key={`${meeting.id}-${meeting.revision}`}
                    meeting={meeting}
                    accountId={account.id}
                    act={act}
                    busy={busy}
                  />
                ))}
                {state.messages.map((message) => (
                  <MessageCard
                    key={message.id}
                    message={message}
                    accountId={account.id}
                    act={act}
                    busy={busy}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}

function Settings({
  settings,
  act,
  busy,
}: {
  settings: NetworkSettings;
  act: Action;
  busy: boolean;
}) {
  const [discoverable, setDiscoverable] = useState(settings.discoverable);
  const [visibility, setVisibility] = useState(settings.visibility);
  const [area, setArea] = useState(settings.area || "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void act({
          action: "settings",
          settings: {
            discoverable,
            visibility,
            area: area.trim() || null,
            revision: settings.revision,
          },
        });
      }}
    >
      <label className="network-check">
        <input
          type="checkbox"
          checked={discoverable}
          onChange={(event) => setDiscoverable(event.target.checked)}
        />
        Let Sidekick recommend me to compatible people
      </label>
      <p className="network-muted">
        Only the fields you share can be used for recommendations or agent
        replies. Calendar details and account emails stay private.
      </p>
      {discoverable &&
        [visibility.profile, visibility.goal, visibility.trip].some(
          (value) => value !== "network",
        ) && (
          <p className="network-muted">
            To match with new people, share your experience, goal, and SF dates
            with discoverable people. Connections can also be matched using
            fields shared with them.
          </p>
        )}
      {NETWORK_FIELDS.map((field) => (
        <label key={field}>
          {fieldLabels[field]}
          <select
            value={visibility[field]}
            onChange={(event) =>
              setVisibility({
                ...visibility,
                [field]: event.target.value as Visibility,
              })
            }
          >
            <option value="private">Only me</option>
            <option value="friends">Connections</option>
            <option value="network">Discoverable people</option>
          </select>
          <span className="network-muted">{fieldDescriptions[field]}</span>
        </label>
      ))}
      <label>
        Neighborhood (optional)
        <input
          value={area}
          maxLength={80}
          placeholder="For example, Downtown SF"
          onChange={(event) => setArea(event.target.value)}
        />
      </label>
      <button className="primary-button" disabled={busy}>
        Save sharing preferences
      </button>
    </form>
  );
}

function MyQR({
  token,
  act,
  busy,
}: {
  token: string;
  act: Action;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const path = `/connect/${token}`;
  return (
    <div>
      <h2 style={{ marginTop: 20 }}>Your connection code</h2>
      {/* The authenticated SVG endpoint changes when the owner rotates their code. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="network-qr"
        src={`/api/network/qr?v=${encodeURIComponent(token)}`}
        width={260}
        height={260}
        alt="Your Sidekick connection QR code"
      />
      <p className="network-muted">
        Anyone with this code can see your name and request a connection. You
        choose whether to accept.
      </p>
      <div className="network-actions">
        <button
          className="secondary-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                new URL(path, window.location.origin).href,
              );
              setCopied(true);
              setError("");
            } catch {
              setError(
                "Could not copy. Open the connection link to copy it from your browser.",
              );
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <a href={path}>Open connection link</a>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setCopied(false);
            void act({ action: "rotate_qr" });
          }}
        >
          Replace code
        </button>
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ConnectPreview({
  account,
  token,
}: {
  account: Account;
  token: string;
}) {
  const [person, setPerson] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [context, setContext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/network?qr=${encodeURIComponent(token)}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "X-Sidekick-Account": account.id },
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.message || "This connection code is no longer available.",
          );
        setPerson(result.person);
      })
      .catch((problem: unknown) => {
        if (problem instanceof Error && problem.name !== "AbortError")
          setError(problem.message);
      });
    return () => controller.abort();
  }, [account.id, token]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!person || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/network", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidekick-Account": account.id,
        },
        body: JSON.stringify({
          action: "connect",
          toUserId: person.id,
          source: "qr",
          token,
          context,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.message || "Could not send the request. Try again.",
        );
      setSent(true);
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not send the request. Try again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Header account={account} disabled={busy} />
      <main className="network-layout">
        <h1>
          {person ? `Connect with ${person.name}` : "Connect on Sidekick"}
        </h1>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {person &&
          !sent &&
          (person.id === account.id ? (
            <p>This is your connection code. Share it with someone you meet.</p>
          ) : (
            <form onSubmit={send}>
              <label>
                Where did you meet? (optional)
                <textarea
                  value={context}
                  maxLength={500}
                  onChange={(event) => setContext(event.target.value)}
                />
              </label>
              <p className="network-muted">
                Your name and this note will accompany the request. Connecting
                does not share your private profile or calendar.
              </p>
              <button className="primary-button" disabled={busy}>
                {busy ? "Sending…" : "Send connection request"}
              </button>
            </form>
          ))}
        {sent && (
          <p role="status">
            Connection request sent. {person?.name} can accept it in Sidekick.
          </p>
        )}
        <div className="network-actions">
          <a href="/network">Back to your network</a>
        </div>
      </main>
    </>
  );
}

function OpportunityCard({
  opportunity,
  act,
  busy,
  connection,
}: {
  opportunity: Opportunity;
  act: Action;
  busy: boolean;
  connection?: ConnectionView;
}) {
  return (
    <article className="network-card">
      <div className="network-card-heading">
        <h2>{opportunity.name}</h2>
        <span className="network-badge">
          {opportunity.source === "demo" ? "Demo · " : ""}Match score{" "}
          {opportunity.score}/100
        </span>
      </div>
      <p>
        <strong>For you:</strong> {opportunity.benefits.you}
      </p>
      <p>
        <strong>For {opportunity.name}:</strong> {opportunity.benefits.them}
      </p>
      <p>In common: {opportunity.signals.slice(0, 4).join(", ")}</p>
      <p className="network-muted">
        Both in SF: {dateLabel(opportunity.overlap.start)}–
        {dateLabel(opportunity.overlap.end)}
      </p>
      {opportunity.sharedEvents.map((event) => (
        <p key={event.id}>
          Shared event: {event.title} · {timeLabel(event.start)} SF time
        </p>
      ))}
      {opportunity.eventSuggestions?.map((event) => (
        <p key={event.id}>
          {opportunity.name} plans to attend {event.title} ·{" "}
          {timeLabel(event.start)} SF time{event.area ? ` · ${event.area}` : ""}
          . Registration and availability have not been checked.
        </p>
      ))}
      <details>
        <summary>Why this was suggested</summary>
        <ul>
          {opportunity.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p>Shared signals: {opportunity.signals.join(", ")}</p>
        <p className="network-muted">
          Based on shared, self-reported profile and event information. Reviewed{" "}
          {dateLabel(opportunity.createdAt)}. Availability has not been checked.
        </p>
      </details>
      <div className="network-actions">
        {connection?.status === "accepted" ? (
          <span className="network-status">
            Connected · coordinate from Connections
          </span>
        ) : connection?.status === "pending" ? (
          <span className="network-status">Connection request pending</span>
        ) : (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() =>
              void act({
                action: "connect",
                toUserId: opportunity.userId,
                source: "opportunity",
                context: opportunity.benefits.them,
              })
            }
          >
            Request connection
          </button>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            void act({ action: "dismiss", opportunityId: opportunity.id })
          }
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}

function ConnectionCard({
  connection,
  act,
  busy,
}: {
  connection: ConnectionView;
  act: Action;
  busy: boolean;
}) {
  const decide = (decision: ConnectionAction) =>
    void act({ action: "connection", toUserId: connection.userId, decision });
  return (
    <article className="network-card">
      <div className="network-card-heading">
        <h2>{connection.name}</h2>
        <span className="network-badge">
          {connection.status === "accepted"
            ? "Connected"
            : connection.status === "blocked"
              ? "Blocked"
              : connection.direction === "incoming"
                ? "Wants to connect"
                : "Request sent"}
        </span>
      </div>
      {connection.context && <p>{connection.context}</p>}
      <p className="network-muted">
        {connection.source === "qr"
          ? "Met through a QR connection"
          : "Suggested by Sidekick"}{" "}
        · {dateLabel(connection.createdAt)}
      </p>
      {connection.status === "pending" &&
        connection.direction === "incoming" && (
          <>
            <p className="network-muted">
              Your agents can use the information you allow connections to see
              to find opportunities.
            </p>
            <div className="network-actions">
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => decide("accept")}
              >
                Accept connection
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => decide("decline")}
              >
                Decline
              </button>
            </div>
          </>
        )}
      {connection.status === "accepted" && (
        <>
          <details>
            <summary>Ask about an opportunity</summary>
            <QueryForm
              userId={connection.userId}
              name={connection.name}
              act={act}
              busy={busy}
            />
          </details>
          <details>
            <summary>Coordinate a meeting</summary>
            <MeetingForm userId={connection.userId} act={act} busy={busy} />
          </details>
        </>
      )}
      <details>
        <summary>Manage connection</summary>
        <p className="network-muted">
          Removing or blocking a connection stops future agent requests and
          access to information shared with connections.
        </p>
        <div className="network-actions">
          {connection.status === "blocked" ? (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => decide("unblock")}
            >
              Unblock
            </button>
          ) : (
            <>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => decide("remove")}
              >
                {connection.status === "pending"
                  ? "Cancel request"
                  : "Remove connection"}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => decide("block")}
              >
                Block
              </button>
            </>
          )}
        </div>
      </details>
    </article>
  );
}

function QueryForm({
  userId,
  name,
  act,
  busy,
}: {
  userId: string;
  name: string;
  act: Action;
  busy: boolean;
}) {
  const [purpose, setPurpose] = useState("");
  const [fields, setFields] = useState<NetworkField[]>(["profile", "goal"]);
  const [sent, setSent] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (await act({ action: "query", toUserId: userId, purpose, fields })) {
          setSent(true);
          setPurpose("");
        }
      }}
    >
      <label>
        What opportunity are you exploring?
        <textarea
          value={purpose}
          minLength={10}
          maxLength={500}
          required
          onChange={(event) => {
            setPurpose(event.target.value);
            setSent(false);
          }}
          placeholder={`For example, a technical cofounder role that may interest ${name}.`}
        />
      </label>
      <fieldset>
        <legend>Ask their Sidekick about</legend>
        {NETWORK_FIELDS.map((field) => (
          <label className="network-check" key={field}>
            <input
              type="checkbox"
              checked={fields.includes(field)}
              onChange={(event) =>
                setFields(
                  event.target.checked
                    ? [...fields, field]
                    : fields.filter((item) => item !== field),
                )
              }
            />
            {fieldLabels[field]}
          </label>
        ))}
      </fieldset>
      <button className="primary-button" disabled={busy || !fields.length}>
        Send request to their Sidekick
      </button>
      {sent && (
        <p className="network-status" role="status">
          Request sent. Follow the response in Requests.
        </p>
      )}
    </form>
  );
}

function informationText(result: InformationResult): ReactNode {
  if (result.status === "not_shared") return "Not shared";
  if (result.status === "unknown" || result.value === undefined)
    return "Not provided";
  const value = result.value;
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.length
      ? value
          .map((event) => `${event.title} · ${timeLabel(event.start)} SF time`)
          .join("\n")
      : "No shared events";
  if ("bio" in value) return `${value.bio}\n${value.offers}`;
  if ("text" in value) return value.text;
  if ("start" in value)
    return `${dateLabel(value.start)}–${dateLabel(value.end)} in San Francisco`;
  return "Not provided";
}

function MessageCard({
  message,
  accountId,
  act,
  busy,
}: {
  message: AgentMessage;
  accountId: string;
  act: Action;
  busy: boolean;
}) {
  const incoming = message.toUserId === accountId;
  const needsAnswer = incoming && message.status === "needs_user";
  const [answers, setAnswers] = useState<Partial<Record<NetworkField, string>>>(
    {},
  );
  const labels = {
    needs_user: "Waiting for an answer",
    completed: "Answered",
    declined: "Declined",
    expired: "Expired",
    revoked: "Access revoked",
  };
  return (
    <article className="network-card">
      <div className="network-card-heading">
        <h2>
          {incoming
            ? `${message.senderName} asked`
            : `Your request to ${message.recipientName}`}
        </h2>
        <span className="network-badge">{labels[message.status]}</span>
      </div>
      <p>{message.purpose}</p>
      <dl>
        {message.fields.map((field) => (
          <div className="network-answer" key={field}>
            <dt>{fieldLabels[field]}</dt>
            <dd>
              {informationText(
                message.response[field] || { status: "unknown" },
              )}
            </dd>
          </div>
        ))}
      </dl>
      {needsAnswer && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const nonempty = Object.fromEntries(
              Object.entries(answers).filter(
                ([field, value]) =>
                  value?.trim() &&
                  message.response[field as NetworkField]?.status !== "shared",
              ),
            );
            if (
              await act({
                action: "answer",
                messageId: message.id,
                answers: nonempty,
                decline: false,
              })
            )
              setAnswers({});
          }}
        >
          <p className="network-muted">
            Share an answer for this request only. Your sharing preferences will
            stay the same.
          </p>
          {message.fields
            .filter((field) => message.response[field]?.status !== "shared")
            .map((field) => (
              <label key={field}>
                {fieldLabels[field]}
                <textarea
                  value={answers[field] || ""}
                  maxLength={2000}
                  onChange={(event) =>
                    setAnswers({ ...answers, [field]: event.target.value })
                  }
                />
              </label>
            ))}
          <div className="network-actions">
            <button
              className="primary-button"
              disabled={
                busy || !Object.values(answers).some((value) => value?.trim())
              }
            >
              Share these answers
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                void act({
                  action: "answer",
                  messageId: message.id,
                  answers: {},
                  decline: true,
                })
              }
            >
              Decline to share more
            </button>
          </div>
        </form>
      )}
      <p className="network-muted">
        {dateLabel(message.createdAt)}
        {message.status === "needs_user"
          ? ` · Expires ${dateLabel(message.expiresAt)}`
          : ""}
      </p>
    </article>
  );
}

function MeetingForm({
  userId,
  act,
  busy,
}: {
  userId: string;
  act: Action;
  busy: boolean;
}) {
  const [purpose, setPurpose] = useState("");
  const [location, setLocation] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await act(
            { action: "propose", toUserId: userId, purpose, location },
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
        Proposed meeting place
        <input
          required
          minLength={2}
          maxLength={240}
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="A public place or a video call"
        />
      </label>
      <p className="network-muted">
        A 30-minute meeting. Both people choose whether to share availability
        and approve the final time and place.
      </p>
      <button className="primary-button" disabled={busy}>
        Propose meeting
      </button>
      {sent && (
        <p className="network-status" role="status">
          Proposed. Review availability in Requests.
        </p>
      )}
    </form>
  );
}

function MeetingCard({
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
  const [date, setDate] = useState("");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [problem, setProblem] = useState("");
  const active = ["awaiting_permission", "options_ready"].includes(
    meeting.status,
  );
  const labels: Record<MeetingView["status"], string> = {
    awaiting_permission: "Awaiting availability permission",
    options_ready: "Choose a time",
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
          ...(meeting.manualAvailabilityNeeded
            ? { manualSlots: [manualMeetingSlot(date, start, end)] }
            : {}),
        },
        "/api/meetings",
      );
    } catch {
      setProblem(
        "Choose a valid SF date and an end time after the start time.",
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
        <strong>Place:</strong> {meeting.location || "Not yet proposed"}
      </p>
      <p className="network-muted">30 minutes · San Francisco time</p>
      {active && (
        <p className="network-muted">
          Checks weekdays, 9 AM–6 PM SF time, within the first 14 days of your
          overlapping stays.
        </p>
      )}
      {meeting.error && <p className="notice">{meeting.error}</p>}
      {active && !consented && (
        <form onSubmit={(event) => void optIn(event)}>
          {meeting.manualAvailabilityNeeded ? (
            <>
              <p className="network-muted">
                Your calendar is not connected. Add a window when you could
                meet, or <a href="/onboarding">connect Google Calendar</a>.
              </p>
              <label>
                Date in SF
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
              <div className="network-field-pair">
                <label>
                  Available from
                  <input
                    type="time"
                    required
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </label>
                <label>
                  Until
                  <input
                    type="time"
                    required
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </label>
              </div>
            </>
          ) : (
            <p className="network-muted">
              Allow Sidekick to check your calendar for this meeting. Your
              connection will see possible meeting times, never event details.
            </p>
          )}
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
      {active &&
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
                disabled={busy}
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
          <p className="network-muted">
            The meeting is agreed. Download and import the calendar file;
            Sidekick has not added it to Google Calendar or sent an invitation.
          </p>
          <a
            className="secondary-button"
            href={`/api/meetings/${meeting.id}/invitation`}
            download
          >
            Download calendar file
          </a>
        </>
      )}
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

function EventList({
  events,
  act,
  busy,
}: {
  events: NetworkEvent[];
  act: Action;
  busy: boolean;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("20:00");
  const [area, setArea] = useState("");
  const [url, setUrl] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [problem, setProblem] = useState("");
  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem("");
    try {
      const window = manualMeetingSlot(date, start, end);
      if (
        await act({
          action: "event",
          event: {
            title,
            ...window,
            area,
            ...(url ? { url } : {}),
            visibility,
          },
        })
      ) {
        setTitle("");
        setUrl("");
      }
    } catch {
      setProblem(
        "Choose a valid SF date and an end time after the start time.",
      );
    }
  }
  return (
    <details className="network-settings">
      <summary>Events you plan to attend</summary>
      {events.map((event) => (
        <article className="network-card" key={event.id}>
          <h3>{event.title}</h3>
          <p>
            {timeLabel(event.start)} SF time
            {event.area ? ` · ${event.area}` : ""}
          </p>
          <p className="network-muted">
            {event.sourceMode === "demo" ? "Demo event" : "Reported by you"} ·{" "}
            {event.visibility === "private"
              ? "Only me"
              : event.visibility === "friends"
                ? "Connections"
                : "Discoverable people"}
          </p>
          {event.url && (
            <a href={event.url} target="_blank" rel="noopener noreferrer">
              Event page
            </a>
          )}
          <div className="network-actions">
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void act({ action: "remove_event", eventId: event.id })
              }
            >
              Remove event
            </button>
          </div>
        </article>
      ))}
      <form onSubmit={(event) => void add(event)}>
        <label>
          Event name
          <input
            required
            minLength={3}
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Date in SF
          <input
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <div className="network-field-pair">
          <label>
            Starts
            <input
              type="time"
              required
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            Ends
            <input
              type="time"
              required
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        <label>
          Neighborhood (optional)
          <input
            maxLength={80}
            value={area}
            onChange={(event) => setArea(event.target.value)}
          />
        </label>
        <label>
          Event link (optional)
          <input
            type="url"
            maxLength={2000}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label>
          Who can see this event?
          <select
            value={visibility}
            onChange={(event) =>
              setVisibility(event.target.value as Visibility)
            }
          >
            <option value="private">Only me</option>
            <option value="friends">Connections</option>
            <option value="network">Discoverable people</option>
          </select>
        </label>
        <p className="network-muted">
          Adding an event reports your plans. It does not register you for the
          event.
        </p>
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
        <button className="secondary-button" disabled={busy}>
          Add event
        </button>
      </form>
    </details>
  );
}
