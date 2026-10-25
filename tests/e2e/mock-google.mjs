// Test-only Google fixture. No real accounts, events, or credentials are used.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
const codes = new Map();
const grants = new Map();
const events = new Map();
let busyOverride = null;
let conferencePending = false;
let insertCount = 0;
const scopes =
  "openid email https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:3102");
  const json = (data, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
  };
  if (url.pathname === "/health") return json({});
  if (url.pathname === "/test/state") {
    if (request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      if (input.reset) { events.clear(); insertCount = 0; busyOverride = null; conferencePending = false; }
      if (Array.isArray(input.busy)) busyOverride = input.busy;
      if (typeof input.conferencePending === "boolean") conferencePending = input.conferencePending;
    }
    return json({ insertCount, events: [...events.values()], busy: busyOverride, conferencePending });
  }
  if (url.pathname === "/authorize") {
    const params = url.searchParams
      .toString()
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<html lang="en"><body><h1>Simulated Google consent</h1><p>This fixture does not connect a real Google account.</p><a href="/consent?${params}&amp;mode=allow">Allow test calendar</a><br><a href="/consent?${params}&amp;mode=deny">Deny test calendar</a><br><a href="/consent?${params}&amp;mode=partial">Allow incomplete permissions</a></body></html>`,
    );
    return;
  }
  if (url.pathname === "/consent") {
    const callback = new URL(url.searchParams.get("redirect_uri"));
    if (callback.origin !== "http://127.0.0.1:3100") return json({}, 400);
    callback.searchParams.set("state", url.searchParams.get("state"));
    if (url.searchParams.get("mode") === "deny")
      callback.searchParams.set("error", "access_denied");
    else {
      const code = randomUUID();
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge"),
        partial: url.searchParams.get("mode") === "partial",
        scopes: url.searchParams.get("scope") || scopes,
      });
      callback.searchParams.set("code", code);
    }
    response.writeHead(303, { Location: callback.toString() });
    response.end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (url.pathname === "/token") {
    const input = new URLSearchParams(raw);
    const code = input.get("code"),
      attempt = codes.get(code);
    if (
      !attempt ||
      createHash("sha256")
        .update(input.get("code_verifier") || "")
        .digest("base64url") !== attempt.challenge
    )
      return json({ error: "invalid_grant" }, 400);
    codes.delete(code);
    const access = randomUUID(),
      refresh = randomUUID();
    grants.set(access, { refresh, scopes: attempt.partial ? "openid email" : attempt.scopes });
    return json({
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      token_type: "Bearer",
      scope: attempt.partial ? "openid email" : attempt.scopes,
    });
  }
  if (url.pathname === "/revoke") {
    const refresh = new URLSearchParams(raw).get("token");
    for (const [access, grant] of grants)
      if (grant.refresh === refresh) grants.delete(access);
    return json({});
  }
  const access = request.headers.authorization?.replace("Bearer ", "");
  if (!grants.has(access)) return json({ error: "invalid_grant" }, 401);
  if (/^\/calendars\/[^/]+\/events(?:\/[^/]+)?$/.test(url.pathname)) {
    if (!grants.get(access).scopes.includes("https://www.googleapis.com/auth/calendar.events.owned")) return json({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403);
    const segments = url.pathname.split("/");
    const calendarId = decodeURIComponent(segments[2]);
    const represent = (event) => ({
      ...event,
      ...(event.conferenceData ? { conferenceData: {
        createRequest: { ...event.conferenceData.createRequest, status: { statusCode: conferencePending ? "pending" : "success" } },
        ...(!conferencePending ? { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/fixture-only-demo" }] } : {}),
      } } : {}),
    });
    if (request.method === "GET") {
      const value = events.get(`${calendarId}:${segments[4]}`);
      return value ? json(represent(value)) : json({}, 404);
    }
    if (request.method === "POST") {
      const input = JSON.parse(raw);
      const key = `${calendarId}:${input.id}`;
      if (events.has(key)) return json({}, 409);
      if (url.searchParams.get("sendUpdates") !== "all" || url.searchParams.get("conferenceDataVersion") !== "1") return json({}, 400);
      const event = { ...input, status: "confirmed", htmlLink: `https://calendar.google.com/calendar/event?eid=fixture-${input.id}` };
      events.set(key, event); insertCount++;
      return json(represent(event));
    }
    return json({}, 405);
  }
  if (url.pathname === "/userinfo")
    return json({
      sub: "test-alex-subject",
      email: "alex.calendar@example.test",
      email_verified: true,
    });
  if (url.pathname === "/calendars")
    return json({
      items: [
        {
          id: "primary@example.test",
          summary: "Personal calendar",
          primary: true,
          timeZone: "America/Los_Angeles",
        },
        {
          id: "work@example.test",
          summary:
            "Work calendar with a deliberately long name for mobile layout verification",
          timeZone: "America/Los_Angeles",
        },
        {
          id: "unavailable@example.test",
          summary: "Unavailable calendar (test fixture)",
          timeZone: "America/Los_Angeles",
        },
      ],
    });
  if (url.pathname === "/freebusy") {
    const input = JSON.parse(raw);
    return json({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      calendars: Object.fromEntries(
        input.items.map(({ id }) => [
          id,
          id === "unavailable@example.test"
            ? { errors: [{ reason: "notFound" }] }
            : {
                busy: [...(busyOverride ?? [
                  {
                    start: "2026-10-25T09:00:00-07:00",
                    end: "2026-10-25T10:00:00-07:00",
                  },
                ]), ...[...events.values()].map((event) => ({ start: event.start.dateTime, end: event.end.dateTime }))],
              },
        ]),
      ),
    });
  }
  json({}, 404);
});
server.listen(3102, "127.0.0.1");
