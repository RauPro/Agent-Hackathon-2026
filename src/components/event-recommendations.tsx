"use client";

import { useEffect, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { SF_TIMEZONE } from "@/lib/domain/context";
import { canonicalEventUrl, canonicalEventDate, type NetworkEvent } from "@/lib/domain/discovery";
import type { Visibility } from "@/lib/domain/network";
import {
  PLATFORM_NAMES,
  type DiscoveryView,
  type Recommendation,
} from "@/lib/domain/event-discovery";

const dateLabel = (date: string, weekday = false) =>
  new Intl.DateTimeFormat("en-US", {
    ...(weekday ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    timeZone: SF_TIMEZONE,
  }).format(new Date(`${date}T12:00:00Z`));
const checkedLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: SF_TIMEZONE,
  }).format(new Date(date));
function eventTime(event: Recommendation) {
  if (!event.startTime) return dateLabel(event.date, true);
  const time = (value: string) =>
    checkedLabel(
      Temporal.ZonedDateTime.from(`${event.date}T${value}[${SF_TIMEZONE}]`)
        .toInstant()
        .toString(),
    );
  return `${dateLabel(event.date, true)} · ${time(event.startTime)}${event.endTime ? `–${time(event.endTime)}` : ""}${event.timeZoneStated ? " PT" : ""}`;
}
type AttendanceView = { events: NetworkEvent[]; eventVisibility: Visibility };
const visibilityLabel = (visibility: Visibility) =>
  visibility === "private" ? "Only me" : visibility === "friends" ? "Connections" : "Discoverable people";
const limitedAudience = (event: Visibility, overall: Visibility) =>
  event !== "private" && (overall === "private" || (event === "network" && overall === "friends"));

