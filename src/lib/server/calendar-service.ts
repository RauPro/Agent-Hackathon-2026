import { randomBytes } from "node:crypto";
import {
  calendarWindow,
  snapshotIsFresh,
  type CalendarStatus,
} from "@/lib/domain/calendar";
import { openCalendarData, sealCalendarData } from "./calendar-crypto";
import { CalendarConflict, ContextStore } from "./store";
import {
  CalendarError,
  exchangeGoogleCode,
  googleAccount,
  googleAuthorizationUrl,
  googleBusy,
  googleCalendarConfig,
  googleCalendars,
  hasCalendarScopes,
  refreshGoogleTokens,
  revokeGoogleTokens,
  tokenDataSchema,
} from "./google-calendar";

export function calendarStatus(
  store: ContextStore,
  token: string | undefined,
  now = Date.now(),
): CalendarStatus {
  const { revision, connection } = store.readCalendar(token);
  const chat = store.readChat(token),
    context = store.read(token)!;
  const window = calendarWindow(chat.draft.arrival, chat.draft.departure);
  const configured = !!googleCalendarConfig();
  const availabilityReady = !!(
    configured &&
    connection &&
    snapshotIsFresh(connection, window, now)
  );
  const profileReady = !!(
    chat.confirmed &&
    context.context &&
    chat.baseRevision === context.revision
  );
  return {
    configured,
    revision,
    email: connection?.email ?? null,
    calendars: connection?.calendars ?? [],
    selectedIds: connection?.selectedIds ?? [],
    window,
    checkedAt: connection?.snapshot?.checkedAt ?? null,
    status: !connection
      ? "not_connected"
      : connection.issue === "needs_reconnect"
        ? "needs_reconnect"
        : connection.issue
          ? "sync_failed"
          : availabilityReady
            ? "synced"
            : "connected",
    issue: connection?.issue ?? null,
    availabilityReady,
    profileReady,
    onboardingComplete: profileReady && availabilityReady,
  };
}

export function beginCalendarConnection(store: ContextStore, token: string) {
  const owner = store.calendarOwner(token);
  const state = randomBytes(32).toString("hex"),
    verifier = randomBytes(32).toString("base64url");
  const url = googleAuthorizationUrl(state, verifier);
  store.startCalendarOAuth(
    token,
    state,
    sealCalendarData(verifier, `${owner}:${state}`),
  );
  return url;
}

export async function finishCalendarConnection(
  store: ContextStore,
  token: string | undefined,
  state: string,
  code: string | null,
  denied: boolean,
) {
  if (!/^[a-f0-9]{64}$/.test(state)) throw new CalendarError("invalid_state");
  const attempt = store.consumeCalendarOAuth(token, state);
  if (denied) throw new CalendarError("denied");
  if (!code || code.length > 4096) throw new CalendarError("invalid_state");
  const owner = store.calendarOwner(token);
  const verifier = openCalendarData<string>(
    attempt.encrypted_verifier,
    `${owner}:${state}`,
  );
  const signal = AbortSignal.timeout(25000);
  const tokens = await exchangeGoogleCode(code, verifier, signal);
  const [account, calendars] = await Promise.all([
    googleAccount(tokens.accessToken, signal),
    googleCalendars(tokens.accessToken, signal),
  ]);
  const primary = calendars.find((calendar) => calendar.primary);
  if (!primary) throw new CalendarError("calendar_unavailable");
  return store.connectCalendar(token!, attempt.base_revision, (nextOwner) => ({
    ...account,
    encryptedTokens: sealCalendarData(tokens, nextOwner),
    calendars,
    selectedIds: [primary.id],
    snapshot: null,
    issue: null,
  }));
}

const syncing = new Set<string>();
export async function syncCalendar(
  store: ContextStore,
  token: string | undefined,
) {
  const owner = store.calendarOwner(token);
  if (!googleCalendarConfig()) throw new CalendarError("not_configured");
  if (syncing.has(owner)) throw new CalendarError("busy");
  let record = store.readCalendar(token);
  if (!record.connection) throw new CalendarError("needs_reconnect");
  const window = calendarStatus(store, token).window;
  if (!window) throw new CalendarError("missing_dates");
  syncing.add(owner);
  try {
    let tokens;
    try {
      tokens = tokenDataSchema.parse(
        openCalendarData(record.connection.encryptedTokens, owner),
      );
    } catch {
      throw new CalendarError("needs_reconnect");
    }
    if (!hasCalendarScopes(tokens.scopes))
      throw new CalendarError("needs_reconnect");
    const signal = AbortSignal.timeout(25000);
    if (tokens.expiresAt < Date.now() + 60000) {
      tokens = await refreshGoogleTokens(tokens, signal);
      record = store.writeCalendar(token, record.revision, {
        ...record.connection,
        encryptedTokens: sealCalendarData(tokens, owner),
      });
    }
    const connection = record.connection!;
    if (!connection.selectedIds.length || connection.selectedIds.length > 50)
      throw new CalendarError("invalid_selection");
    const busy = await googleBusy(
      tokens.accessToken,
      connection.selectedIds,
      window,
      signal,
    );
    store.writeCalendar(token, record.revision, {
      ...connection,
      issue: null,
      snapshot: {
        window,
        calendarIds: [...connection.selectedIds],
        checkedAt: new Date().toISOString(),
        busy,
      },
    });
    return calendarStatus(store, token);
  } catch (error) {
    if (error instanceof CalendarError) {
      const issue = ["needs_reconnect", "missing_permissions"].includes(
        error.code,
      )
        ? "needs_reconnect"
        : error.code === "calendar_unavailable"
          ? "calendar_unavailable"
          : "sync_failed";
      try {
        store.writeCalendar(token, record.revision, {
          ...record.connection!,
          issue,
        });
      } catch {
        /* A newer selection or disconnect owns the current state. */
      }
    }
    throw error;
  } finally {
    syncing.delete(owner);
  }
}

export function selectCalendars(
  store: ContextStore,
  token: string | undefined,
  revision: number,
  ids: string[],
) {
  const record = store.readCalendar(token),
    connection = record.connection;
  if (record.revision !== revision)
    throw new CalendarConflict("calendar_changed");
  if (!connection) throw new CalendarError("needs_reconnect");
  const selectedIds = [...new Set(ids)];
  if (
    !selectedIds.length ||
    selectedIds.length > 50 ||
    selectedIds.some(
      (id) => !connection.calendars.some((calendar) => calendar.id === id),
    )
  )
    throw new CalendarError("invalid_selection");
  store.writeCalendar(token, revision, {
    ...connection,
    selectedIds,
    snapshot: null,
    issue: connection.issue === "needs_reconnect" ? "needs_reconnect" : null,
  });
  return calendarStatus(store, token);
}

export async function disconnectCalendar(
  store: ContextStore,
  token: string | undefined,
  revision: number,
) {
  const record = store.readCalendar(token),
    owner = store.calendarOwner(token);
  if (record.revision !== revision)
    throw new CalendarConflict("calendar_changed");
  // Local access ends before any network request, even when Google is unavailable.
  store.writeCalendar(token, revision, null);
  let revoked = true;
  if (record.connection) {
    try {
      revoked = await revokeGoogleTokens(
        tokenDataSchema.parse(
          openCalendarData(record.connection.encryptedTokens, owner),
        ),
      );
    } catch {
      revoked = false;
    }
  }
  return { ...calendarStatus(store, token), revoked };
}
