import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CALENDAR_SCOPES,
  mergeBusy,
  type BusyInterval,
  type CalendarOption,
  type CalendarWindow,
} from "@/lib/domain/calendar";
import { calendarEncryptionConfigured } from "./calendar-crypto";

export class CalendarError extends Error {
  constructor(
    public code:
      | "not_configured"
      | "invalid_state"
      | "denied"
      | "missing_permissions"
      | "api_disabled"
      | "needs_reconnect"
      | "sync_failed"
      | "calendar_unavailable"
      | "missing_dates"
      | "invalid_selection"
      | "calendar_changed"
      | "busy",
  ) {
    super(code);
  }
}
export type GoogleTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};
export const tokenDataSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  scopes: z.array(z.string()),
});

export function googleCalendarConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !calendarEncryptionConfigured()
  )
    return null;
  try {
    const redirect = new URL(redirectUri);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(
      redirect.hostname,
    );
    if (
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash ||
      redirect.pathname !== "/api/calendar/callback" ||
      (redirect.protocol !== "https:" &&
        !(local && redirect.protocol === "http:"))
    )
      return null;
    return { clientId, clientSecret, redirectUri, origin: redirect.origin };
  } catch {
    return null;
  }
}

function endpoints() {
  const test = process.env.GOOGLE_TEST_BASE_URL;
  if (test) {
    const url = new URL(test);
    if (
      process.env.NODE_ENV === "production" ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      throw new CalendarError("not_configured");
    return {
      authorize: `${test}/authorize`,
      token: `${test}/token`,
      userinfo: `${test}/userinfo`,
      calendars: `${test}/calendars`,
      freebusy: `${test}/freebusy`,
      revoke: `${test}/revoke`,
    };
  }
  return {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    calendars: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    freebusy: "https://www.googleapis.com/calendar/v3/freeBusy",
    revoke: "https://oauth2.googleapis.com/revoke",
  };
}

export function hasCalendarScopes(scopes: string[]) {
  return CALENDAR_SCOPES.slice(2).every((scope) => scopes.includes(scope));
}

export function googleAuthorizationUrl(state: string, verifier: string) {
  const config = googleCalendarConfig();
  if (!config) throw new CalendarError("not_configured");
  const url = new URL(endpoints().authorize);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  return url.toString();
}

async function googleJson(url: string, init: RequestInit, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new CalendarError("sync_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CalendarError("sync_failed");
  }
  if (!response.ok) {
    const code = (body as { error?: unknown })?.error;
    if (response.status === 401 || code === "invalid_grant")
      throw new CalendarError("needs_reconnect");
    if (response.status === 403) {
      const details = z
        .object({
          errors: z.array(z.object({ reason: z.string() })).optional(),
          details: z
            .array(z.object({ reason: z.string().optional() }).passthrough())
            .optional(),
        })
        .safeParse(code);
      if (
        details.success &&
        (details.data.errors?.some(
          (item) => item.reason === "accessNotConfigured",
        ) ||
          details.data.details?.some(
            (item) => item.reason === "SERVICE_DISABLED",
          ))
      )
        throw new CalendarError("api_disabled");
      throw new CalendarError("missing_permissions");
    }
    throw new CalendarError("sync_failed");
  }
  return body;
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  token_type: z.string(),
});
async function requestTokens(
  parameters: Record<string, string>,
  signal: AbortSignal,
  previous?: GoogleTokens,
): Promise<GoogleTokens> {
  const config = googleCalendarConfig();
  if (!config) throw new CalendarError("not_configured");
  const raw = tokenResponse.safeParse(
    await googleJson(
      endpoints().token,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      },
      signal,
    ),
  );
  if (!raw.success || raw.data.token_type.toLowerCase() !== "bearer")
    throw new CalendarError("sync_failed");
  const scopes = raw.data.scope?.split(/\s+/) ?? previous?.scopes ?? [];
  if (!hasCalendarScopes(scopes))
    throw new CalendarError("missing_permissions");
  const refreshToken = raw.data.refresh_token || previous?.refreshToken;
  if (!refreshToken) throw new CalendarError("needs_reconnect");
  return {
    accessToken: raw.data.access_token,
    refreshToken,
    expiresAt: Date.now() + raw.data.expires_in * 1000,
    scopes,
  };
}

