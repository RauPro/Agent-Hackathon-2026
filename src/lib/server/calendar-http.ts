import { isStoreError } from "./store";
import { CalendarError } from "./google-calendar";
import { json } from "./http";
import { ZodError } from "zod";

export function calendarFailure(error: unknown) {
  const code =
    error instanceof CalendarError || isStoreError(error, "calendar_conflict")
      ? error.code
      : error instanceof ZodError ? "invalid_request" : isStoreError(error, "session_missing")
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
    api_disabled:
      "Google Calendar is not enabled for this app yet. Contact the app owner.",
    needs_reconnect: "Reconnect Google Calendar to check availability.",
    needs_upgrade: "Allow Google Calendar event creation to send this invitation.",
    account_changed: "Use the same Google account that started this calendar invitation.",
    approval_required: "Both participants must approve the same meeting before an invitation can be sent.",
    event_conflict: "The Google event changed. Review it in Google Calendar before continuing.",
    event_cancelled: "This event was cancelled in Google Calendar. Start a new meeting to reschedule it.",
    event_not_found: "The Google event could not be found. Try again.",
    invalid_request: "Review your calendar connection request.",
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
          : [
                "not_configured",
                "api_disabled",
                "sync_failed",
                "calendar_unavailable",
              ].includes(code)
            ? 503
            : 400;
  return json({ code, message: messages[code] }, status);
}
