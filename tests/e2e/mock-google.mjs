// Test-only Google fixture. No real accounts, events, or credentials are used.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
const codes = new Map();
const grants = new Map();
const scopes =
  "openid email https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:3102");
  const json = (data, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
  };
  if (url.pathname === "/health") return json({});
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
    grants.set(access, { refresh });
    return json({
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      token_type: "Bearer",
      scope: attempt.partial ? "openid email" : scopes,
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
                busy: [
                  {
                    start: "2026-10-25T09:00:00-07:00",
                    end: "2026-10-25T10:00:00-07:00",
                  },
                ],
              },
        ]),
      ),
    });
  }
  json({}, 404);
});
server.listen(3102, "127.0.0.1");
