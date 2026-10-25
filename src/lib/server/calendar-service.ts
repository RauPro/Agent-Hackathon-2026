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
  hasCalendarWriteScope,
  refreshGoogleTokens,
  revokeGoogleTokens,
  tokenDataSchema,
} from "./google-calendar";
import { z } from "zod";

export const calendarConnectionRequestSchema = z.union([
  z.object({ purpose: z.literal("availability").optional() }).strict(),
  z.object({ purpose: z.literal("meeting"), meetingId: z.uuid() }).strict(),
]);
type CalendarConnectionRequest = z.infer<typeof calendarConnectionRequestSchema>;

export async function calendarStatus(
  store: ContextStore,
  token: string | undefined,
  now = Date.now(),
): Promise<CalendarStatus> {
  const { revision, connection } = await store.readCalendar(token);
  const chat = await store.readChat(token),
    context = (await store.read(token))!;
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
  let meetingPublishingReady = false;
  if (connection) {
    try {
      const tokens = tokenDataSchema.parse(openCalendarData(connection.encryptedTokens, await store.calendarOwner(token)));
      meetingPublishingReady = configured && hasCalendarWriteScope(tokens.scopes) && connection.issue !== "needs_reconnect";
    } catch { /* Read-only availability remains independently usable. */ }
  }
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
    meetingPublishingReady,
  };
}

export async function beginCalendarConnection(
  store: ContextStore,
  token: string,
  raw: CalendarConnectionRequest = {},
) {
  const input = calendarConnectionRequestSchema.parse(raw);
  const owner = await store.calendarOwner(token);
  const existing = await store.readCalendar(token);
  let returnTo: string | undefined;
  if (input.purpose === "meeting") {
    const account = await store.requireAccount(token);
    const row = await store.network.db.prepare("SELECT state_json FROM meetings WHERE id = ? AND (first_user_id = ? OR second_user_id = ?)")
      .get(input.meetingId, account.id, account.id) as { state_json: string } | undefined;
    const meeting = row && z.object({ status: z.literal("confirmed"), participants: z.array(z.string()).length(2), selectedOptionId: z.string(), approvals: z.record(z.string(), z.string()) }).safeParse(JSON.parse(row.state_json));
    if (!meeting?.success || !meeting.data.participants.every((id) => meeting.data.approvals[id] === meeting.data.selectedOptionId) ||
        !(await store.network.isConnected(...meeting.data.participants as [string, string])) ||
        await store.network.blocked(...meeting.data.participants as [string, string]))
      throw new CalendarError("approval_required");
    returnTo = `/onboarding?agents=1&person=${encodeURIComponent(meeting.data.participants.find((id) => id !== account.id)!)}`;
  }
  const state = randomBytes(32).toString("hex"),
    verifier = randomBytes(32).toString("base64url");
  const url = googleAuthorizationUrl(state, verifier, input.purpose === "meeting");
  await store.startCalendarOAuth(
    token,
    state,
    sealCalendarData(input.purpose === "meeting" ? { verifier, write: true, subject: existing.connection?.subject ?? null, returnTo } : verifier, `${owner}:${state}`),
  );
  return url;
}

export async function finishCalendarConnection(
  store: ContextStore,
  token: string | undefined,
  state: string,
  code: string | null,
  denied: boolean,
  onReturnTo?: (path: string) => void,
) {
  if (!/^[a-f0-9]{64}$/.test(state)) throw new CalendarError("invalid_state");
  const attempt = await store.consumeCalendarOAuth(token, state);
  const owner = await store.calendarOwner(token);
  const payload = openCalendarData<string | { verifier: string; write: true; subject: string | null; returnTo: string }>(
    attempt.encrypted_verifier,
    `${owner}:${state}`,
  );
  const verifier = typeof payload === "string" ? payload : payload.verifier;
  if (typeof payload !== "string") onReturnTo?.(payload.returnTo);
  if (denied) throw new CalendarError("denied");
  if (!code || code.length > 4096) throw new CalendarError("invalid_state");
  const signal = AbortSignal.timeout(25000);
  const tokens = await exchangeGoogleCode(code, verifier, signal);
  const [account, calendars] = await Promise.all([
    googleAccount(tokens.accessToken, signal),
    googleCalendars(tokens.accessToken, signal),
  ]);
  const existing = await store.readCalendar(token);
  const upgrading = typeof payload !== "string" && payload.write;
  if (upgrading && !hasCalendarWriteScope(tokens.scopes)) throw new CalendarError("needs_upgrade");
  if (upgrading && payload.subject && payload.subject !== account.subject) throw new CalendarError("account_changed");
  const primary = calendars.find((calendar) => calendar.primary);
  if (!primary) throw new CalendarError("calendar_unavailable");
  const retainedIds = upgrading && existing.connection?.subject === account.subject
    ? existing.connection.selectedIds.filter((id) => calendars.some((calendar) => calendar.id === id))
    : [];
  return await store.connectCalendar(
    token!,
    attempt.base_revision,
    (nextOwner) => ({
      ...account,
      encryptedTokens: sealCalendarData(tokens, nextOwner),
      calendars,
      selectedIds: retainedIds.length ? retainedIds : [primary.id],
      snapshot: retainedIds.length && existing.connection?.subject === account.subject ? existing.connection.snapshot : null,
      issue: null,
    }),
  );
}

export async function syncCalendar(
  store: ContextStore,
  token: string | undefined,
) {
  const owner = await store.calendarOwner(token);
  if (!googleCalendarConfig()) throw new CalendarError("not_configured");
  let record = await store.readCalendar(token);
  if (!record.connection) throw new CalendarError("needs_reconnect");
  const window = (await calendarStatus(store, token)).window;
  if (!window) throw new CalendarError("missing_dates");
  const leaseKey = `calendar:${owner}`;
  const lease = await store.network.db.acquireLease(leaseKey, 35_000);
  if (!lease) throw new CalendarError("busy");
  try {
    record = await store.readCalendar(token);
    if (!record.connection) throw new CalendarError("needs_reconnect");
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
      record = await store.writeCalendar(token, record.revision, {
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
    await store.writeCalendar(token, record.revision, {
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
    if (error instanceof CalendarError && record.connection) {
      const issue = ["needs_reconnect", "missing_permissions"].includes(
        error.code,
      )
        ? "needs_reconnect"
        : error.code === "calendar_unavailable"
          ? "calendar_unavailable"
          : "sync_failed";
      try {
        await store.writeCalendar(token, record.revision, {
          ...record.connection!,
          issue,
        });
      } catch {
        /* A newer selection or disconnect owns the current state. */
      }
    }
    throw error;
  } finally {
    await store.network.db.releaseLease(leaseKey, lease);
  }
}

export async function selectCalendars(
  store: ContextStore,
  token: string | undefined,
  revision: number,
  ids: string[],
) {
  const record = await store.readCalendar(token),
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
  await store.writeCalendar(token, revision, {
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
  const record = await store.readCalendar(token),
    owner = await store.calendarOwner(token);
  if (record.revision !== revision)
    throw new CalendarConflict("calendar_changed");
  // Local access ends before any network request, even when Google is unavailable.
  await store.writeCalendar(token, revision, null);
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
  return { ...(await calendarStatus(store, token)), revoked };
}
