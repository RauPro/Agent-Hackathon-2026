import { CalendarError } from "./google-calendar";
import { CalendarConflict, SessionMissing } from "./store";
import { json } from "./http";

export function calendarFailure(error: unknown) {
  const code =
    error instanceof CalendarError || error instanceof CalendarConflict
      ? error.code
      : error instanceof SessionMissing
        ? "session_missing"
        : "sync_failed";
  const messages: Record<string, string> = {
    not_configured:
      "Google Calendar setup is pending. Your profile can still be saved.",
    invalid_state:
      "This connection attempt expired or was already used. Connect again.",
    denied: "Google Calendar was not connected. Connect when you are ready.",
    missing_permissions:
      "Allow calendar access in Google to check availability.",
    needs_reconnect: "Reconnect Google Calendar to check availability.",
    sync_failed: "Could not check calendar availability. Try again.",
    calendar_unavailable:
      "A selected calendar could not be checked. Review your calendars or reconnect.",
    missing_dates: "Add your SF trip dates in the chat to check availability.",
    invalid_selection: "Select between 1 and 50 calendars from your account.",
    calendar_changed: "Your calendar connection changed. Refresh its status.",
    busy: "A calendar check is already in progress. Try again shortly.",
    session_missing: "Your session changed. Reload the page to continue.",
  };
  const status =
    code === "session_missing"
      ? 401
      : code === "calendar_changed"
        ? 409
        : code === "busy"
          ? 429
          : ["not_configured", "sync_failed", "calendar_unavailable"].includes(
                code,
              )
            ? 503
            : 400;
  return json({ code, message: messages[code] }, status);
}