export function EventRecommendations({ accountId, revision, draftChanged }: {
  accountId: string;
  revision: number;
  draftChanged: boolean;
}) {
  const [view, setView] = useState<DiscoveryView | null>(null);
  const [attendance, setAttendance] = useState<AttendanceView | null>(null);
  const [notice, setNotice] = useState("");
  const [attendanceNotice, setAttendanceNotice] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const command = useRef<{ action: "start" | "refresh"; requestId: string } | null>(null);
  const initialId = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    async function request(method: "GET" | "POST", body?: unknown) {
      const response = await fetch("/api/discovery", {
        method,
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "X-Sidekick-Account": accountId,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) window.location.replace("/login");
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Couldn't check event sources. Try again.");
      return data as DiscoveryView;
    }
    async function load() {
      if (inFlight || controller.signal.aborted) return;
      if (document.hidden) {
        timer = setTimeout(() => void load(), 45_000);
        return;
      }
      const currentEpoch = epoch.current;
      inFlight = true;
      clearTimeout(timer);
      let delay = 45_000;
      try {
        let next = await request("GET");
        if (controller.signal.aborted || currentEpoch !== epoch.current) return;
        setView(next);
        if (next.configured && !next.tripPast && !next.dailyLimitReached &&
            !draftChanged && !next.draftChanged &&
            next.profileRevision === revision && (command.current || !next.discovery)) {
          setBusy(true);
          initialId.current ??= crypto.randomUUID();
          const action = command.current ?? { action: "start", requestId: initialId.current };
          next = await request("POST", { ...action, revision });
          command.current = null;
        }
        if (!controller.signal.aborted && currentEpoch === epoch.current) {
          setView(next);
          setNotice("");
          if (next.configured && !next.tripPast && next.discovery?.status === "running") delay = 2000;
        }
      } catch (error) {
        if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Couldn't check event sources. Try again.");
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          setBusy(false);
          timer = setTimeout(() => void load(), delay);
        }
      }
    }
    const refresh = () => { if (!document.hidden) void load(); };
    void load();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [accountId, revision, draftChanged, reload]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/events/attendance", {
          cache: "no-store", signal: controller.signal,
          headers: { "X-Sidekick-Account": accountId },
        });
        if (response.status === 401) window.location.replace("/login");
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Couldn't load your registrations.");
        if (!controller.signal.aborted) {
          setAttendance(result);
          setAttendanceNotice("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setAttendanceNotice(error instanceof Error ? error.message : "Couldn't load your registrations.");
      }
    }
    const refresh = () => { if (!document.hidden) void load(); };
    void load();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [accountId, reload]);

  const discovery = view?.discovery;
  const running = busy || (!!view?.configured && !view.tripPast && discovery?.status === "running");
  const stale = draftChanged || !!view?.draftChanged || view?.profileRevision !== revision;
  const suggestion = view?.suggestion;
  const highlighted = discovery?.recommendations.find((event) => event.id === suggestion?.eventId);
  const remaining = discovery?.recommendations.filter((event) => event.id !== highlighted?.id) ?? [];
  const retry = () => {
    command.current ??= { action: "refresh", requestId: crypto.randomUUID() };
    setReload((n) => n + 1);
  };
  async function mutate(endpoint: string, input: unknown) {
    epoch.current += 1;
    setMutating(true);
    setNotice("");
    setFeedback("");
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Sidekick-Account": accountId },
        body: JSON.stringify(input),
      });
      const result = await response.json();
      if (response.status === 401) window.location.replace("/login");
      if (!response.ok) throw new Error(result.message || "Couldn't save that change. Try again.");
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't save that change. Try again.");
      return null;
    } finally { setMutating(false); }
  }
  async function dismiss() {
    if (!suggestion) return;
    const result = await mutate("/api/discovery", { action: "dismiss", suggestionId: suggestion.id, revision });
    if (result) { setView(result); setFeedback("Suggestion dismissed."); }
  }
  async function register(event: Recommendation, visibility: Visibility) {
    const result = await mutate("/api/events/attendance", { action: "register", recommendationId: event.id, discoveryCheckedAt: discovery?.checkedAt, revision, visibility });
    if (!result) return false;
    setAttendance((current) => ({ eventVisibility: result.eventVisibility, events: [...(current?.events.filter((item) => item.id !== result.event.id) ?? []), result.event] }));
    setFeedback("Registration saved.");
    return true;
  }
  function card(event: Recommendation, featured = false) {
    const eventUrls = [event.url, ...event.alsoListed.map((source) => source.url)].map(canonicalEventUrl);
    const saved = attendance?.events.find((item) => item.attendance === "registered" && item.url &&
      [item.url, ...(item.aliasUrls ?? [])].some((url) => eventUrls.includes(canonicalEventUrl(url))) && (item.date ?? canonicalEventDate(item)) === event.date &&
      (item.dateStatus ?? "confirmed") === event.dateStatus);
    return <EventCard key={`${canonicalEventUrl(event.url)}|${event.date}|${event.dateStatus}`} event={event} message={featured ? suggestion?.message : undefined}
      saved={saved} eventVisibility={attendance?.eventVisibility ?? "private"}
      disabled={stale || mutating || !attendance} onRegister={register}
      onDismiss={featured ? dismiss : undefined} dismissDisabled={mutating || stale} />;
  }
  return (
    <section className="event-section" aria-labelledby="events-title" aria-busy={running || (!view && !notice)}>
      <h2 id="events-title">Events for your goal</h2>
      {stale && view && <p className="event-caveat">Based on your saved profile. Confirm your changes to update these.</p>}
      {view?.outdated && <p className="event-caveat">These results were checked more than 24 hours ago.</p>}
      {!view ? (!notice && <p role="status">Checking event recommendations…</p>)
        : !view.configured ? <p>Event discovery setup is pending.</p>
        : view.tripPast ? <p>Your saved trip has ended. Confirm new dates to find events.</p>
        : running ? <p role="status">{discovery?.recommendations.length ? "Checking for anything new…" : "Finding events"}{!discovery?.recommendations.length && view.window ? ` for ${dateLabel(view.window.start)}–${dateLabel(view.window.end)}…` : ""}</p>
        : view.dailyLimitReached ? <p role="status">Event discovery is paused for today.</p>
        : discovery?.status === "failed" ? <p role="status">Couldn&apos;t check event sources.</p>
        : discovery?.status === "empty" ? <p role="status">No events matched your goal and dates in the sources we checked.</p>
        : discovery?.status === "partial" ? <p role="status">Some sources couldn&apos;t be checked.</p> : null}
      {discovery?.status === "failed" && !!discovery.recommendations.length && <p className="event-detail">Showing your last successful results.</p>}
      {highlighted && card(highlighted, true)}
      {!!remaining.length && <details className="event-browse"><summary>Browse events <span className="event-detail">({remaining.length})</span></summary><div className="event-list">{remaining.map((event) => card(event))}</div></details>}
      {discovery && discovery.coverage.sources.length > 0 && <details className="event-evidence event-coverage"><summary>Search details</summary><p className="event-detail">{discovery.coverage.sources.map((s) => `${s.platform === "web" ? "Web" : PLATFORM_NAMES[s.platform]}: ${s.status === "failed" ? "not checked" : `${s.results} results, ${s.verified} verified`}`).join(" · ")}. {discovery.coverage.verified} candidates passed checks. Coverage is limited to these sources.</p></details>}
      {feedback && <p role="status" className="event-detail">{feedback}</p>}
      {notice && <p role="alert">{notice}</p>}
      {attendanceNotice && <p role="alert">{attendanceNotice} <button className="text-button" onClick={() => setReload((n) => n + 1)}>Reload registrations</button></p>}
      {!running && !stale && view?.configured && !view.tripPast && !view.dailyLimitReached && (discovery?.canRefresh || !discovery) && <button className="text-button" onClick={retry}>{notice || discovery?.status === "failed" || discovery?.status === "partial" ? "Try again" : "Check again"}</button>}
      {!view && notice && <button className="text-button" onClick={() => setReload((n) => n + 1)}>Try again</button>}
      {discovery && !discovery.canRefresh && !running && !view?.tripPast && !view?.dailyLimitReached && <p className="event-detail">Refresh limit reached. Try again in 24 hours.</p>}
    </section>
  );
}

