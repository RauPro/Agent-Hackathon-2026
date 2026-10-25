"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingSlot, MeetingView } from "@/lib/domain/meetings";
import { Mark } from "./brand";

const timeLabel = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(value));
export function useMeetingChat(accountId: string, enabled: boolean) {
  const [meetings, setMeetings] = useState<MeetingView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState<{ meetingId: string; revision: number; text: string; question: string | null; windows: MeetingSlot[] } | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const history = useRef<Record<string, { revision: number; turns: { role: "user" | "assistant"; content: string }[] }>>({});
  const historyKey = (id: string) => `meeting-chat-${accountId}-${id}`;
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    const response = await fetch("/api/meetings/chat", { cache: "no-store", headers: { "X-Sidekick-Account": accountId } });
    const result = await response.json();
    if (version !== generation.current) return;
    if (response.status === 401 || result.accountId && result.accountId !== accountId) { window.location.replace("/login"); return; }
    if (!response.ok) throw new Error(result.message || "Could not load meeting questions.");
    setMeetings(result.meetings);
  }, [accountId]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const update = () => {
      if (disposed || inFlight.current || document.visibilityState !== "visible") return;
      void refresh().catch(() => { if (!disposed) setError("Could not refresh meeting questions. Try again."); });
    };
    const select = () => setSelectedId(new URL(window.location.href).searchParams.get("meeting"));
    select(); update();
    const interval = setInterval(update, 15000);
    window.addEventListener("focus", update);
    window.addEventListener("sidekick-meeting-updated", update);
    window.addEventListener("popstate", select);
    const invalidate = () => { generation.current++; };
    return () => { disposed = true; invalidate(); clearInterval(interval); window.removeEventListener("focus", update); window.removeEventListener("sidekick-meeting-updated", update); window.removeEventListener("popstate", select); };
  }, [enabled, refresh]);
  const selected = meetings.find((item) => item.id === selectedId && ["awaiting_permission", "needs_user_input", "options_ready"].includes(item.status)) ?? null;
  async function action(meeting: MeetingView, payload: Record<string, unknown>) {
    if (inFlight.current) return false;
    inFlight.current = true; generation.current++; setBusy(true); setError("");
    try {
      const response = await fetch("/api/meetings", { method: "POST", headers: { "Content-Type": "application/json", "X-Sidekick-Account": accountId }, body: JSON.stringify({ ...payload, meetingId: meeting.id, revision: meeting.revision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not update this meeting.");
      delete history.current[meeting.id];
      try { sessionStorage.removeItem(historyKey(meeting.id)); } catch {}
      setAnswer(null); setSelectedId(null);
      await refresh();
      window.dispatchEvent(new Event("sidekick-meeting-updated"));
      return true;
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not update the meeting."); void refresh().catch(() => {}); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function send(message: string) {
    if (!selected || inFlight.current) return false;
    inFlight.current = true; generation.current++; setBusy(true); setError("");
    try {
      let previous = history.current[selected.id];
      if (!previous) {
        try { previous = JSON.parse(sessionStorage.getItem(historyKey(selected.id)) || "null"); } catch {}
      }
      const turns = previous?.revision === selected.revision && Array.isArray(previous.turns) ? previous.turns.slice(-8) : [];
      const response = await fetch("/api/meetings/chat", { method: "POST", headers: { "Content-Type": "application/json", "X-Sidekick-Account": accountId }, body: JSON.stringify({ meetingId: selected.id, revision: selected.revision, message, history: turns }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not interpret that time.");
      const next = { revision: selected.revision, turns: [...turns, { role: "user" as const, content: message }, ...(result.question ? [{ role: "assistant" as const, content: result.question }] : [])].slice(-8) };
      history.current[selected.id] = next;
      try { sessionStorage.setItem(historyKey(selected.id), JSON.stringify(next)); } catch {}
      setAnswer({ ...result, text: message });
      return true;
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not read that time."); void refresh().catch(() => {}); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  return { meetings, selected, select: setSelectedId, answer, busy, error, refresh, send, action };
}

export function MeetingChat({ state, accountId, onReply }: { state: ReturnType<typeof useMeetingChat>; accountId: string; onReply: (meeting: MeetingView) => void }) {
  const visible = state.meetings.filter((item) => item.nextAction || item.id === state.selected?.id || item.status === "options_ready");
  return <>
    {visible.map((meeting) => {
      const other = meeting.participants.find((person) => person.userId !== accountId);
      const answer = state.answer?.meetingId === meeting.id ? state.answer : null;
      return <article className="message assistant meeting-chat-question" key={meeting.id} aria-label={`Meeting with ${other?.name || "your connection"}`}>
        <div className="assistant-avatar"><Mark small /></div>
        <div className="message-content">
          <span className="message-author">Sidekick · Meeting with {other?.name}</span>
          <p>{meeting.nextAction?.prompt || `Our agents found ${meeting.options.length} possible times. You and ${other?.name || "your connection"} can review them before anything is scheduled.`}</p>
          {meeting.sharedEvent && <p className="meeting-context">Around {meeting.sharedEvent.title}</p>}
          {meeting.nextAction?.kind === "authorize_availability" ? <button className="secondary-button" disabled={state.busy} onClick={() => void state.action(meeting, { action: "opt_in" })}>Let my agent check my calendar</button>
            : meeting.nextAction?.kind === "reconnect_calendar" ? <a className="secondary-button" href="#calendar-title">Reconnect Google Calendar</a>
            : meeting.nextAction ? <button className="secondary-button" disabled={state.busy} onClick={() => onReply(meeting)}>Suggest a time</button> : null}
          <a className="text-button" href={`/onboarding?agents=1&person=${other?.userId}`}>Review agent coordination</a>
          {answer && <div className="meeting-time-preview">
            <p><strong>You:</strong> {answer.text}</p>
            {answer.question ? <p>{answer.question}</p> : <>
              <p>I’ll ask the agents to check:</p>
              <ul>{answer.windows.map((slot) => <li key={slot.start}>{timeLabel(slot.start)}–{timeLabel(slot.end)} SF time</li>)}</ul>
              <button className="primary-button" disabled={state.busy || answer.revision !== meeting.revision} onClick={() => void state.action(meeting, { action: "suggest_times", preferredWindows: answer.windows })}>Check these times</button>
              {answer.revision !== meeting.revision && <p>This proposal changed. Suggest your time again.</p>}
            </>}
          </div>}
        </div>
      </article>;
    })}
    {state.error && <div className="notice" role="alert"><p>{state.error}</p><button className="text-button" onClick={() => void state.refresh().catch(() => {})}>Reload meeting questions</button></div>}
  </>;
}
