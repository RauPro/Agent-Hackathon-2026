import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { authRequestSchema, LOGIN_MAX_AGE } from "../src/lib/domain/auth";
import {
  authenticate,
  hashPassword,
  InvalidCredentials,
  verifyPassword,
} from "../src/lib/server/auth-service";
import {
  AccountConflict,
  AuthRateLimit,
  ContextStore,
} from "../src/lib/server/store";
import { draftFromContext } from "../src/lib/domain/onboarding-chat";
import { validContext } from "./fixtures";
import {
  openCalendarData,
  sealCalendarData,
} from "../src/lib/server/calendar-crypto";
const password = "A long test passphrase 2026!";
let folder: string, path: string, store: ContextStore;
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
});
describe("email accounts", () => {
  it("validates email/password, normalizes case, and rejects client-supplied ownership", () => {
    expect(
      authRequestSchema.parse({
        action: "register",
        email: " Alex@Example.Test ",
        password,
      }),
    ).toMatchObject({ email: "alex@example.test" });
    expect(
      authRequestSchema.safeParse({
        action: "register",
        email: "invalid",
        password,
      }).success,
    ).toBe(false);
    expect(
      authRequestSchema.safeParse({
        action: "register",
        email: "alex@example.test",
        password: "short",
      }).success,
    ).toBe(false);
    expect(
      authRequestSchema.safeParse({
        action: "register",
        email: "alex@example.test",
        password,
        userId: "someone-else",
      }).success,
    ).toBe(false);
  });
  it("uses salted password hashes, constant-time comparison, and preserves spaces", async () => {
    const a = await hashPassword(password),
      b = await hashPassword(password);
    expect(a).not.toBe(b);
    expect(a).not.toContain(password);
    expect(await verifyPassword(password, a)).toBe(true);
    expect(await verifyPassword(password + " ", a)).toBe(false);
    expect(await verifyPassword(password, "corrupt")).toBe(false);
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
      { reply: "Ready to review.", draft: draftFromContext(validContext()) },
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
      { action: "register", email: "Alex@Example.Test", password },
      previous,
    ))!;
    expect(result.account).toMatchObject({
      email: "alex@example.test",
      emailVerified: false,
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
      action: "login",
      email: "alex@example.test",
      password,
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
      action: "register",
      email: "alex@example.test",
      password,
    }))!;
    await store.save(a.token, {
      context: validContext(),
      baseRevision: 0,
      requestId: randomUUID(),
    });
    await expect(
      authenticate(store, {
        action: "register",
        email: " ALEX@example.test ",
        password: password + "other",
      }),
    ).rejects.toBeInstanceOf(AccountConflict);
    const login = (await authenticate(store, {
      action: "login",
      email: "alex@example.test",
      password,
    }))!;
    expect(login.account.id).toBe(a.account.id);
    expect((await store.read(login.token))?.context?.profile.name).toBe(
      "Alex Rivera",
    );
  });
  it("keeps different users isolated and does not merge an anonymous draft on sign-in", async () => {
    const a = await store.registerAccount(
      "a@example.test",
      await hashPassword(password),
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
      { action: "login", email: "a@example.test", password },
      anonymous,
    ))!;
    expect((await store.read(login.token))?.context?.profile.name).toBe(
      "Alex Rivera",
    );
    expect((await store.read(b.token))?.context).toBeNull();
    expect((await store.account(b.token))?.id).not.toBe(a.account.id);
  });
  it("rejects wrong and unknown credentials with the same error", async () => {
    await authenticate(store, {
      action: "register",
      email: "alex@example.test",
      password,
    });
    await expect(
      authenticate(store, {
        action: "login",
        email: "alex@example.test",
        password: "wrong",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentials);
    await expect(
      authenticate(store, {
        action: "login",
        email: "unknown@example.test",
        password: "wrong",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentials);
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
