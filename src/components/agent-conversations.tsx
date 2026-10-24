"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { AgentMessage, ConnectionView } from "@/lib/domain/network";
import type { MeetingView, MeetingActivityEntry } from "@/lib/domain/meetings";

export type AgentThread = {
  userId: string;
  name: string;
  connection?: ConnectionView;
  messages: AgentMessage[];
  meetings: MeetingView[];
  updatedAt: string;
  needsYou: number;
};

export function conversationThreads(
  accountId: string,
  connections: ConnectionView[],
  messages: AgentMessage[],
  meetings: MeetingView[],
): AgentThread[] {
  const threads = new Map<string, AgentThread>();
  const ensure = (userId: string, name: string) => {
    let thread = threads.get(userId);
    if (!thread) {
      thread = {
        userId,
        name,
        messages: [],
        meetings: [],
        updatedAt: "",
        needsYou: 0,
      };
      threads.set(userId, thread);
    }
    return thread;
  };
  const touch = (thread: AgentThread, at: string) => {
    if (at > thread.updatedAt) thread.updatedAt = at;
  };
  for (const connection of connections) {
    if (connection.status !== "accepted" && connection.status !== "blocked")
      continue;
    const thread = ensure(connection.userId, connection.name);
    thread.connection = connection;
    touch(thread, connection.createdAt);
  }
  for (const message of messages) {
    const incoming = message.toUserId === accountId;
    const thread = ensure(
      incoming ? message.fromUserId : message.toUserId,
      incoming ? message.senderName : message.recipientName,
    );
    thread.messages.push(message);
    if (incoming && message.status === "needs_user") thread.needsYou += 1;
    touch(thread, message.activity?.at(-1)?.at ?? message.createdAt);
  }
  for (const meeting of meetings) {
    const other = meeting.participants.find(
      (person) => person.userId !== accountId,
    );
    if (!other) continue;
    const thread = ensure(other.userId, other.name);
    thread.meetings.push(meeting);
    if (
      (meeting.status === "awaiting_permission" &&
        !meeting.consentedUserIds.includes(accountId)) ||
      (meeting.status === "options_ready" &&
        !meeting.approvedUserIds.includes(accountId))
    )
      thread.needsYou += 1;
    touch(thread, meeting.activity?.at(-1)?.at ?? meeting.createdAt);
  }
  return [...threads.values()].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name),
  );
}

export function PersonAvatar({
  name,
  agent = false,
}: {
  name: string;
  agent?: boolean;
}) {
  return (
    <span
      className={`person-avatar${agent ? " agent-avatar" : ""}`}
      aria-hidden="true"
    >
      {name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("") || "S"}
    </span>
  );
}

function stamp(at: string, compact = false) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(!compact ? ({ hour: "numeric", minute: "2-digit" } as const) : {}),
    timeZone: "America/Los_Angeles",
  }).format(new Date(at));
}

function preview(thread: AgentThread, accountId: string) {
  if (thread.needsYou)
    return thread.needsYou === 1
      ? "Your approval is needed"
      : `${thread.needsYou} actions need you`;
  if (
    thread.connection?.status === "blocked" ||
    (thread.messages.some((item) => item.status === "revoked") &&
      thread.connection?.status !== "accepted")
  )
    return "Connection access revoked";
  const message = [...thread.messages].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  if (message?.status === "needs_user" && message.fromUserId === accountId)
    return `Waiting for ${thread.name.split(" ")[0]}`;
  if (thread.meetings.some((item) => item.status === "confirmed"))
    return "Meeting agreed";
  if (message?.status === "completed")
    return "Shared context is ready to review";
  return message?.purpose ?? "Connected · ready to collaborate";
}

const meetingLabels: Record<MeetingActivityEntry["kind"], string> = {
  proposed: "Proposed a meeting",
  availability_consented: "Allowed an availability check",
  options_ready: "Found common meeting times",
  no_common_time: "No common time found in the search window",
  option_approved: "Approved a time and place",
  option_counterproposed:
    "Proposed a different time; previous approvals cleared",
  confirmed: "Both people approved the meeting",
  withdrawn: "Withdrew the meeting",
  stale: "Proposal needs review after a change",
  expired: "Meeting proposal expired",
  availability_failed: "Could not verify availability",
};

