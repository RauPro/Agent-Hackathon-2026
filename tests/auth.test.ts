import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { authRequestSchema, LOGIN_MAX_AGE } from "../src/lib/domain/auth";
import {
  deleteAccount,
  requestSignInCode,
  SignInUnavailable,
  verifySignIn,
} from "../src/lib/server/auth-service";
import * as storeModule from "../src/lib/server/store";
import { POST } from "../src/app/api/auth/route";
import { SESSION_COOKIE } from "../src/lib/server/http";
import {
  AccountConflict,
  AuthCodeInvalid,
  AuthRateLimit,
  ContextStore,
  UsageLimit,
} from "../src/lib/server/store";
import { draftFromContext } from "../src/lib/domain/onboarding-chat";
import { validContext } from "./fixtures";
import {
  openCalendarData,
  sealCalendarData,
} from "../src/lib/server/calendar-crypto";
let folder: string, path: string, store: ContextStore;
async function authenticate(
  target: ContextStore,
  input: { action: "continue"; email: string } | { action: "logout" },
  previousToken?: string,
) {
  if (input.action === "logout") {
    await target.logout(previousToken);
    return null;
  }
  const { devCode } = await requestSignInCode(target, input.email, previousToken);
  return verifySignIn(target, input.email, devCode!, previousToken);
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sidekick-auth-"));
  path = join(folder, "test.sqlite");
  store = new ContextStore(path);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", "c".repeat(64));
});
afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("email accounts", () => {
  it("validates email, normalizes case, and rejects passwords or client-supplied ownership", () => {
    expect(
      authRequestSchema.parse({
        action: "request_code",
        email: " Alex@Example.Test ",
      }),
    ).toMatchObject({ email: "alex@example.test" });
    expect(
      authRequestSchema.safeParse({
        action: "request_code",
        email: "invalid",
      }).success,
    ).toBe(false);
    for (const extra of [
      { password: "unused" },
      { userId: "someone-else" },
      { profileId: "someone-else" },
      { emailVerified: true },
    ])
      expect(
        authRequestSchema.safeParse({
          action: "request_code",
          email: "alex@example.test",
          ...extra,
        }).success,
      ).toBe(false);
  });
  it("claims the current draft and calendar for a new account and invalidates the anonymous cookie", async () => {
    const previous = (await store.ensureSession()).token;
    await store.commitChat(
      previous,
      {
        action: "message",
        revision: 0,
        message: "My profile",
        requestId: randomUUID(),
      },
      { reply: "Ready to review.", profileGaps: [], draft: draftFromContext(validContext()) },
    );
    await store.commitChat(previous, {
      action: "confirm",
      revision: 1,
      requestId: randomUUID(),
    });
    const owner = await store.calendarOwner(previous);
    await store.writeCalendar(previous, 0, {
      subject: "google-id",
      email: "calendar@example.test",
      encryptedTokens: sealCalendarData({ accessToken: "test-token" }, owner),
      calendars: [],
      selectedIds: [],
      snapshot: null,
      issue: null,
    });
    const result = (await authenticate(
      store,
      { action: "continue", email: "Alex@Example.Test" },
      previous,
    ))!;
    expect(result.account).toMatchObject({
      email: "alex@example.test",
      emailVerified: true,
    });
    expect(await store.read(previous)).toBeNull();
    expect(await store.account(previous)).toBeNull();
    expect((await store.readChat(result.token)).confirmed).toBe(true);
    expect((await store.read(result.token))?.context?.profile.name).toBe(
      "Alex Rivera",
    );
    expect(
      openCalendarData(
        (await store.readCalendar(result.token)).connection!.encryptedTokens,
        await store.calendarOwner(result.token),
      ),
    ).toEqual({ accessToken: "test-token" });
    expect(JSON.stringify(result.account)).not.toMatch(
      /password|profile_id|token/,
    );
    store.close();
    store = new ContextStore(path);
    expect((await store.account(result.token))?.id).toBe(result.account.id);
    const login = (await authenticate(store, {
      action: "continue",
      email: "alex@example.test",
    }))!;
    expect(await store.readChat(login.token)).toEqual(
      await store.readChat(result.token),
    );
    expect(await store.readCalendar(login.token)).toEqual(
      await store.readCalendar(result.token),
    );
  });
  it("deduplicates case-insensitive email and never overwrites an existing account", async () => {
    const a = (await authenticate(store, {
      action: "continue",
      email: "alex@example.test",
    }))!;
    await store.save(a.token, {
      context: validContext(),
      baseRevision: 0,
      requestId: randomUUID(),
    });
    const login = (await authenticate(store, {
      action: "continue",
      email: " ALEX@example.test ",
    }))!;
    expect(login.account.id).toBe(a.account.id);
    expect((await store.read(login.token))?.context?.profile.name).toBe(
      "Alex Rivera",
    );
    expect(await store.db.prepare("SELECT COUNT(*) AS count FROM users").get())
      .toEqual({ count: 1 });
  });
  it("keeps different users isolated and does not merge an anonymous draft on sign-in", async () => {
    const legacyHash = `scrypt-v1$${"a".repeat(32)}$${"b".repeat(128)}`;
    const a = await store.registerAccount(
      "a@example.test",
      legacyHash,
    );
    const b = await store.registerAccount("b@example.test", "unused-test-hash");
    await store.save(a.token, {
      context: validContext(),
      baseRevision: 0,
      requestId: randomUUID(),
    });
    const anonymous = (await store.ensureSession()).token;
    const otherProfile = validContext();
    otherProfile.profile.name = "Do not merge";
    await store.save(anonymous, {
      context: otherProfile,
      baseRevision: 0,
      requestId: randomUUID(),
    });
    const login = (await authenticate(
      store,
      { action: "continue", email: "a@example.test" },
      anonymous,
    ))!;
    expect((await store.read(login.token))?.context?.profile.name).toBe(
      "Alex Rivera",
    );
    expect((await store.read(b.token))?.context).toBeNull();
    expect((await store.account(b.token))?.id).not.toBe(a.account.id);
    expect(login.account.id).toBe(a.account.id);
    expect((await store.read(anonymous))?.context?.profile.name).toBe("Do not merge");
    expect(await store.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(a.account.id))
      .toEqual({ password_hash: legacyHash });
  });
  it("atomically restores one account across concurrent requests and independent clients", async () => {
    const otherStore = new ContextStore(path);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          (index % 2 ? otherStore : store).continueAccount("alex@example.test", undefined, true),
        ),
      );
      expect(new Set(results.map((result) => result!.account.id)).size).toBe(1);
      expect(new Set(results.map((result) => result!.token)).size).toBe(6);
      expect(await store.db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(await store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    } finally {
      otherStore.close();
    }
  });
  it("requires signing out before switching accounts and never claims another account's profile", async () => {
    const a = (await authenticate(store, { action: "continue", email: "a@example.test" }))!;
    await store.save(a.token, {
      context: validContext(),
      baseRevision: 0,
      requestId: randomUUID(),
    });
    await expect(authenticate(store, { action: "continue", email: "b@example.test" }, a.token))
      .rejects.toBeInstanceOf(AccountConflict);
    expect((await store.account(a.token))?.id).toBe(a.account.id);
    expect(await store.db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
    await authenticate(store, { action: "logout" }, a.token);
    const b = (await authenticate(store, { action: "continue", email: "b@example.test" }, a.token))!;
    expect(b.account.id).not.toBe(a.account.id);
    expect((await store.read(b.token))?.context).toBeNull();
    const restored = (await authenticate(store, { action: "continue", email: "a@example.test" }))!;
    expect((await store.read(restored.token))?.context?.profile.name).toBe("Alex Rivera");
  });
  it("revokes only the signing-out browser and enforces server-side expiry", async () => {
    const user = await store.registerAccount(
      "alex@example.test",
      "unused-test-hash",
    );
    const other = await store.createLogin(user.account.id);
    await expect(
      store.requireAccount(other, "different-account"),
    ).rejects.toThrow();
    await store.logout(user.token);
    expect(await store.account(user.token)).toBeNull();
    expect(await store.read(user.token)).toBeNull();
    expect((await store.account(other))?.id).toBe(user.account.id);
    const expired = await store.createLogin(
      user.account.id,
      Date.now() - (LOGIN_MAX_AGE + 1) * 1000,
    );
    expect(await store.account(expired)).toBeNull();
    expect(await store.read(expired)).toBeNull();
  });
  it("binds OAuth to the initiating browser while calendar data stays with the account", async () => {
    const user = await store.registerAccount(
      "alex@example.test",
      "unused-test-hash",
    );
    const other = await store.createLogin(user.account.id);
    await store.startCalendarOAuth(user.token, "test-state", "encrypted");
    await expect(
      store.consumeCalendarOAuth(other, "test-state"),
    ).rejects.toThrow("invalid_state");
    await store.consumeCalendarOAuth(user.token, "test-state");
    const owner = await store.calendarOwner(user.token);
    const rotated = await store.connectCalendar(user.token, 0, (nextOwner) => ({
      subject: "google-id",
      email: "calendar@example.test",
      encryptedTokens: sealCalendarData({ value: "test" }, nextOwner),
      calendars: [],
      selectedIds: [],
      snapshot: null,
      issue: null,
    }));
    expect(await store.account(user.token)).toBeNull();
    expect((await store.account(rotated))?.id).toBe(user.account.id);
    expect(await store.calendarOwner(rotated)).toBe(owner);
    expect(await store.readCalendar(other)).toEqual(
      await store.readCalendar(rotated),
    );
    expect(
      openCalendarData(
        (await store.readCalendar(other)).connection!.encryptedTokens,
        owner,
      ),
    ).toEqual({ value: "test" });
    expect((await store.account(rotated))?.emailVerified).toBe(false);
  });
  it("persists auth throttling across restarts and allows retry after expiry", async () => {
    const now = Date.now();
    for (let n = 0; n < 10; n++)
      await store.reserveAuthAttempt("alex@example.test", now);
    store.close();
    store = new ContextStore(path);
    await expect(
      store.reserveAuthAttempt("ALEX@example.test", now),
    ).rejects.toThrow(AuthRateLimit);
    await expect(
      store.reserveAuthAttempt("alex@example.test", now + 900001),
    ).resolves.toBeUndefined();
  });
  it("counts successful email access against the persistent per-email and global limits", async () => {
    for (let n = 0; n < 10; n++)
      await authenticate(store, { action: "continue", email: "alex@example.test" });
    store.close();
    store = new ContextStore(path);
    await expect(authenticate(store, { action: "continue", email: " ALEX@example.test " }))
      .rejects.toBeInstanceOf(AuthRateLimit);
    expect(await store.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get())
      .toEqual({ count: 10 });
    await store.db.prepare("UPDATE auth_limits SET attempts = 200 WHERE key = 'global'").run();
    await expect(authenticate(store, { action: "continue", email: "new@example.test" }))
      .rejects.toBeInstanceOf(AuthRateLimit);
    expect(await store.db.prepare("SELECT COUNT(*) AS count FROM users").get())
      .toEqual({ count: 1 });
  });
  it("enforces same-origin and strict payloads, sets a private cookie only after a valid code, and rejects stale account logout", async () => {
    vi.spyOn(storeModule, "getStore").mockReturnValue(store);
    const request = (body: unknown, headers: Record<string, string> = {}) =>
      new NextRequest("https://sidekick.example.test/api/auth", {
        method: "POST",
        headers: {
          host: "sidekick.example.test",
          origin: "https://sidekick.example.test",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const body = { action: "request_code", email: "alex@example.test" };
    expect((await POST(request(body, { origin: "https://foreign.example.test" }))).status).toBe(403);
    expect((await POST(request(body, { "content-type": "text/plain" }))).status).toBe(415);
    for (const extra of [{ userId: "other" }, { emailVerified: true }, { password: "unused" }])
      expect((await POST(request({ ...body, ...extra }))).status).toBe(400);
    expect((await POST(request({ action: "continue", email: "alex@example.test" }))).status).toBe(400);

    const sent = await POST(request(body));
    expect(sent.status).toBe(200);
    expect(sent.cookies.get(SESSION_COOKIE)).toBeUndefined();
    const { devCode } = await sent.json();
    expect(devCode).toMatch(/^\d{6}$/);
    expect(await store.db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
    const wrong = String((Number(devCode) + 1) % 1_000_000).padStart(6, "0");
    const rejected = await POST(request({ action: "verify", email: "alex@example.test", code: wrong }));
    expect(rejected.status).toBe(400);
    expect(rejected.cookies.get(SESSION_COOKIE)).toBeUndefined();

    const response = await POST(request({ action: "verify", email: "ALEX@example.test", code: devCode }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const cookie = response.cookies.get(SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: LOGIN_MAX_AGE });
    const account = (await response.json()).account;
    expect(account).toMatchObject({ email: "alex@example.test", emailVerified: true });
    expect((await POST(request({ action: "verify", email: "alex@example.test", code: devCode }))).status).toBe(400);
    const sessionHeaders = { cookie: `${SESSION_COOKIE}=${cookie.value}` };
    expect((await POST(request({ ...body, email: "other@example.test" }, sessionHeaders))).status).toBe(409);
    expect((await POST(request({ action: "logout" }, { ...sessionHeaders, "x-sidekick-account": "stale-account" }))).status).toBe(401);
    expect((await store.account(cookie.value))?.id).toBe(account.id);
    const logout = await POST(request({ action: "logout" }, { ...sessionHeaders, "x-sidekick-account": account.id }));
    expect(logout.status).toBe(200);
    expect(logout.cookies.get(SESSION_COOKIE)?.maxAge).toBe(0);
    expect(await store.account(cookie.value)).toBeNull();
  });
  it("returns a retry window when code requests exhaust the limit", async () => {
    vi.spyOn(storeModule, "getStore").mockReturnValue(store);
    for (let n = 0; n < 10; n++)
      await requestSignInCode(store, "alex@example.test");
    const response = await POST(new NextRequest("https://sidekick.example.test/api/auth", {
      method: "POST",
      headers: { host: "sidekick.example.test", origin: "https://sidekick.example.test", "content-type": "application/json" },
      body: JSON.stringify({ action: "request_code", email: "Alex@example.test" }),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
  });
  it("limits code requests per client IP", async () => {
    for (let n = 0; n < 30; n++)
      await requestSignInCode(store, `person-${n}@example.test`, undefined, "203.0.113.9");
    await expect(requestSignInCode(store, "next@example.test", undefined, "203.0.113.9"))
      .rejects.toBeInstanceOf(AuthRateLimit);
    await expect(requestSignInCode(store, "next@example.test", undefined, "203.0.113.10"))
      .resolves.toHaveProperty("devCode");
  });
  it("rejects expired codes and invalidates a code after five wrong attempts", async () => {
    const now = Date.now();
    const expired = await store.issueSignInCode("alex@example.test", now - 11 * 60 * 1000);
    await expect(store.verifySignInCode("alex@example.test", expired, now)).rejects.toBeInstanceOf(AuthCodeInvalid);
    const code = await store.issueSignInCode("alex@example.test", now);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    for (let n = 0; n < 5; n++)
      await expect(store.verifySignInCode("alex@example.test", wrong, now)).rejects.toBeInstanceOf(AuthCodeInvalid);
    await expect(store.verifySignInCode("alex@example.test", code, now)).rejects.toBeInstanceOf(AuthCodeInvalid);
    expect(await store.db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
  });
  it("refuses to send codes in production without an email provider", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    await expect(requestSignInCode(store, "alex@example.test")).rejects.toBeInstanceOf(SignInUnavailable);
    expect(await store.db.prepare("SELECT COUNT(*) AS count FROM auth_codes").get()).toEqual({ count: 0 });
  });
  it("sends production codes by email without returning them", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "re_test_not_a_secret");
    vi.stubEnv("AUTH_EMAIL_FROM", "Sidekick <login@example.test>");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await requestSignInCode(store, "alex@example.test")).toEqual({});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(String(init!.body));
    expect(payload.to).toEqual(["alex@example.test"]);
    const code = payload.subject.slice(0, 6);
    expect((await verifySignIn(store, "alex@example.test", code)).account.emailVerified).toBe(true);
  });
  it("stops accepting sessions that were created before email verification existed", async () => {
    const user = await store.registerAccount("alex@example.test", "unused-test-hash");
    expect((await store.account(user.token))?.id).toBe(user.account.id);
    await store.db.prepare("UPDATE auth_sessions SET verified = 0").run();
    expect(await store.account(user.token)).toBeNull();
    expect(await store.read(user.token)).toBeNull();
  });
  it("deletes an account and every relationship that references it", async () => {
    const a = (await authenticate(store, { action: "continue", email: "a@example.test" }))!;
    const b = (await authenticate(store, { action: "continue", email: "b@example.test" }))!;
    await store.save(a.token, { context: validContext(), baseRevision: 0, requestId: randomUUID() });
    await store.db.prepare(
      "INSERT INTO network_connections (user_a, user_b, requester_id, status, context, source, created_at, updated_at) VALUES (?, ?, ?, 'accepted', '', 'qr', ?, ?)",
    ).run(...[a.account.id, b.account.id].sort(), a.account.id, new Date().toISOString(), new Date().toISOString());
    await deleteAccount(store, a.token);
    expect(await store.account(a.token)).toBeNull();
    for (const table of ["network_connections", "sessions", "auth_codes"])
      expect(await store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: table === "sessions" ? 1 : 0 });
    expect(await store.db.prepare("SELECT email FROM users").all()).toEqual([{ email: "b@example.test" }]);
    expect((await store.account(b.token))?.id).toBe(b.account.id);
    const again = (await authenticate(store, { action: "continue", email: "a@example.test" }))!;
    expect(again.account.id).not.toBe(a.account.id);
    expect((await store.read(again.token))?.context).toBeNull();
  });
  it("enforces daily usage caps, including zero to pause", async () => {
    const now = new Date();
    await store.reserveUsage([{ key: "voice:global", max: 1 }], now);
    await expect(store.reserveUsage([{ key: "voice:global", max: 1 }], now)).rejects.toBeInstanceOf(UsageLimit);
    await expect(store.reserveUsage([{ key: "paused", max: 0 }], now)).rejects.toBeInstanceOf(UsageLimit);
    await expect(
      store.reserveUsage([{ key: "voice:global", max: 1 }], new Date(now.getTime() + 25 * 60 * 60 * 1000)),
    ).resolves.toBeUndefined();
  });
  it("adds account tables to the old database without deleting profile data", async () => {
    store.close();
    const legacyPath = join(folder, "legacy.sqlite");
    const db = new Database(legacyPath);
    db.exec(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, context_json TEXT, confirmed_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE calendar_oauth_states (state_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(token_hash), encrypted_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL, base_revision INTEGER NOT NULL);`);
    const token = "a".repeat(64);
    db.prepare(
      "INSERT INTO sessions (token_hash, revision, context_json, confirmed_at, created_at) VALUES (?, 1, ?, ?, ?)",
    ).run(
      createHash("sha256").update(token).digest("hex"),
      JSON.stringify(validContext()),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
    store = new ContextStore(legacyPath);
    const registered = await store.registerAccount(
      "alex@example.test",
      "unused-test-hash",
      token,
    );
    expect((await store.read(registered.token))?.context?.profile.name).toBe(
      "Alex Rivera",
    );
    expect(await store.read(token)).toBeNull();
  });
});
