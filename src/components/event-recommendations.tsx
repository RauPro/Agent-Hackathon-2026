"use client";

import { useEffect, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { SF_TIMEZONE } from "@/lib/domain/context";
import {
  PLATFORM_NAMES,
  type DiscoveryView,
  type Recommendation,
} from "@/lib/domain/discovery";

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
export function EventRecommendations({
  accountId,
  revision,
  draftChanged,
}: {
  accountId: string;
  revision: number;
  draftChanged: boolean;
}) {
  const [view, setView] = useState<DiscoveryView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const command = useRef<{
    action: "start" | "refresh";
    requestId: string;
  } | null>(null);
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
      if (!response.ok)
        throw new Error(
          data.message || "Couldn't check event sources. Try again.",
        );
      return data as DiscoveryView;
    }
    async function load() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        let next = await request("GET");
        if (controller.signal.aborted) return;
        setView(next);
        if (
          next.configured &&
          !next.tripPast &&
          !next.dailyLimitReached &&
          next.profileRevision === revision &&
          (command.current || !next.discovery)
        ) {
          setBusy(true);
          initialId.current ??= crypto.randomUUID();
          const action = command.current ?? {
            action: "start",
            requestId: initialId.current,
          };
          next = await request("POST", { ...action, revision });
          command.current = null;
        }
        if (!controller.signal.aborted) {
          setView(next);
          setNotice("");
          if (
            next.configured &&
            !next.tripPast &&
            next.discovery?.status === "running"
          )
            timer = setTimeout(() => void load(), 2000);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setNotice(
            error instanceof Error
              ? error.message
              : "Couldn't check event sources. Try again.",
          );
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    const refresh = () => {
      if (!document.hidden) void load();
    };
    void load();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [accountId, revision, draftChanged, reload]);

  const discovery = view?.discovery;
  const running =
    busy ||
    (!!view?.configured && !view.tripPast && discovery?.status === "running");
  const retry = () => {
    command.current ??= { action: "refresh", requestId: crypto.randomUUID() };
    setReload((n) => n + 1);
  };
  const continueToCalendar = () => {
    const heading = document.getElementById("calendar-title");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
      heading.scrollIntoView({ block: "center" });
    }
  };
  return (
    <section
      className="event-section"
      aria-labelledby="events-title"
      aria-busy={running || (!view && !notice)}
    >
      <h2 id="events-title">Events for your goal</h2>
      {(draftChanged || view?.draftChanged) && (
        <p className="event-caveat">
          Based on your saved profile. Confirm your changes to update these.
        </p>
      )}
      {view?.outdated && (
        <p className="event-caveat">
          These results were checked more than 24 hours ago.
        </p>
      )}
      {!view ? (
        !notice && <p role="status">Checking event recommendations…</p>
      ) : !view.configured ? (
        <p>
          Event discovery setup is pending. You can still connect Google
          Calendar.
        </p>
      ) : view.tripPast ? (
        <p>Your saved trip has ended. Confirm new dates to find events.</p>
      ) : running ? (
        <p role="status">
          Finding events
          {view.window
            ? ` for ${dateLabel(view.window.start)}–${dateLabel(view.window.end)}`
            : ""}
          …
        </p>
      ) : view.dailyLimitReached ? (
        <p role="status">
          Event discovery is paused for today. You can still connect Google
          Calendar.
        </p>
      ) : discovery?.status === "failed" ? (
        <p role="status">
          Couldn&apos;t check event sources. You can still connect Google
          Calendar.
        </p>
      ) : discovery?.status === "empty" ? (
        <p role="status">
          No events matched your goal and dates in the sources we checked.
        </p>
      ) : discovery?.status === "partial" ? (
        <p role="status">Some sources couldn&apos;t be checked.</p>
      ) : null}
      {discovery?.status === "failed" && !!discovery.recommendations.length && (
        <p className="event-detail">Showing your last successful results.</p>
      )}
      {!!discovery?.recommendations.length && (
        <div className="event-list">
          {discovery.recommendations.map((event) => (
            <article className="event-card" key={event.id}>
              <h3>{event.title}</h3>
              <p className="event-date">{eventTime(event)}</p>
              <p>
                {[event.location.venue, "San Francisco"]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {event.location.address && (
                <p className="event-detail">{event.location.address}</p>
              )}
              <p>{event.price.label}</p>
              <p>{event.reason}</p>
              {!!event.caveats.length && (
                <p className="event-caveat">{event.caveats.join(" ")}</p>
              )}
              <p className="event-detail">
                {PLATFORM_NAMES[event.platform]} · checked{" "}
                {checkedLabel(event.checkedAt)} PT
              </p>
              {!!event.alsoListed.length && (
                <p className="event-detail">
                  Also listed on{" "}
                  {event.alsoListed.map((source, i) => (
                    <span key={source.url}>
                      {i > 0 && ", "}
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {PLATFORM_NAMES[source.platform]}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </span>
                  ))}
                </p>
              )}
              <details className="event-evidence">
                <summary>Source details</summary>
                <p className="event-detail">
                  Checked{" "}
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: SF_TIMEZONE,
                  }).format(new Date(event.checkedAt))}{" "}
                  PT. Goal fit is a suggestion based on the description.
                </p>
                {event.evidence.map((item, i) => (
                  <blockquote key={`${item.field}-${i}`}>
                    <p>“{item.quote}”</p>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {item.field}
                      <span className="sr-only">
                        {" "}
                        source (opens in a new tab)
                      </span>
                    </a>
                  </blockquote>
                ))}
              </details>
              <a
                className="secondary-button event-open"
                href={event.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open on {PLATFORM_NAMES[event.platform]}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </article>
          ))}
        </div>
      )}
      {discovery && discovery.coverage.sources.length > 0 && (
        <p className="event-detail">
          {discovery.coverage.sources
            .map(
              (s) =>
                `${s.platform === "web" ? "Web" : PLATFORM_NAMES[s.platform]}: ${s.status === "failed" ? "not checked" : `${s.results} results, ${s.verified} verified`}`,
            )
            .join(" · ")}
          . {discovery.coverage.verified} candidates passed checks. Coverage is
          limited to these sources.
        </p>
      )}
      {notice && <p role="alert">{notice}</p>}
      {!running &&
        view?.configured &&
        !view.tripPast &&
        !view.dailyLimitReached &&
        (discovery?.canRefresh || !discovery) && (
          <button className="text-button" onClick={retry}>
            {notice ||
            discovery?.status === "failed" ||
            discovery?.status === "partial"
              ? "Try again"
              : "Check again"}
          </button>
        )}
      {!view && notice && (
        <button className="text-button" onClick={() => setReload((n) => n + 1)}>
          Try again
        </button>
      )}
      {discovery &&
        !discovery.canRefresh &&
        !running &&
        !view?.tripPast &&
        !view?.dailyLimitReached && (
          <p className="event-detail">
            Refresh limit reached. Try again in 24 hours.
          </p>
        )}
      {!running && (view || notice) && (
        <p>
          <a href="#calendar-title" onClick={continueToCalendar}>
            Continue to Google Calendar
          </a>
        </p>
      )}
      <p className="event-detail">
        Opening an event page doesn&apos;t register you.
      </p>
    </section>
  );
}