export function AgentConversations({
  accountId,
  threads,
  selectedId,
  select,
  seePeople,
  response,
  messageAction,
  meetingAction,
  compose,
}: {
  accountId: string;
  threads: AgentThread[];
  selectedId: string | null;
  select: (userId: string | null) => void;
  seePeople: () => void;
  response: (value: AgentMessage["response"]) => ReactNode;
  messageAction: (message: AgentMessage) => ReactNode;
  meetingAction: (meeting: MeetingView) => ReactNode;
  compose: (thread: AgentThread) => ReactNode;
}) {
  const selected = threads.find((thread) => thread.userId === selectedId);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (selectedId) heading.current?.focus({ preventScroll: true });
  }, [selectedId]);
  if (!threads.length)
    return (
      <div className="network-blank">
        <span className="blank-glyph" aria-hidden="true">
          ↔
        </span>
        <h2>No agent conversations yet</h2>
        <p>
          Connect with someone to let your Sidekicks explore an opportunity
          together.
        </p>
        <button className="primary-button" onClick={seePeople}>
          Find your people
        </button>
      </div>
    );
  return (
    <div className={`agent-workspace${selected ? " has-selection" : ""}`}>
      <aside className="agent-thread-list" aria-label="Agent conversations">
        <div className="thread-list-heading">
          <h2>Conversations</h2>
          <span>{threads.length}</span>
        </div>
        {threads.map((thread) => (
          <button
            key={thread.userId}
            className="agent-thread-row"
            aria-current={
              selected?.userId === thread.userId ? "true" : undefined
            }
            aria-label={`Open agent conversation with ${thread.name}`}
            onClick={() => select(thread.userId)}
          >
            <PersonAvatar name={thread.name} />
            <span className="thread-row-copy">
              <strong>{thread.name}</strong>
              <span>{preview(thread, accountId)}</span>
            </span>
            <span className="thread-row-meta">
              {thread.updatedAt && (
                <time dateTime={thread.updatedAt}>
                  {stamp(thread.updatedAt, true)}
                </time>
              )}
              {thread.needsYou > 0 && (
                <span
                  className="action-count"
                  aria-label={`${thread.needsYou} actions need you`}
                >
                  {thread.needsYou}
                </span>
              )}
            </span>
          </button>
        ))}
      </aside>
      <section
        className="agent-thread-panel"
        aria-label={
          selected
            ? `Conversation with ${selected.name}`
            : "Conversation details"
        }
      >
        {selected ? (
          <>
            <header className="agent-thread-header">
              <button
                className="thread-back text-button"
                onClick={() => select(null)}
              >
                ← All conversations
              </button>
              <div className="thread-identity">
                <PersonAvatar name={selected.name} agent />
                <div>
                  <h2 ref={heading} tabIndex={-1}>
                    Your Sidekick <span aria-hidden="true">↔</span>{" "}
                    {selected.name.split(" ")[0]}’s Sidekick
                  </h2>
                  <p>
                    {selected.connection?.status === "accepted"
                      ? `With ${selected.name} · San Francisco time`
                      : "Past exchanges · connection access is closed"}
                  </p>
                </div>
              </div>
            </header>
            <div className="agent-thread-body" key={selected.userId}>
              <ThreadHistory
                thread={selected}
                accountId={accountId}
                response={response}
              />
              {selected.messages
                .filter(
                  (message) =>
                    message.toUserId === accountId &&
                    message.status === "needs_user",
                )
                .map(messageAction)}
              {selected.meetings
                .filter((meeting) =>
                  [
                    "awaiting_permission",
                    "options_ready",
                    "confirmed",
                  ].includes(meeting.status),
                )
                .map(meetingAction)}
              {selected.connection?.status === "accepted" && compose(selected)}
            </div>
          </>
        ) : (
          <div className="network-blank thread-placeholder">
            <span className="blank-glyph" aria-hidden="true">
              ↔
            </span>
            <h2>Your agents, in conversation</h2>
            <p>Choose a person to see the exchange and its next step.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ThreadHistory({
  thread,
  accountId,
  response,
}: {
  thread: AgentThread;
  accountId: string;
  response: (value: AgentMessage["response"]) => ReactNode;
}) {
  const entries: { id: string; at: string; item: ReactNode }[] = [];
  const agentName = (id?: string) =>
    id === accountId
      ? "Your Sidekick"
      : id === thread.userId
        ? `${thread.name.split(" ")[0]}’s Sidekick`
        : "Sidekick";
  for (const message of thread.messages) {
    for (const entry of message.activity ?? []) {
      const own = entry.actorUserId === accountId;
      const sender = agentName(message.fromUserId),
        recipient = agentName(message.toUserId);
      const labels = {
        request: "Asked about an opportunity",
        response: "Shared a reply",
        permission_needed: "Needs an answer",
        user_answer: "Shared an approved answer",
        declined: "Declined to share more",
      };
      entries.push({
        id: entry.id,
        at: entry.at,
        item: (
          <div className={`agent-exchange ${own ? "from-own" : "from-peer"}`}>
            <div className="exchange-meta">
              <strong>{agentName(entry.actorUserId)}</strong>
              <time dateTime={entry.at} title={`${stamp(entry.at)} SF time`}>
                {stamp(entry.at)}
              </time>
            </div>
            <div className="exchange-bubble">
              <span className="exchange-kind">{labels[entry.kind]}</span>
              {entry.kind === "request" && (
                <>
                  <span className="exchange-direction">
                    {sender} → {recipient}
                  </span>
                  <p>{message.purpose}</p>
                  {message.trigger === "discovery" && (
                    <span className="activity-origin">
                      Started by a matching opportunity
                    </span>
                  )}
                </>
              )}
              {entry.response && response(entry.response)}
              {entry.kind === "permission_needed" && (
                <p>
                  {message.status !== "needs_user"
                    ? "Some requested context needed permission or additional information."
                    : message.toUserId === accountId
                      ? "Your Sidekick needs your input before sharing more."
                      : `Waiting for ${thread.name.split(" ")[0]} to decide what to share.`}
                </p>
              )}
              {entry.kind === "declined" && (
                <p>No additional information was shared.</p>
              )}
            </div>
          </div>
        ),
      });
    }
    if (
      !(message.activity ?? []).some((entry) =>
        ["response", "user_answer"].includes(entry.kind),
      ) &&
      Object.values(message.response).some(
        (field) => field?.status === "shared",
      )
    ) {
      entries.push({
        id: `${message.id}-saved-response`,
        at: message.createdAt,
        item: (
          <div className="saved-exchange">
            <strong>Saved response · {agentName(message.toUserId)}</strong>
            <p className="network-muted">
              Response time wasn’t recorded for this earlier exchange.
            </p>
            {response(message.response)}
          </div>
        ),
      });
    }
    if (["revoked", "expired"].includes(message.status))
      entries.push({
        id: `${message.id}-closed`,
        at: message.activity?.at(-1)?.at ?? message.createdAt,
        item: (
          <p className="exchange-closed">
            {message.status === "revoked"
              ? "Access revoked. Previously shared information is hidden."
              : "Request expired. Shared information is no longer available."}
          </p>
        ),
      });
  }
  for (const meeting of thread.meetings) {
    for (const entry of meeting.activity ?? [])
      entries.push({
        id: entry.id,
        at: entry.at,
        item: (
          <div className="meeting-activity">
            <span className="timeline-dot" aria-hidden="true" />
            <div>
              <p>
                <strong>
                  {entry.actorUserId
                    ? entry.actorUserId === accountId
                      ? "You"
                      : thread.name.split(" ")[0]
                    : "Sidekick"}
                </strong>{" "}
                · {meetingLabels[entry.kind]}
              </p>
              <time dateTime={entry.at}>{stamp(entry.at)} SF time</time>
              {entry.kind === "proposed" && <p>{meeting.purpose}</p>}
            </div>
          </div>
        ),
      });
  }
  if (!entries.length)
    return (
      <div className="thread-welcome">
        <PersonAvatar name="Sidekick" agent />
        <h3>Your Sidekicks are connected</h3>
        <p>
          Ask about an opportunity or coordinate a meeting with{" "}
          {thread.name.split(" ")[0]}.
        </p>
      </div>
    );
  return (
    <ol className="agent-timeline" aria-label="Agent exchange history">
      {entries
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((entry) => (
          <li key={entry.id}>{entry.item}</li>
        ))}
    </ol>
  );
}