function EventCard({ event, message, saved, eventVisibility, disabled, onRegister, onDismiss, dismissDisabled }: {
  event: Recommendation; message?: string; saved?: NetworkEvent; eventVisibility: Visibility;
  disabled: boolean; onRegister: (event: Recommendation, visibility: Visibility) => Promise<boolean>;
  onDismiss?: () => Promise<void>; dismissDisabled: boolean;
}) {
  const [registering, setRegistering] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const audience = registering ? visibility : saved?.visibility ?? visibility;
  return (
    <article className="event-card">
      {message && <p className="event-suggestion">{message}</p>}
      <h3>{event.title}</h3>
      <p className="event-date">{eventTime(event)}</p>
      <p>{[event.location.venue, "San Francisco", event.price.label].filter(Boolean).join(" · ")}</p>
      {!message && <p>{event.reason}</p>}
      {!!event.caveats.length && <p className="event-caveat">{event.caveats.join(" ")}</p>}
      <div className="event-actions">
        <a className="secondary-button event-open" href={event.url} target="_blank" rel="noopener noreferrer">Open on {PLATFORM_NAMES[event.platform]}<span className="sr-only"> (opens in a new tab)</span></a>
        {!saved && !registering && <button className="text-button" disabled={disabled} onClick={() => setRegistering(true)}>I registered</button>}
        {saved && !registering && <button className="text-button" disabled={disabled} onClick={() => { setVisibility(saved.visibility); setRegistering(true); }}>Edit sharing</button>}
        {onDismiss && <button className="text-button" disabled={dismissDisabled} onClick={() => void onDismiss()}>Dismiss</button>}
      </div>
      {saved && !registering ? <div className="event-registration"><p><strong>Registration saved</strong> · {visibilityLabel(saved.visibility)}</p><p className="event-detail">Reported by you; admission isn&apos;t verified. <a href="/network?view=opportunities#my-events">Your events</a></p></div>
        : registering && <form className="event-registration" onSubmit={async (submit) => { submit.preventDefault(); if (await onRegister(event, visibility)) setRegistering(false); }}>
          <label>Who can see this registration?<select value={visibility} disabled={disabled} onChange={(e) => setVisibility(e.target.value as Visibility)}><option value="private">Only me</option><option value="friends">Connections</option><option value="network">Discoverable people</option></select></label>
          <p className="event-detail">Save your registration here so Sidekick can use it. This won&apos;t submit a registration or verify admission.</p>
          <div className="event-actions"><button className="primary-button" disabled={disabled}>{saved ? "Save sharing" : "Save registration"}</button><button className="text-button" type="button" onClick={() => setRegistering(false)}>Cancel</button></div>
        </form>}
      {(saved || registering) && limitedAudience(audience, eventVisibility) && <p className="event-caveat">Your event sharing is set to {visibilityLabel(eventVisibility)}. {eventVisibility === "private" ? "Other Sidekicks can’t use this registration until you update it." : "People outside your connections can’t use this registration."} <a href="/network?sharing=1">Review sharing</a></p>}
      <details className="event-evidence"><summary>Source details</summary>
        <p className="event-detail">{PLATFORM_NAMES[event.platform]} · checked {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: SF_TIMEZONE }).format(new Date(event.checkedAt))} PT. Goal fit is a suggestion based on the description.</p>
        {!!event.alsoListed.length && <p className="event-detail">Also listed on {event.alsoListed.map((source, i) => <span key={source.url}>{i > 0 && ", "}<a href={source.url} target="_blank" rel="noopener noreferrer">{PLATFORM_NAMES[source.platform]}<span className="sr-only"> (opens in a new tab)</span></a></span>)}</p>}
        {event.evidence.map((item, i) => <blockquote key={`${item.field}-${i}`}><p>“{item.quote}”</p><a href={item.url} target="_blank" rel="noopener noreferrer">{item.field}<span className="sr-only"> source (opens in a new tab)</span></a></blockquote>)}
      </details>
    </article>
  );
}