export async function exchangeGoogleCode(
  code: string,
  verifier: string,
  signal: AbortSignal,
) {
  const config = googleCalendarConfig();
  if (!config) throw new CalendarError("not_configured");
  return requestTokens(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: config.redirectUri,
    },
    signal,
  );
}
export async function refreshGoogleTokens(
  tokens: GoogleTokens,
  signal: AbortSignal,
) {
  return requestTokens(
    { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
    signal,
    tokens,
  );
}

export async function googleAccount(accessToken: string, signal: AbortSignal) {
  const parsed = z
    .object({
      sub: z.string().min(1),
      email: z.email(),
      email_verified: z.literal(true),
    })
    .safeParse(
      await googleJson(
        endpoints().userinfo,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        signal,
      ),
    );
  if (!parsed.success) throw new CalendarError("missing_permissions");
  return { subject: parsed.data.sub, email: parsed.data.email };
}

export async function googleCalendars(
  accessToken: string,
  signal: AbortSignal,
): Promise<CalendarOption[]> {
  const result: CalendarOption[] = [];
  let nextPage: string | undefined;
  const schema = z.object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          summary: z.string().optional(),
          primary: z.boolean().optional(),
          timeZone: z.string().optional(),
          deleted: z.boolean().optional(),
        }),
      )
      .default([]),
    nextPageToken: z.string().optional(),
  });
  for (let page = 0; page < 5; page++) {
    const url = new URL(endpoints().calendars);
    url.search = new URLSearchParams({
      maxResults: "250",
      minAccessRole: "freeBusyReader",
      showHidden: "true",
      ...(nextPage ? { pageToken: nextPage } : {}),
    }).toString();
    const parsed = schema.safeParse(
      await googleJson(
        url.toString(),
        { headers: { Authorization: `Bearer ${accessToken}` } },
        signal,
      ),
    );
    if (!parsed.success) throw new CalendarError("sync_failed");
    result.push(
      ...parsed.data.items
        .filter((value) => !value.deleted)
        .map((value) => ({
          id: value.id,
          name: value.summary || value.id,
          primary: !!value.primary,
          timezone: value.timeZone || "America/Los_Angeles",
        })),
    );
    nextPage = parsed.data.nextPageToken;
    if (!nextPage)
      return [...new Map(result.map((value) => [value.id, value])).values()];
  }
  throw new CalendarError("calendar_unavailable");
}

export async function googleBusy(
  accessToken: string,
  ids: string[],
  window: CalendarWindow,
  signal: AbortSignal,
): Promise<BusyInterval[]> {
  const interval = z.object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  });
  const schema = z.object({
    timeMin: z.iso.datetime({ offset: true }),
    timeMax: z.iso.datetime({ offset: true }),
    calendars: z.record(
      z.string(),
      z.object({
        busy: z.array(interval).optional(),
        errors: z.array(z.unknown()).optional(),
      }),
    ),
  });
  const parsed = schema.safeParse(
    await googleJson(
      endpoints().freebusy,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          timeZone: "America/Los_Angeles",
          items: ids.map((id) => ({ id })),
        }),
      },
      signal,
    ),
  );
  if (
    !parsed.success ||
    Date.parse(parsed.data.timeMin) !== Date.parse(window.timeMin) ||
    Date.parse(parsed.data.timeMax) !== Date.parse(window.timeMax)
  )
    throw new CalendarError("sync_failed");
  const intervals: BusyInterval[] = [];
  for (const id of ids) {
    const value = parsed.data.calendars[id];
    if (!value || value.errors?.length || !value.busy)
      throw new CalendarError("calendar_unavailable");
    if (
      value.busy.some((slot) => Date.parse(slot.end) <= Date.parse(slot.start))
    )
      throw new CalendarError("sync_failed");
    intervals.push(...value.busy);
  }
  return mergeBusy(intervals, window);
}

export async function revokeGoogleTokens(tokens: GoogleTokens) {
  try {
    const response = await fetch(endpoints().revoke, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refreshToken }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (response.ok) return true;
    return (
      response.status === 400 &&
      (await response.json()).error === "invalid_token"
    );
  } catch {
    return false;
  }
}
