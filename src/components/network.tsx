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
import type { AgentDialogue, DialogueAction } from "@/lib/domain/agent-dialogue";
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
  type SharedEvent,
} from "@/lib/domain/network";
import { manualMeetingSlot, type MeetingView } from "@/lib/domain/meetings";
import { MeetingCard, MeetingForm } from "./meeting-coordination";
import { AppHeader } from "./app-header";
import { QRScanner } from "./qr-scanner";
import {
  AgentConversations,
  conversationThreads,
  PersonAvatar,
} from "./agent-conversations";
import "@/app/network.css";

type NetworkState = {
  accountId: string;
  demo?: boolean;
  suggestedArea?: string | null;
  matching?: { pending: boolean; lastCheckedAt: string | null };
  settings: NetworkSettings;
  connections: ConnectionView[];
  messages: AgentMessage[];
  opportunities: Opportunity[];
  events: NetworkEvent[];
  meetings: MeetingView[];
  dialogues: AgentDialogue[];
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

const eventTimeLabel = (event: SharedEvent) => {
  const timing = event.start
    ? `${timeLabel(event.start)} SF time`
    : event.date ? `${dateLabel(event.date)} · Time not confirmed` : "Time not confirmed";
  return `${timing}${event.dateStatus === "unconfirmed_year" ? " · Year not confirmed" : ""}`;
};

export function Network({
  account,
  embedded = false,
  active = true,
}: {
  account: Account;
  embedded?: boolean;
  active?: boolean;
}) {
  const [state, setState] = useState<NetworkState | null>(null);
  const [tab, setTab] = useState<"opportunities" | "connections" | "agents">(
    embedded ? "agents" : "opportunities",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const activeRef = useRef(active);
  const refreshSequence = useRef(0);
  const retry = useRef<{ signature: string; requestId: string } | null>(null);
  const goTo = (view: typeof tab, person: string | null = null) => {
    setTab(embedded ? "agents" : view);
    setSelectedId(person);
    const url = new URL(window.location.href);
    if (embedded) url.searchParams.set("agents", "1");
    else url.searchParams.set("view", view);
    if (person) url.searchParams.set("person", person);
    else url.searchParams.delete("person");
    if (url.href !== window.location.href)
      window.history.pushState(null, "", url);
  };
  const openThread = (userId: string) => goTo("agents", userId);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!activeRef.current) return;
      const sequence = ++refreshSequence.current;
      try {
        const response = await fetch("/api/network", {
          cache: "no-store",
          signal,
          headers: { "X-Sidekick-Account": account.id },
        });
        if (!activeRef.current || sequence !== refreshSequence.current || signal?.aborted)
          return;
        if (response.status === 401) {
          window.location.replace(
            embedded ? "/login?next=%2Fonboarding" : "/login?next=%2Fnetwork",
          );
          return;
        }
        const result = await response.json();
        if (!activeRef.current || sequence !== refreshSequence.current || signal?.aborted)
          return;
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
      } catch (problem) {
        if (!activeRef.current || sequence !== refreshSequence.current || signal?.aborted)
          return;
        throw problem;
      }
    },
    [account.id, embedded],
  );

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => {
        const view = new URLSearchParams(window.location.search).get("view");
        if (!embedded && new URLSearchParams(window.location.search).get("sharing") === "1") setSharing(true);
        if (
          !embedded &&
          (view === "agents" || view === "connections" || view === "opportunities")
        )
          setTab(view);
        setSelectedId(
          new URLSearchParams(window.location.search).get("person"),
        );
        return refresh(controller.signal);
      })
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
    window.addEventListener("focus", update);
    window.addEventListener("sidekick-meeting-updated", update);
    const restoreView = () => {
      const parameters = new URLSearchParams(window.location.search),
        view = parameters.get("view");
      setTab(
        embedded
          ? "agents"
          : view === "agents" || view === "connections" ? view : "opportunities",
      );
      setSelectedId(parameters.get("person"));
    };
    window.addEventListener("popstate", restoreView);
    return () => {
      activeRef.current = false;
      refreshSequence.current += 1;
      controller.abort();
      window.removeEventListener("focus", update);
      window.removeEventListener("sidekick-meeting-updated", update);
      window.removeEventListener("popstate", restoreView);
    };
  }, [active, embedded, refresh]);

  const dialogueActive = state?.dialogues?.some((dialogue) =>
    dialogue.status === "queued" || dialogue.status === "running",
  ) ?? false;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && !inFlight.current)
        void refresh(controller.signal).catch(() => {});
    }, dialogueActive ? 3000 : 15000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [active, dialogueActive, refresh]);

  const act: Action = async (payload, endpoint = "/api/network") => {
    if (!activeRef.current || inFlight.current) return false;
    inFlight.current = true;
    // A delayed poll must not restore state from before this action.
    refreshSequence.current += 1;
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
        window.location.replace(
          embedded ? "/login?next=%2Fonboarding" : "/login?next=%2Fnetwork",
        );
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
      if (endpoint === "/api/meetings") window.dispatchEvent(new Event("sidekick-meeting-updated"));
      if (
        activeRef.current &&
        (payload.action === "query" ||
          payload.action === "propose" ||
          (payload.action === "connection" && payload.decision === "accept")) &&
        typeof payload.toUserId === "string"
      )
        openThread(payload.toUserId);
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

  const threads = state
    ? conversationThreads(
        account.id,
        state.connections,
        state.messages,
        state.meetings,
        state.dialogues,
      )
    : [];
  const pending = threads.reduce((sum, thread) => sum + thread.needsYou, 0);
  const incomingConnections =
    state?.connections.filter(
      (item) => item.status === "pending" && item.direction === "incoming",
    ).length ?? 0;
  const Container = embedded ? "div" : "main";

  return (
    <>
      {!embedded && (
        <>
          <a className="skip-link" href="#network">Skip to network</a>
          <AppHeader account={account} active="network" disabled={busy} />
        </>
      )}
      <Container
        className={`network-layout${embedded ? " network-panel" : ""}${tab === "agents" ? " conversation-layout" : ""}`}
        id={embedded ? undefined : "network"}
      >
        {embedded ? (
          <div className="network-panel-toolbar">
            <button
              className="toolbar-button"
              aria-expanded={sharing}
              onClick={() => setSharing(!sharing)}
            >
              Sharing
            </button>
            <a href={selectedId ? `/network?view=agents&person=${encodeURIComponent(selectedId)}` : "/network?view=agents"}>
              Open Network <span aria-hidden="true">↗</span>
            </a>
          </div>
        ) : <div className="network-page-heading">
          <div>
            <h1>
              {tab === "agents"
                ? "Agent conversations"
                : tab === "connections"
                  ? "Your people"
                  : "Worth a conversation"}
            </h1>
          </div>
          <div className="network-toolbar">
            {state?.demo && <span className="demo-label">Demo</span>}
            <button
              className="toolbar-button"
              aria-expanded={sharing}
              onClick={() => {
                setSharing(!sharing);
                setTools(false);
              }}
            >
              Sharing{" "}
              <span
                className={`discovery-dot${state?.settings.discoverable ? " enabled" : ""}`}
                aria-hidden="true"
              />
            </button>
            <button
              className="secondary-button"
              aria-expanded={tools}
              onClick={() => {
                setTools(!tools);
                setSharing(false);
              }}
            >
              Connect with QR
            </button>
          </div>
        </div>}
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
        {loading && <p className="loading-state">{embedded ? "Opening conversations…" : "Opening your network…"}</p>}
        {state && (
          <>
            {sharing && (
              <section
                className="network-utility-panel"
                aria-label="Discovery and sharing"
              >
                <div className="network-card-heading">
                  <h2>Discovery and sharing</h2>
                  <button
                    className="text-button"
                    onClick={() => setSharing(false)}
                  >
                    Close
                  </button>
                </div>
                <Settings
                  key={state.settings.revision}
                  settings={state.settings}
                  act={act}
                  busy={busy}
                />
              </section>
            )}
            {tools && (
              <section
                className="network-utility-panel network-tools"
                aria-label="QR connections"
              >
                <div className="network-card-heading">
                  <h2>Connect in person</h2>
                  <button
                    className="text-button"
                    onClick={() => setTools(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="qr-columns">
                  <MyQR token={state.settings.qrToken} act={act} busy={busy} />
                  <QRScanner />
                </div>
              </section>
            )}
            {!embedded && <nav className="network-tabs" aria-label="Network views">
              <button
                aria-current={tab === "opportunities" ? "page" : undefined}
                onClick={() => goTo("opportunities")}
              >
                For you
              </button>
              <button
                aria-current={tab === "agents" ? "page" : undefined}
                onClick={() => goTo("agents", selectedId)}
              >
                Agents{" "}
                {pending > 0 && <span className="nav-count">{pending}</span>}
              </button>
              <button
                aria-current={tab === "connections" ? "page" : undefined}
                onClick={() => goTo("connections")}
              >
                People{" "}
                {incomingConnections > 0 && (
                  <span className="nav-count">{incomingConnections}</span>
                )}
              </button>
            </nav>}
            {tab === "opportunities" && (
              <section aria-label="For you">
                {!state.settings.discoverable ? <p className="notice">Discovery is off. New people cannot be matched with you. <button className="text-button" onClick={() => setSharing(true)}>Review sharing</button></p>
                  : ["profile", "goal", "trip"].some((field) => state.settings.visibility[field as keyof typeof state.settings.visibility] !== "network") ? <p className="notice">Share your experience, goal, and SF dates with discoverable people to find new connections. <button className="text-button" onClick={() => setSharing(true)}>Review sharing</button></p>
                  : <p className="network-muted">{state.matching?.pending ? "Checking for compatible people. Discovery continues while you’re away." : "Discovery is active, including when the app is closed."}</p>}
                {pending > 0 && (
                  <button
                    className="agent-attention"
                    onClick={() =>
                      openThread(
                        threads.find((thread) => thread.needsYou)!.userId,
                      )
                    }
                  >
                    <span className="attention-mark" aria-hidden="true">
                      ↔
                    </span>
                    <span>
                      <strong>Your Sidekick needs you</strong>
                      <span>
                        {pending}{" "}
                        {pending === 1 ? "decision is" : "decisions are"}{" "}
                        waiting in your agent conversations.
                      </span>
                    </span>
                    <span aria-hidden="true">→</span>
                  </button>
                )}
                {!state.opportunities.length && (
                  <div className="network-blank">
                    <span className="blank-glyph" aria-hidden="true">
                      ↗
                    </span>
                    <h2>
                      {state.settings.discoverable
                        ? "Your next connection starts here"
                        : "Let the right people find you"}
                    </h2>
                    <p>
                      {state.settings.discoverable
                        ? "Sidekick will suggest people with shared goals and overlapping time in SF."
                        : "Choose what your Sidekick can share before it recommends you to the network."}
                    </p>
                    {!state.settings.discoverable && (
                      <button
                        className="primary-button"
                        onClick={() => setSharing(true)}
                      >
                        Review sharing preferences
                      </button>
                    )}
                  </div>
                )}
                <div className="opportunity-grid">
                  {state.opportunities.slice(0, 3).map((opportunity) => (
                    <OpportunityCard
                      key={opportunity.id}
                      opportunity={opportunity}
                      act={act}
                      busy={busy}
                      openThread={openThread}
                      connection={state.connections.find(
                        (item) => item.userId === opportunity.userId,
                      )}
                    />
                  ))}
                </div>
                {threads.some((thread) => thread.messages.length > 0 || thread.dialogue) && (
                  <section
                    className="recent-agent-section"
                    aria-label="Recent agent activity"
                  >
                    <div className="section-heading">
                      <h2>Behind the connection</h2>
                      <button
                        className="text-button"
                        onClick={() => goTo("agents")}
                      >
                        All conversations →
                      </button>
                    </div>
                    {threads
                      .filter((thread) => thread.messages.length > 0 || thread.dialogue)
                      .slice(0, 2)
                      .map((thread) => (
                        <button
                          className="recent-agent-row"
                          key={thread.userId}
                          onClick={() => openThread(thread.userId)}
                        >
                          <PersonAvatar name={thread.name} agent />
                          <span>
                            <strong>
                              Your Sidekick ↔ {thread.name.split(" ")[0]}’s
                              Sidekick
                            </strong>
                            <span>
                              {thread.needsYou
                                ? "Your input is needed"
                                : "View the shared context and next steps"}
                            </span>
                          </span>
                          <span aria-hidden="true">→</span>
                        </button>
                      ))}
                  </section>
                )}
                <EventList events={state.events} act={act} busy={busy} />
              </section>
            )}
            {tab === "connections" && (
              <section aria-label="People">
                {!state.connections.length && (
                  <div className="network-blank">
                    <span className="blank-glyph" aria-hidden="true">
                      +
                    </span>
                    <h2>Keep the conversation going</h2>
                    <p>Scan someone’s Sidekick QR to connect your agents.</p>
                    <button
                      className="primary-button"
                      onClick={() => setTools(true)}
                    >
                      Connect with QR
                    </button>
                  </div>
                )}
                <div className="people-grid">
                  {[...state.connections]
                    .sort(
                      (a, b) =>
                        Number(
                          b.status === "pending" && b.direction === "incoming",
                        ) -
                        Number(
                          a.status === "pending" && a.direction === "incoming",
                        ),
                    )
                    .map((connection) => (
                      <ConnectionCard
                        key={connection.userId}
                        connection={connection}
                        act={act}
                        busy={busy}
                        openThread={openThread}
                      />
                    ))}
                </div>
              </section>
            )}
            {tab === "agents" && (
              <div hidden={embedded && sharing}>
              <AgentConversations
                accountId={account.id}
                threads={threads}
                selectedId={selectedId}
                select={(id) => goTo("agents", id)}
                seePeople={() => goTo("connections")}
                peopleHref={embedded ? "/network?view=connections" : undefined}
                response={(value) => <InformationAnswers response={value} />}
                messageAction={(message) => (
                  <MessageCard
                    key={message.id}
                    message={message}
                    accountId={account.id}
                    act={act}
                    busy={busy}
                  />
                )}
                meetingAction={(meeting) => (
                  <MeetingCard
                    key={meeting.id}
                    meeting={meeting}
                    accountId={account.id}
                    act={act}
                    busy={busy}
                  />
                )}
                dialogueAction={(dialogue) => (
                  <DialogueCard
                    key={`${dialogue.id}:${dialogue.turns[0]?.id ?? ""}:${dialogue.waitingForUserId ?? ""}:${dialogue.question ?? ""}`}
                    dialogue={dialogue}
                    accountId={account.id}
                    act={act}
                    busy={busy}
                    reviewSharing={() => {
                      setSharing(true);
                      setTools(false);
                      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Discovery and sharing"] select')?.focus());
                    }}
                  />
                )}
                compose={(thread) => (
                  <div className="thread-compose">
                    <details>
                      <summary>
                        Ask about an opportunity{" "}
                        <span aria-hidden="true">+</span>
                      </summary>
                      <QueryForm
                        userId={thread.userId}
                        name={thread.name}
                        act={act}
                        busy={busy}
                      />
                    </details>
                    <details>
                      <summary>
                        Coordinate a meeting <span aria-hidden="true">+</span>
                      </summary>
                      <MeetingForm
                        suggestedArea={state.suggestedArea}
                        userId={thread.userId}
                        act={act}
                        busy={busy}
                      />
                    </details>
                  </div>
                )}
              />
              </div>
            )}
          </>
        )}
      </Container>
    </>
  );
}

function DialogueCard({
  dialogue,
  accountId,
  act,
  busy,
  reviewSharing,
}: {
  dialogue: AgentDialogue;
  accountId: string;
  act: Action;
  busy: boolean;
  reviewSharing: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const ownsQuestion = dialogue.status === "needs_user" && dialogue.waitingForUserId === accountId;
  const canPause = ["queued", "running", "needs_user"].includes(dialogue.status);
  const titles: Record<AgentDialogue["status"], string> = {
    awaiting_profile: dialogue.ownProfileReady ? "Waiting for their profile" : "Confirm your profile to begin",
    awaiting_sharing: dialogue.ownSharingReady ? "Waiting for their sharing preferences" : "Choose what your Sidekick can share",
    queued: "Conversation queued",
    running: "Your Sidekicks are talking",
    needs_user: ownsQuestion ? "Your Sidekick has a question" : `Waiting for ${dialogue.name.split(" ")[0]}`,
    completed: dialogue.suggestion ? "Suggested next step" : "Conversation complete",
    paused: "Conversation paused",
    error: "The conversation couldn’t continue",
    revoked: "Conversation access revoked",
  };
  const operate = (operation: DialogueAction["operation"], sharedAnswer?: string) =>
    act({ action: "dialogue", toUserId: dialogue.userId, revision: dialogue.revision, operation, ...(sharedAnswer ? { answer: sharedAnswer } : {}) });
  return (
    <section className={`dialogue-status${ownsQuestion ? " needs-answer" : ""}`} aria-label="Agent conversation status">
      <div className="dialogue-status-heading">
        <h3 aria-live="polite">{titles[dialogue.status]}</h3>
        {canPause && <button className="text-button" disabled={busy} onClick={() => void operate("pause")}>Pause conversation</button>}
      </div>
      {dialogue.status === "revoked" ? (
        <p>Previously shared conversation content is hidden.</p>
      ) : (
        <>
          {["awaiting_sharing", "completed", "paused", "error"].includes(dialogue.status) && dialogue.statusDetail && <p>{dialogue.statusDetail}</p>}
          {dialogue.status === "completed" && dialogue.suggestion && (
            <p className="dialogue-suggestion">{dialogue.suggestion}</p>
          )}
          {dialogue.status === "completed" && dialogue.suggestion && <p className="network-muted">A suggestion only. Meeting times still need approval from both people.</p>}
          {dialogue.status === "awaiting_profile" && !dialogue.ownProfileReady && <a className="primary-button" href="/onboarding">Review and confirm profile</a>}
          {dialogue.status === "awaiting_sharing" && !dialogue.ownSharingReady && <button className="primary-button" onClick={reviewSharing}>Review sharing preferences</button>}
          {ownsQuestion && dialogue.question && (
            <form onSubmit={(event) => {
              event.preventDefault();
              void operate("answer", answer.trim()).then((saved) => { if (saved) setAnswer(""); });
            }}>
              <label>
                {dialogue.question}
                <textarea value={answer} maxLength={2000} required onChange={(event) => setAnswer(event.target.value)} />
              </label>
              <p className="network-muted">Your answer will be shared with {dialogue.name} and their Sidekick in this conversation.</p>
              <div className="network-actions">
                <button className="primary-button" disabled={busy || !answer.trim()}>Share answer and continue</button>
                <button type="button" className="text-button" disabled={busy} onClick={() => void operate("decline")}>Decline to answer</button>
              </div>
            </form>
          )}
          {dialogue.status === "paused" && dialogue.pausedByUserId === accountId && <button className="primary-button" disabled={busy} onClick={() => void operate("resume")}>Resume conversation</button>}
          {dialogue.status === "error" && <button className="primary-button" disabled={busy} onClick={() => void operate("retry")}>Retry conversation</button>}
        </>
      )}
    </section>
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
      <AppHeader account={account} active="network" disabled={busy} />
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
  openThread,
}: {
  opportunity: Opportunity;
  act: Action;
  busy: boolean;
  connection?: ConnectionView;
  openThread: (userId: string) => void;
}) {
  return (
    <article className="network-card opportunity-card">
      <div className="network-card-heading">
        <div className="person-heading">
          <PersonAvatar name={opportunity.name} />
          <div>
            <h2>{opportunity.name}</h2>
            <span className="network-badge">
              In SF {dateLabel(opportunity.overlap.start)}–
              {dateLabel(opportunity.overlap.end)}
            </span>
          </div>
        </div>
      </div>
      <p className="opportunity-reason">
        {opportunity.goal?.text ?? opportunity.benefits.you}
      </p>
      <div className="signal-tags" aria-label="Shared interests">
        {opportunity.signals.slice(0, 3).map((signal) => (
          <span key={signal}>{signal}</span>
        ))}
      </div>
      {opportunity.sharedEvents.map((event) => (
        <p key={event.id}>
          Shared event: {event.title} · {eventTimeLabel(event)}
        </p>
      ))}
      {opportunity.eventSuggestions?.map((event) => (
        <p key={event.id}>
          {opportunity.name} {event.attendance === "registered" ? "reported registering for" : "plans to attend"} {event.title} ·{" "}
          {eventTimeLabel(event)}{event.area ? ` · ${event.area}` : ""}
          . Admission and availability have not been checked.
        </p>
      ))}
      <details>
        <summary>Why this was suggested</summary>
        <p>
          <strong>For you:</strong> {opportunity.benefits.you}
        </p>
        <p>
          <strong>For {opportunity.name}:</strong> {opportunity.benefits.them}
        </p>
        <p className="network-muted">
          Shared interests: {opportunity.signals.join(", ")}
        </p>
        <p className="network-muted">
          Heuristic score {opportunity.score}/100 ·{" "}
          {opportunity.source === "demo"
            ? "Demo data"
            : "Self-reported information"}
        </p>
        <p className="network-muted">
          Based on shared, self-reported profile and event information. Reviewed{" "}
          {dateLabel(opportunity.createdAt)}. Availability has not been checked.
        </p>
      </details>
      <div className="network-actions">
        {connection?.status === "accepted" ? (
          <button
            className="primary-button"
            onClick={() => openThread(opportunity.userId)}
          >
            Open agent conversation <span aria-hidden="true">↗</span>
          </button>
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
                context: "Sidekick suggested exploring a connection based on your shared profiles.",
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
  openThread,
}: {
  connection: ConnectionView;
  act: Action;
  busy: boolean;
  openThread: (userId: string) => void;
}) {
  const decide = (decision: ConnectionAction) =>
    void act({ action: "connection", toUserId: connection.userId, decision });
  return (
    <article className="network-card">
      <div className="network-card-heading">
        <div className="person-heading">
          <PersonAvatar name={connection.name} />
          <h2>{connection.name}</h2>
        </div>
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
      {connection.context && <p>{connection.source === "opportunity" ? "Sidekick suggested exploring a connection based on your shared profiles." : connection.context}</p>}
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
              Your agents can talk after you accept and both profiles are
              confirmed, using only the information you share.
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
        <button
          className="primary-button"
          onClick={() => openThread(connection.userId)}
        >
          Open agent conversation <span aria-hidden="true">↗</span>
        </button>
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
          Request sent. The exchange is recorded in this conversation.
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
          .map((event) => `${event.title} · ${eventTimeLabel(event)}`)
          .join("\n")
      : "No shared events";
  if ("bio" in value) return `${value.bio}\n${value.offers}`;
  if ("text" in value) return value.text;
  if ("start" in value)
    return `${dateLabel(value.start)}–${dateLabel(value.end)} in San Francisco`;
  return "Not provided";
}

function InformationAnswers({
  response,
}: {
  response: AgentMessage["response"];
}) {
  return (
    <dl className="exchange-facts">
      {NETWORK_FIELDS.filter((field) => response[field]).map((field) => (
        <div key={field}>
          <dt>{fieldLabels[field]}</dt>
          <dd>{informationText(response[field]!)}</dd>
        </div>
      ))}
    </dl>
  );
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
    <article className="network-card approval-card">
      <div className="network-card-heading">
        <h2>Your Sidekick needs your answer</h2>
        <span className="network-badge">{labels[message.status]}</span>
      </div>
      <p>{message.purpose}</p>
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
    <details className="network-settings" id="my-events" open={events.length > 0}>
      <summary>Your events</summary>
      {events.map((event) => (
        <article className="network-card" key={event.id}>
          <h3>{event.title}</h3>
          <p>
            {eventTimeLabel(event)}
            {event.area ? ` · ${event.area}` : ""}
          </p>
          <p className="network-muted">
            {event.attendance === "registered" ? "Registered · " : "Planning to attend · "}
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
