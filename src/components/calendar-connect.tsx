"use client";

import { useEffect, useRef, useState } from "react";
import type { CalendarStatus } from "@/lib/domain/calendar";

async function readStatus(accountId: string): Promise<CalendarStatus> {
  const response = await fetch("/api/calendar", {
    cache: "no-store",
    headers: { "X-Sidekick-Account": accountId },
  });
  if (response.status === 401) window.location.replace("/login");
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.message || "Could not load your calendar connection.",
    );
  return result;
}
async function post(action: unknown, accountId: string) {
  const response = await fetch("/api/calendar", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sidekick-Account": accountId,
    },
    body: JSON.stringify(action),
  });
  if (response.status === 401) window.location.replace("/login");
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message || "Could not check calendar availability.");
  return result as CalendarStatus & { revoked?: boolean };
}
function dates(status: CalendarStatus) {
  if (!status.window) return "";
  const format = (date: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T12:00:00Z`));
  return `${format(status.window.startDate)} – ${format(status.window.endDate)}`;
}

export function CalendarConnect({
  accountId,
  chatRevision,
  disabled,
  beforeConnect,
}: {
  accountId: string;
  chatRevision: number;
  disabled: boolean;
  beforeConnect: () => void;
}) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const lock = useRef(false);
  const queued = useRef(false);
  const callbackRead = useRef(false);

  useEffect(() => {
    let active = true;
    async function refresh() {
      if (lock.current) {
        queued.current = true;
        return;
      }
      lock.current = true;
      if (active) setBusy(true);
      try {
        let next = await readStatus(accountId);
        let synced = false;
        if (active) setStatus(next);
        if (
          next.configured &&
          next.email &&
          next.window &&
          !next.availabilityReady &&
          next.status !== "needs_reconnect"
        ) {
          if (active) setBusy(true);
          next = await post({ action: "sync" }, accountId);
          synced = true;
        }
        if (active) {
          setStatus(next);
          if (synced) setNotice("");
          if (!callbackRead.current) {
            callbackRead.current = true;
            const url = new URL(window.location.href);
            const code = url.searchParams.get("calendar");
            if (code) {
              const messages: Record<string, string> = {
                denied:
                  "Google Calendar was not connected. Connect when you are ready.",
                invalid_state:
                  "This connection attempt expired or was already used. Connect again.",
                missing_permissions:
                  "Allow calendar access in Google to check availability.",
                api_disabled:
                  "Google Calendar is not enabled for this app yet. Contact the app owner.",
                calendar_unavailable:
                  "Your primary calendar could not be accessed. Try connecting again.",
              };
              setNotice(
                messages[code] ||
                  "Could not connect Google Calendar. Try again.",
              );
              url.searchParams.delete("calendar");
              window.history.replaceState(null, "", url);
            }
          }
        }
      } catch (error) {
        if (active) {
          setNotice(
            error instanceof Error
              ? error.message
              : "Could not check calendar availability.",
          );
          try {
            setStatus(await readStatus(accountId));
          } catch {
            setStatus(null);
          }
        }
      } finally {
        lock.current = false;
        if (active) setBusy(false);
        if (queued.current) {
          queued.current = false;
          setRefreshKey((key) => key + 1);
        }
      }
    }
    const visibleRefresh = () => {
      if (!document.hidden) void refresh();
    };
    void refresh();
    const interval = window.setInterval(visibleRefresh, 60000);
    window.addEventListener("focus", visibleRefresh);
    window.addEventListener("online", visibleRefresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", visibleRefresh);
      window.removeEventListener("online", visibleRefresh);
    };
  }, [chatRevision, refreshKey, accountId]);

  async function act(
    action: "sync" | "disconnect" | "select",
    calendarIds?: string[],
  ) {
    if (!status || lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    if (action === "select" && calendarIds) {
      setStatus({
        ...status,
        selectedIds: calendarIds,
        availabilityReady: false,
        onboardingComplete: false,
      });
    }
    try {
      const next = await post(
        action === "sync"
          ? { action }
          : {
              action,
              revision: status.revision,
              ...(action === "select" ? { calendarIds } : {}),
            },
        accountId,
      );
      setStatus(next);
      if (next.revoked === false)
        setNotice(
          "Disconnected here. Google revocation could not be verified; remove SF Sidekick access in your Google Account.",
        );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not update your calendar connection.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      setRefreshKey((key) => key + 1);
    }
  }

  async function connect() {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/calendar/connect", {
        method: "POST",
        headers: { "X-Sidekick-Account": accountId },
      });
      if (response.status === 401) window.location.replace("/login");
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "Could not connect Google Calendar.");
      beforeConnect();
      window.location.assign(result.url);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not connect Google Calendar.",
      );
      lock.current = false;
      setBusy(false);
    }
  }

  const connected = !!status?.email;
  return (
    <section
      className="calendar-card"
      aria-labelledby="calendar-title"
      aria-busy={busy}
    >
      <div className="calendar-heading">
        <h2 id="calendar-title">Google Calendar</h2>
        <span
          className={`profile-status${status?.availabilityReady ? " confirmed" : ""}`}
        >
          {status?.availabilityReady ? "Synced" : "Required"}
        </span>
      </div>
      {!status ? (
        notice ? (
          <button
            className="text-button"
            onClick={() => setRefreshKey((key) => key + 1)}
          >
            Reload calendar status
          </button>
        ) : (
          <p>Checking connection…</p>
        )
      ) : !connected ? (
        <>
          <p>Connect to find times that work for both people.</p>
          {status.configured ? (
            <>
              <button
                className="secondary-button"
                disabled={busy || disabled}
                onClick={() => void connect()}
              >
                {busy ? "Connecting…" : "Connect Google Calendar"}
              </button>
              <p className="calendar-detail">
                Reads calendar names and busy times. Event details stay private.
              </p>
            </>
          ) : (
            <p className="calendar-pending">
              Google Calendar setup is pending. You can save your profile, but
              onboarding remains incomplete.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="calendar-account">{status.email}</p>
          <p className="calendar-detail" role="status">
            {busy
              ? "Checking availability…"
              : status.status === "needs_reconnect"
                ? "Reconnect to check your availability."
                : !status.window
                  ? "Add your SF trip dates in the chat to check availability."
                  : status.availabilityReady
                    ? `${dates(status)} · SF time`
                    : "Availability has not been verified for your current trip."}
          </p>
          {status.availabilityReady && status.checkedAt && (
            <p className="calendar-detail">
              Checked at{" "}
              {new Intl.DateTimeFormat("en-US", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/Los_Angeles",
              }).format(new Date(status.checkedAt))}{" "}
              SF time.
            </p>
          )}
          <details className="calendar-options">
            <summary>
              {status.selectedIds.length}{" "}
              {status.selectedIds.length === 1 ? "calendar" : "calendars"}{" "}
              included
            </summary>
            <fieldset disabled={busy}>
              <legend>Include calendars that contain your commitments.</legend>
              {status.calendars.map((calendar) => (
                <label key={calendar.id}>
                  <input
                    type="checkbox"
                    checked={status.selectedIds.includes(calendar.id)}
                    onChange={(event) =>
                      void act(
                        "select",
                        event.target.checked
                          ? [...status.selectedIds, calendar.id]
                          : status.selectedIds.filter(
                              (id) => id !== calendar.id,
                            ),
                      )
                    }
                  />
                  <span>
                    {calendar.name}
                    {calendar.primary ? " (primary)" : ""}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="calendar-actions">
              <button
                className="text-button"
                disabled={busy || disabled}
                onClick={() => void connect()}
              >
                Reconnect account
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void act("disconnect")}
              >
                Disconnect
              </button>
            </div>
          </details>
          {status.status === "needs_reconnect" ? (
            <button
              className="secondary-button"
              disabled={busy || disabled}
              onClick={() => void connect()}
            >
              Reconnect Google Calendar
            </button>
          ) : (
            status.window && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void act("sync")}
              >
                {busy ? "Syncing…" : "Refresh availability"}
              </button>
            )
          )}
          {status.onboardingComplete && (
            <p className="calendar-complete" role="status">
              ✓ Onboarding complete
            </p>
          )}
        </>
      )}
      {notice && (
        <div className="notice" role="alert">
          <p>{notice}</p>
        </div>
      )}
    </section>
  );
}
