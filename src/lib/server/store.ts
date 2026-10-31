import { Temporal } from "@js-temporal/polyfill";
import {
  DISCOVERY_LIMITS,
  PROACTIVE_EVENT_LIMITS,
  DiscoveryError,
  discoveryWindow,
  eventHasEnded,
  type Coverage,
  type EventSuggestion,
  type Recommendation,
  type DiscoveryRequest,
  type DiscoveryResult,
  type DiscoveryRow,
  type DiscoveryStatus,
} from "@/lib/domain/event-discovery";
import { canonicalEventUrl } from "@/lib/domain/discovery";
import { AsyncDatabase, type RemoteDatabaseOptions } from "./database";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { NetworkStore } from "./network-store";
import type { CalendarConnection, CalendarRecord } from "@/lib/domain/calendar";
import {
  emailSchema,
  LOGIN_MAX_AGE,
  SIGN_IN_CODE_MAX_ATTEMPTS,
  SIGN_IN_CODE_TTL_MS,
  type Account,
} from "@/lib/domain/auth";
import {
  contextSchema,
  type ContextState,
  type UserContext,
} from "@/lib/domain/context";
import {
  initialChat,
  refreshWelcome,
  modelReplySchema,
  guardProfileReply,
  isStayQuestion,
  validateDraft,
  type ChatRequest,
  type ChatState,
  type ModelReply,
} from "@/lib/domain/onboarding-chat";
type SessionRow = {
  token_hash: string;
  revision: number;
  context_json: string | null;
  confirmed_at: string | null;
};
type EventSuggestionState = {
  lastCheckedAt: string | null;
  revision: number;
  active: (EventSuggestion & { keys: string[]; revision: number }) | null;
  seen: string[];
  lastSuggestedAt: string | null;
  day: string;
  dayCount: number;
};
const eventSuggestionKeys = (event: Recommendation) =>
  [event.url, ...event.alsoListed.map((source) => source.url)]
    .map((url) => `${canonicalEventUrl(url)}|${event.date}`);
const suggestionDay = (now: Date) => Temporal.Instant.from(now.toISOString())
  .toZonedDateTimeISO("America/Los_Angeles");
export class ContextConflict extends Error {
  readonly kind = "context_conflict";
  constructor(
    public code: "stale_revision" | "request_reused" | "profile_changed",
  ) {
    super(code);
  }
}
export class SessionMissing extends Error {
  readonly kind = "session_missing";
}
export class AccountConflict extends Error {
  readonly kind = "account_conflict";
}
export class AuthRateLimit extends Error {
  readonly kind = "auth_rate_limit";
}
export class AuthCodeInvalid extends Error {
  readonly kind = "auth_code_invalid";
}
export class UsageLimit extends Error {
  readonly kind = "usage_limit";
}
export class CalendarConflict extends Error {
  readonly kind = "calendar_conflict";
  constructor(public code: "invalid_state" | "calendar_changed") {
    super(code);
  }
}
type StoreErrors = {
  context_conflict: ContextConflict;
  session_missing: SessionMissing;
  account_conflict: AccountConflict;
  auth_rate_limit: AuthRateLimit;
  auth_code_invalid: AuthCodeInvalid;
  usage_limit: UsageLimit;
  calendar_conflict: CalendarConflict;
};
// Next's page and route bundles can hold different class constructors while
// sharing the same SQLite store. Use stable tags at that boundary.
export function isStoreError<K extends keyof StoreErrors>(
  error: unknown,
  kind: K,
): error is StoreErrors[K] {
  return error instanceof Error && "kind" in error && error.kind === kind;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class ContextStore {
  readonly db: AsyncDatabase;
  readonly network: NetworkStore;
  constructor(source: string | RemoteDatabaseOptions) {
    if (
      process.env.SIDEKICK_DEMO === "1" &&
      typeof source === "string" &&
      !source.endsWith(".demo.sqlite")
    )
      throw new Error(
        "Demo mode requires a separate database ending in .demo.sqlite.",
      );
    this.db = new AsyncDatabase(source);
    this.network = new NetworkStore(this.db);
  }
  private async session(
    token: string | undefined,
  ): Promise<SessionRow | undefined> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    // The legacy sessions table holds profile data; auth_sessions hold browser logins.
    // Once a profile is claimed, its old anonymous token can never read it again.
    return (await this.db
      .prepare(
        `SELECT s.* FROM sessions s
      WHERE s.token_hash = (SELECT u.profile_id FROM users u JOIN auth_sessions a ON a.user_id = u.id WHERE a.token_hash = ? AND a.expires_at > ? AND a.verified = 1)
      OR (s.token_hash = ? AND NOT EXISTS (SELECT 1 FROM users u WHERE u.profile_id = s.token_hash))`,
      )
      .get(hash(token), Date.now(), hash(token))) as SessionRow | undefined;
  }
  async account(
    token: string | undefined,
    now = Date.now(),
  ): Promise<Account | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = (await this.db
      .prepare(
        "SELECT u.id, u.email, u.email_verified_at FROM users u JOIN auth_sessions a ON a.user_id = u.id WHERE a.token_hash = ? AND a.expires_at > ? AND a.verified = 1",
      )
      .get(hash(token), now)) as
      | {
          id: string;
          email: string;
          email_verified_at: string | null;
        }
      | undefined;
    return row
      ? { id: row.id, email: row.email, emailVerified: !!row.email_verified_at }
      : null;
  }
  async requireAccount(
    token: string | undefined,
    expectedId?: string | null,
  ): Promise<Account> {
    const account = await this.account(token);
    if (!account || (expectedId && expectedId !== account.id))
      throw new SessionMissing();
    return account;
  }
  private async userForEmail(email: string) {
    return (await this.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(emailSchema.parse(email))) as
      | {
          id: string;
        }
      | undefined;
  }
  async createLogin(userId: string, now = Date.now()) {
    const token = randomBytes(32).toString("hex");
    await this.db
      .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
      .run(now);
    await this.db
      .prepare(
        "INSERT INTO auth_sessions (token_hash, user_id, expires_at, verified) VALUES (?, ?, ?, 1)",
      )
      .run(hash(token), userId, now + LOGIN_MAX_AGE * 1000);
    return token;
  }
  // Callers must have verified email ownership first (see verifySignInCode).
  async continueAccount(
    email: string,
    previousToken?: string,
    verified = false,
  ) {
    email = emailSchema.parse(email);
    return await this.db
      .transaction(async () => {
        if (await this.account(previousToken)) throw new AccountConflict();
        const existing = await this.userForEmail(email);
        if (verified)
          await this.db
            .prepare(
              "UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?",
            )
            .run(new Date().toISOString(), email);
        if (existing) {
          const token = await this.createLogin(existing.id);
          return { token, account: await this.requireAccount(token) };
        }
        // Retain the legacy column without storing a usable password credential.
        const created = await this.registerAccount(
          email,
          "email-code",
          previousToken,
        );
        if (!verified) return created;
        await this.db
          .prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
          .run(new Date().toISOString(), created.account.id);
        return {
          token: created.token,
          account: await this.requireAccount(created.token),
        };
      })
      .immediate();
  }
  async issueSignInCode(email: string, now = Date.now()) {
    email = emailSchema.parse(email);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    await this.db
      .prepare(
        `INSERT INTO auth_codes (email_hash, code_hash, salt, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(email_hash) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt,
         expires_at = excluded.expires_at, attempts = 0`,
      )
      .run(hash(email), hash(`${salt}:${code}`), salt, now + SIGN_IN_CODE_TTL_MS);
    return code;
  }
  async verifySignInCode(email: string, code: string, now = Date.now()) {
    email = emailSchema.parse(email);
    const valid = await this.db
      .transaction(async () => {
        const key = hash(email);
        const row = (await this.db
          .prepare(
            "SELECT code_hash, salt, expires_at, attempts FROM auth_codes WHERE email_hash = ?",
          )
          .get(key)) as
          | { code_hash: string; salt: string; expires_at: number; attempts: number }
          | undefined;
        if (!row || row.expires_at <= now || row.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS) {
          if (row)
            await this.db.prepare("DELETE FROM auth_codes WHERE email_hash = ?").run(key);
          return false;
        }
        const matches = timingSafeEqual(
          Buffer.from(row.code_hash, "hex"),
          Buffer.from(hash(`${row.salt}:${code}`), "hex"),
        );
        if (matches)
          await this.db.prepare("DELETE FROM auth_codes WHERE email_hash = ?").run(key);
        else
          await this.db
            .prepare("UPDATE auth_codes SET attempts = attempts + 1 WHERE email_hash = ?")
            .run(key);
        return matches;
      })
      .immediate();
    if (!valid) throw new AuthCodeInvalid();
  }
  // Counts paid or abusable work per SF day. Limits of 0 pause that work entirely.
  async reserveUsage(
    limits: { key: string; max: number }[],
    now = new Date(),
  ) {
    const day = suggestionDay(now).toPlainDate().toString();
    const expires = now.getTime() + 2 * 24 * 60 * 60 * 1000;
    await this.db
      .transaction(async () => {
        for (const limit of limits) {
          const row = (await this.db
            .prepare("SELECT attempts FROM auth_limits WHERE key = ?")
            .get(`usage:${day}:${limit.key}`)) as { attempts: number } | undefined;
          if ((row?.attempts ?? 0) >= limit.max) throw new UsageLimit();
        }
        for (const limit of limits)
          await this.db
            .prepare(
              "INSERT INTO auth_limits (key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1",
            )
            .run(`usage:${day}:${limit.key}`, expires);
      })
      .immediate();
  }
  async deleteAccount(userId: string) {
    await this.db
      .transaction(async () => {
        const user = (await this.db
          .prepare("SELECT profile_id FROM users WHERE id = ?")
          .get(userId)) as { profile_id: string } | undefined;
        if (!user) return;
        const profile = user.profile_id;
        const statements: [string, unknown[]][] = [
          ["DELETE FROM meetings WHERE initiator_id = ? OR first_user_id = ? OR second_user_id = ?", [userId, userId, userId]],
          ["DELETE FROM network_opportunities WHERE user_a = ? OR user_b = ?", [userId, userId]],
          ["DELETE FROM network_events WHERE user_id = ?", [userId]],
          ["DELETE FROM network_pair_checks WHERE user_a = ? OR user_b = ?", [userId, userId]],
          ["DELETE FROM network_jobs WHERE user_id = ?", [userId]],
          ["DELETE FROM agent_dialogues WHERE user_a = ? OR user_b = ?", [userId, userId]],
          ["DELETE FROM agent_messages WHERE from_user_id = ? OR to_user_id = ?", [userId, userId]],
          ["DELETE FROM network_blocks WHERE user_id = ? OR blocked_user_id = ?", [userId, userId]],
          ["DELETE FROM network_connections WHERE user_a = ? OR user_b = ? OR requester_id = ?", [userId, userId, userId]],
          ["DELETE FROM network_settings WHERE user_id = ?", [userId]],
          ["DELETE FROM auth_sessions WHERE user_id = ?", [userId]],
          ["DELETE FROM users WHERE id = ?", [userId]],
          ["DELETE FROM calendar_oauth_states WHERE session_id = ?", [profile]],
          ["DELETE FROM calendar_connections WHERE session_id = ?", [profile]],
          ["DELETE FROM onboarding_chats WHERE session_id = ?", [profile]],
          ["DELETE FROM event_discoveries WHERE owner_id = ?", [profile]],
          ["DELETE FROM runs WHERE session_id = ?", [profile]],
          ["DELETE FROM sessions WHERE token_hash = ?", [profile]],
        ];
        for (const [sql, args] of statements)
          await this.db.prepare(sql).run(...args);
      })
      .immediate();
  }
  async registerAccount(
    email: string,
    passwordHash: string,
    previousToken?: string,
  ) {
    email = emailSchema.parse(email);
    return await this.db
      .transaction(async () => {
        if (
          (await this.userForEmail(email)) ||
          (await this.account(previousToken))
        )
          throw new AccountConflict();
        const profile = await this.ensureSession(previousToken);
        const profileId = (await this.session(profile.token))!.token_hash;
        const id = randomUUID();
        await this.db
          .prepare(
            "INSERT INTO users (id, email, password_hash, profile_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, email, passwordHash, profileId, new Date().toISOString());
        await this.db
          .prepare("DELETE FROM calendar_oauth_states WHERE session_id = ?")
          .run(profileId);
        const token = await this.createLogin(id);
        return { token, account: await this.requireAccount(token) };
      })
      .immediate();
  }
  async logout(token: string | undefined) {
    if (!token) return;
    await this.db
      .transaction(async () => {
        await this.db
          .prepare(
            "DELETE FROM calendar_oauth_states WHERE browser_token_hash = ?",
          )
          .run(hash(token));
        await this.db
          .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
          .run(hash(token));
      })
      .immediate();
  }
  async reserveAuthAttempt(email: string, now = Date.now(), ip?: string) {
    await this.db
      .transaction(async () => {
        await this.db
          .prepare("DELETE FROM auth_limits WHERE expires_at <= ?")
          .run(now);
        const limits = [
          { key: `email:${hash(emailSchema.parse(email))}`, max: 10 },
          { key: "global", max: 200 },
          ...(ip ? [{ key: `ip:${hash(ip)}`, max: 30 }] : []),
        ];
        for (const limit of limits) {
          const row = (await this.db
            .prepare("SELECT attempts FROM auth_limits WHERE key = ?")
            .get(limit.key)) as
            | {
                attempts: number;
              }
            | undefined;
          if ((row?.attempts ?? 0) >= limit.max) throw new AuthRateLimit();
        }
        for (const limit of limits)
          await this.db
            .prepare(
              "INSERT INTO auth_limits (key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1",
            )
            .run(limit.key, now + 15 * 60 * 1000);
      })
      .immediate();
  }
  private state(row: SessionRow): ContextState {
    return {
      context: row.context_json
        ? contextSchema.parse(JSON.parse(row.context_json))
        : null,
      revision: row.revision,
      confirmedAt: row.confirmed_at,
      evidenceKind: row.context_json ? "user_report" : null,
    };
  }
  async ensureSession(token?: string): Promise<{
    token: string;
    state: ContextState;
    created: boolean;
  }> {
    const existing = await this.session(token);
    if (existing && token)
      return { token, state: this.state(existing), created: false };
    const nextToken = randomBytes(32).toString("hex");
    await this.db
      .prepare("INSERT INTO sessions (token_hash, created_at) VALUES (?, ?)")
      .run(hash(nextToken), new Date().toISOString());
    return {
      token: nextToken,
      state: (await this.read(nextToken))!,
      created: true,
    };
  }
  async read(token?: string): Promise<ContextState | null> {
    const row = await this.session(token);
    return row ? this.state(row) : null;
  }
  async save(
    token: string | undefined,
    input: {
      context: UserContext;
      baseRevision: number;
      requestId: string;
    },
  ): Promise<ContextState> {
    const context = contextSchema.parse(input.context);
    const serialized = JSON.stringify(context);
    const payloadHash = hash(
      JSON.stringify({ context, baseRevision: input.baseRevision }),
    );
    return await this.db
      .transaction(async () => {
        const current = await this.session(token);
        if (!current) throw new SessionMissing();
        const prior = (await this.db
          .prepare(
            "SELECT payload_hash, result_json FROM runs WHERE session_id = ? AND operation_key = ?",
          )
          .get(current.token_hash, input.requestId)) as
          | {
              payload_hash: string;
              result_json: string;
            }
          | undefined;
        if (prior) {
          if (prior.payload_hash !== payloadHash)
            throw new ContextConflict("request_reused");
          return JSON.parse(prior.result_json) as ContextState;
        }
        if (current.revision !== input.baseRevision)
          throw new ContextConflict("stale_revision");
        const unchanged = current.context_json === serialized;
        const confirmedAt = unchanged
          ? current.confirmed_at!
          : new Date().toISOString();
        const revision = current.revision + (unchanged ? 0 : 1);
        const state: ContextState = {
          context,
          revision,
          confirmedAt,
          evidenceKind: "user_report",
        };
        await this.db
          .prepare(
            "UPDATE sessions SET context_json = ?, revision = ?, confirmed_at = ? WHERE token_hash = ?",
          )
          .run(serialized, revision, confirmedAt, current.token_hash);
        if (!unchanged) {
          const user = (await this.db
            .prepare("SELECT id FROM users WHERE profile_id = ?")
            .get(current.token_hash)) as
            | {
                id: string;
              }
            | undefined;
          if (user) await this.network.enqueue(user.id);
        }
        await this.db
          .prepare(
            "INSERT INTO runs (id, session_id, operation_key, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            current.token_hash,
            input.requestId,
            payloadHash,
            JSON.stringify(state),
            new Date().toISOString(),
          );
        return state;
      })
      .immediate();
  }
  async readChat(token: string | undefined): Promise<ChatState> {
    const session = await this.session(token);
    if (!session) throw new SessionMissing();
    const existing = (await this.db
      .prepare("SELECT state_json FROM onboarding_chats WHERE session_id = ?")
      .get(session.token_hash)) as
      | {
          state_json: string;
        }
      | undefined;
    if (existing)
      return refreshWelcome(JSON.parse(existing.state_json) as ChatState);
    const chat = initialChat(this.state(session));
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO onboarding_chats (session_id, state_json) VALUES (?, ?)",
      )
      .run(session.token_hash, JSON.stringify(chat));
    // A second request may have initialized or advanced this chat while we awaited I/O.
    const saved = (await this.db
      .prepare("SELECT state_json FROM onboarding_chats WHERE session_id = ?")
      .get(session.token_hash)) as { state_json: string };
    return refreshWelcome(JSON.parse(saved.state_json) as ChatState);
  }
  async cachedChat(
    token: string | undefined,
    request: ChatRequest,
  ): Promise<ChatState | null> {
    const session = await this.session(token);
    if (!session) throw new SessionMissing();
    const prior = (await this.db
      .prepare(
        "SELECT payload_hash, result_json FROM runs WHERE session_id = ? AND operation_key = ?",
      )
      .get(session.token_hash, `chat:${request.requestId}`)) as
      | {
          payload_hash: string;
          result_json: string;
        }
      | undefined;
    if (!prior) return null;
    if (prior.payload_hash !== hash(JSON.stringify(request)))
      throw new ContextConflict("request_reused");
    return refreshWelcome(JSON.parse(prior.result_json) as ChatState);
  }
  async checkChat(
    token: string | undefined,
    request: ChatRequest,
  ): Promise<ChatState> {
    const chat = await this.readChat(token);
    if (chat.revision !== request.revision)
      throw new ContextConflict("stale_revision");
    if (
      request.action !== "reload_saved" &&
      (await this.read(token))!.revision !== chat.baseRevision
    )
      throw new ContextConflict("profile_changed");
    return chat;
  }
  async commitChat(
    token: string | undefined,
    request: ChatRequest,
    reply?: ModelReply,
  ): Promise<ChatState> {
    return await this.db
      .transaction(async () => {
        const cached = await this.cachedChat(token, request);
        if (cached) return cached;
        const current = await this.checkChat(token, request);
        let next: ChatState;
        if (request.action === "message") {
          const parsed = guardProfileReply(modelReplySchema.parse(reply), current);
          next = {
            ...current,
            revision: current.revision + 1,
            confirmed:
              current.confirmed &&
              !parsed.profileGaps.length &&
              JSON.stringify(parsed.draft) === JSON.stringify(current.draft),
            draft: parsed.draft,
            profileGaps: parsed.profileGaps,
            stayQuestionAsked: current.stayQuestionAsked || isStayQuestion(parsed.reply) ||
              parsed.draft.stay?.status === "declined" || !!parsed.draft.stay?.area || !!parsed.draft.stay?.hotel,
            messages: [
              ...current.messages,
              { id: request.requestId, role: "user", content: request.message },
              { id: randomUUID(), role: "assistant", content: parsed.reply },
            ],
          };
        } else if (request.action === "confirm") {
          const profile = validateDraft(current.draft, current.profileGaps);
          if (!profile.success) throw new Error("draft_incomplete");
          const saved = await this.save(token, {
            context: profile.data,
            baseRevision: current.baseRevision,
            requestId: `chat-confirm:${request.requestId}`,
          });
          next = {
            ...current,
            revision: current.revision + 1,
            baseRevision: saved.revision,
            confirmed: true,
          };
        } else {
          next = {
            ...initialChat((await this.read(token))!),
            revision: current.revision + 1,
          };
        }
        const sessionId = (await this.session(token))!.token_hash;
        await this.db
          .prepare(
            "UPDATE onboarding_chats SET state_json = ? WHERE session_id = ?",
          )
          .run(JSON.stringify(next), sessionId);
        await this.db
          .prepare(
            "INSERT INTO runs (id, session_id, operation_key, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            sessionId,
            `chat:${request.requestId}`,
            hash(JSON.stringify(request)),
            JSON.stringify(next),
            new Date().toISOString(),
          );
        return next;
      })
      .immediate();
  }
  async calendarOwner(token: string | undefined) {
    const session = await this.session(token);
    if (!session) throw new SessionMissing();
    return session.token_hash;
  }
  async discoveryCounts(owner: string, revision: number, now: Date) {
    // Keep the existing operation ledger when pruning discovery snapshots, so
    // changing revisions cannot reset the rolling per-owner spend limit.
    return (await this.db
      .prepare(
        `SELECT COUNT(*) AS owner,
      COALESCE(SUM(CASE WHEN payload_hash = ? THEN 1 ELSE 0 END), 0) AS revision
      FROM runs WHERE session_id = ? AND operation_key LIKE 'discovery:%' AND created_at > ?`,
      )
      .get(
        String(revision),
        owner,
        new Date(now.getTime() - DISCOVERY_LIMITS.dayMs).toISOString(),
      )) as {
      owner: number;
      revision: number;
    };
  }

  async discoveryDailyUsage(now: Date) {
    const configured = process.env.DISCOVERY_DAILY_RUN_LIMIT;
    const limit =
      configured &&
      /^\d+$/.test(configured) &&
      Number.isSafeInteger(Number(configured))
        ? Number(configured)
        : 100;
    const start = Temporal.Instant.from(now.toISOString())
      .toZonedDateTimeISO("America/Los_Angeles")
      .startOfDay()
      .toInstant()
      .toString({ fractionalSecondDigits: 3 });
    const { used } = (await this.db
      .prepare(
        "SELECT COUNT(*) AS used FROM runs WHERE operation_key LIKE 'discovery:%' AND created_at >= ?",
      )
      .get(start)) as {
      used: number;
    };
    return { used, limit, reached: used >= limit };
  }

  async readDiscovery(
    token: string | undefined,
    now: Date,
  ): Promise<DiscoveryRow | null> {
    return this.readDiscoveryForOwner(await this.calendarOwner(token), now);
  }

  // Trusted server jobs use a persisted profile owner, never a fabricated login.
  async discoveryProfile(owner: string) {
    const row = (await this.db.prepare(
      `SELECT s.*, c.state_json FROM sessions s
       LEFT JOIN onboarding_chats c ON c.session_id = s.token_hash
       WHERE s.token_hash = ?`,
    ).get(owner)) as (SessionRow & { state_json: string | null }) | undefined;
    if (!row) throw new SessionMissing();
    const state = this.state(row);
    const chat = row.state_json ? JSON.parse(row.state_json) as ChatState : initialChat(state);
    return { state, confirmed: !!row.confirmed_at && chat.confirmed && chat.baseRevision === row.revision };
  }

  async readDiscoveryForOwner(owner: string, now: Date): Promise<DiscoveryRow | null> {
    const { state } = await this.discoveryProfile(owner);
    await this.db
      .prepare(
        `UPDATE event_discoveries SET status = 'failed', error_code = 'interrupted', finished_at = ?, lease_expires_at = NULL
      WHERE owner_id = ? AND status = 'running' AND lease_expires_at <= ?`,
      )
      .run(now.toISOString(), owner, now.getTime());
    return (
      ((await this.db
        .prepare(
          "SELECT * FROM event_discoveries WHERE owner_id = ? AND profile_revision = ?",
        )
        .get(owner, state.revision)) as
        | DiscoveryRow
        | undefined) ?? null
    );
  }

  async discoveryCoverage(
    owner: string,
    runId: string,
  ): Promise<Coverage | null> {
    const row = (await this.db
      .prepare(
        "SELECT result_json FROM runs WHERE id = ? AND session_id = ? AND operation_key LIKE 'discovery:%'",
      )
      .get(runId, owner)) as
      | {
          result_json: string;
        }
      | undefined;
    return row ? (JSON.parse(row.result_json).coverage ?? null) : null;
  }

  async claimDiscovery(
    token: string | undefined,
    request: DiscoveryRequest,
    now: Date,
    capacity: boolean,
  ) {
    return this.claimDiscoveryForOwner(await this.calendarOwner(token), request, now, capacity);
  }

  async claimDiscoveryForOwner(
    owner: string,
    request: DiscoveryRequest,
    now: Date,
    capacity: boolean,
    requireConfirmed = false,
  ) {
    return await this.db
      .transaction(async () => {
        const { state, confirmed } = await this.discoveryProfile(owner);
        if (!state.context) throw new DiscoveryError("profile_missing");
        if (requireConfirmed && !confirmed) throw new DiscoveryError("profile_changed");
        if (request.revision !== state.revision)
          throw new DiscoveryError("profile_changed");
        if (!discoveryWindow(state.context, now))
          throw new DiscoveryError("trip_past");
        const existing = await this.readDiscoveryForOwner(owner, now);
        const repeated = await this.db
          .prepare(
            "SELECT id FROM runs WHERE session_id = ? AND operation_key = ?",
          )
          .get(owner, `discovery:${request.requestId}`);
        if (
          existing &&
          (repeated ||
            existing.status === "running" ||
            (request.action === "start" && existing.status !== "failed"))
        )
          return {
            claimed: false as const,
            row: existing,
            owner,
            context: state.context,
          };
        if (repeated) throw new DiscoveryError("profile_changed");
        const counts = await this.discoveryCounts(owner, state.revision, now);
        if ((await this.discoveryDailyUsage(now)).reached)
          throw new DiscoveryError("daily_limit");
        if (
          counts.owner >= DISCOVERY_LIMITS.perOwner ||
          counts.revision >= DISCOVERY_LIMITS.perRevision
        )
          throw new DiscoveryError("refresh_limit");
        const running = await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM event_discoveries WHERE status = 'running' AND lease_expires_at > ?",
          )
          .get(now.getTime());
        if (!capacity || Number(running?.count) >= DISCOVERY_LIMITS.concurrent)
          throw new DiscoveryError("busy");
        const runId = randomUUID();
        const row: DiscoveryRow = {
          owner_id: owner,
          profile_revision: state.revision,
          status: "running",
          run_id: runId,
          attempts: (existing?.attempts ?? 0) + 1,
          request_id: request.requestId,
          lease_expires_at: now.getTime() + DISCOVERY_LIMITS.leaseMs,
          started_at: now.toISOString(),
          finished_at: null,
          error_code: null,
          result_json: existing?.result_json ?? null,
        };
        await this.db
          .prepare(
            `INSERT INTO event_discoveries (owner_id, profile_revision, status, run_id, attempts, request_id, lease_expires_at, started_at, finished_at, error_code, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, profile_revision) DO UPDATE SET status=excluded.status, run_id=excluded.run_id, attempts=excluded.attempts,
          request_id=excluded.request_id, lease_expires_at=excluded.lease_expires_at, started_at=excluded.started_at, finished_at=NULL, error_code=NULL`,
          )
          .run(
            row.owner_id,
            row.profile_revision,
            row.status,
            row.run_id,
            row.attempts,
            row.request_id,
            row.lease_expires_at,
            row.started_at,
            row.finished_at,
            row.error_code,
            row.result_json,
          );
        await this.db
          .prepare(
            "INSERT INTO runs (id, session_id, operation_key, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)",
          )
          .run(
            runId,
            owner,
            `discovery:${request.requestId}`,
            String(state.revision),
            now.toISOString(),
          );
        await this.db
          .prepare(
            `DELETE FROM event_discoveries WHERE owner_id = ? AND profile_revision != ? AND profile_revision !=
        COALESCE((SELECT MAX(profile_revision) FROM event_discoveries WHERE owner_id = ? AND profile_revision < ?), -1)`,
          )
          .run(owner, state.revision, owner, state.revision);
        return { claimed: true as const, row, owner, context: state.context };
      })
      .immediate();
  }

  private async eventSuggestionState(owner: string): Promise<EventSuggestionState> {
    const row = await this.db.prepare(
      "SELECT result_json FROM runs WHERE session_id = ? AND operation_key = 'event-suggestions'",
    ).get(owner);
    return row ? JSON.parse(String(row.result_json)) as EventSuggestionState : {
      lastCheckedAt: null, revision: 0, active: null, seen: [],
      lastSuggestedAt: null, day: "", dayCount: 0,
    };
  }

  private async saveEventSuggestionState(owner: string, state: EventSuggestionState, now: Date) {
    await this.db.prepare(
      `INSERT INTO runs (id, session_id, operation_key, payload_hash, result_json, created_at)
       VALUES (?, ?, 'event-suggestions', '', ?, ?)
       ON CONFLICT(session_id, operation_key) DO UPDATE SET result_json = excluded.result_json`,
    ).run(randomUUID(), owner, JSON.stringify(state), now.toISOString());
  }

  // Claim the oldest due profile atomically across instances. The operation ledger
  // owns the check state, so deleting a profile cannot leave detached job data.
  async claimProactiveDiscoveryCheck(now: Date) {
    return this.db.transaction(async () => {
      const due = (await this.db.prepare(
        `SELECT s.token_hash AS owner, s.revision FROM sessions s
         JOIN users u ON u.profile_id = s.token_hash
         LEFT JOIN onboarding_chats c ON c.session_id = s.token_hash
         LEFT JOIN runs r ON r.session_id = s.token_hash AND r.operation_key = 'event-suggestions'
         WHERE s.context_json IS NOT NULL AND s.confirmed_at IS NOT NULL
           AND json_extract(s.context_json, '$.trip.city') = 'San Francisco'
           AND json_extract(s.context_json, '$.trip.end') >= ?
           AND (c.state_json IS NULL OR (
             json_extract(c.state_json, '$.confirmed') = 1
             AND json_extract(c.state_json, '$.baseRevision') = s.revision))
           AND (r.id IS NULL OR json_extract(r.result_json, '$.revision') != s.revision
             OR COALESCE(json_extract(r.result_json, '$.lastCheckedAt'), '') <= ?)
         ORDER BY COALESCE(json_extract(r.result_json, '$.lastCheckedAt'), ''), s.token_hash
         LIMIT 1`,
      ).get(
        suggestionDay(now).toPlainDate().toString(),
        new Date(now.getTime() - PROACTIVE_EVENT_LIMITS.checkMs).toISOString(),
      )) as { owner: string; revision: number } | undefined;
      if (!due) return null;
      const state = await this.eventSuggestionState(due.owner);
      state.lastCheckedAt = now.toISOString();
      state.revision = due.revision;
      await this.saveEventSuggestionState(due.owner, state, now);
      return due;
    }).immediate();
  }

  async eventSuggestion(
    owner: string,
    now: Date,
    create = false,
    explicitlyRequested = false,
    expectedRunId?: string | null,
  ): Promise<EventSuggestion | null> {
    return this.db.transaction(async () => {
      const { state: profile, confirmed } = await this.discoveryProfile(owner);
      const state = await this.eventSuggestionState(owner);
      const previous = JSON.stringify(state);
      const row = await this.readDiscoveryForOwner(owner, now);
      // A concurrent refresh must not attach a suggestion to an older HTTP snapshot
      // whose positional event IDs refer to different candidates.
      if (expectedRunId !== undefined && expectedRunId !== (row?.run_id ?? null)) return null;
      const result = row?.result_json ? JSON.parse(row.result_json) as DiscoveryResult : null;
      const ready = row?.status === "ready" || row?.status === "partial";
      const usable = confirmed && profile.context && discoveryWindow(profile.context, now)
        && result && (ready || row?.status === "running")
        && now.getTime() - Date.parse(result.checkedAt) < PROACTIVE_EVENT_LIMITS.refreshMs;
      const registrations = await this.db.prepare(
        `SELECT e.event_json FROM network_events e JOIN users u ON u.id = e.user_id
         WHERE u.profile_id = ? AND json_extract(e.event_json, '$.attendance') = 'registered'`,
      ).all(owner);
      const registered = (event: Recommendation) => registrations.some((row) => {
        const entry = JSON.parse(String(row.event_json)) as {
          url?: string; aliasUrls?: string[]; date?: string; start?: string | null;
        };
        let date = entry.date;
        if (!date && entry.start) {
          try { date = Temporal.Instant.from(entry.start).toZonedDateTimeISO("America/Los_Angeles").toPlainDate().toString(); }
          catch { return false; }
        }
        return [entry.url, ...(entry.aliasUrls ?? [])].some((url) =>
          !!url && eventSuggestionKeys(event).includes(`${canonicalEventUrl(url)}|${date}`),
        );
      });
      const candidates = usable ? result.recommendations.filter((event) =>
        !eventHasEnded(event, now) && !registered(event),
      ) : [];
      const activeEvent = state.active?.revision === profile.revision
        ? candidates.find((event) => eventSuggestionKeys(event).some((key) => state.active!.keys.includes(key)))
        : undefined;
      if (state.active && !activeEvent) state.active = null;
      if (state.active && activeEvent) state.active.eventId = activeEvent.id;
      const local = suggestionDay(now), day = local.toPlainDate().toString();
      const allowedHour = explicitlyRequested || (local.hour >= 8 && local.hour < 21);
      const cooldown = !state.lastSuggestedAt || now.getTime() - Date.parse(state.lastSuggestedAt) >= PROACTIVE_EVENT_LIMITS.suggestionMs;
      const dailyCount = state.day === day ? state.dayCount : 0;
      if (create && ready && !state.active && allowedHour && cooldown && dailyCount < PROACTIVE_EVENT_LIMITS.suggestionsPerDay) {
        const next = candidates.find((event) => event.reason.trim()
          && !eventSuggestionKeys(event).some((key) => state.seen.includes(key)));
        if (next) {
          const keys = eventSuggestionKeys(next);
          state.active = {
            id: randomUUID(), eventId: next.id, revision: profile.revision, keys,
            message: next.reason,
            createdAt: now.toISOString(),
          };
          state.seen = [...new Set([...state.seen, ...keys])];
          state.lastSuggestedAt = now.toISOString();
          state.day = day;
          state.dayCount = dailyCount + 1;
        }
      }
      if (JSON.stringify(state) !== previous) await this.saveEventSuggestionState(owner, state, now);
      if (!state.active) return null;
      const { id, eventId, message, createdAt } = state.active;
      return { id, eventId, message, createdAt };
    }).immediate();
  }

  async dismissEventSuggestion(token: string | undefined, revision: number, suggestionId: string, now: Date) {
    const owner = await this.calendarOwner(token);
    await this.db.transaction(async () => {
      if ((await this.discoveryProfile(owner)).state.revision !== revision)
        throw new DiscoveryError("profile_changed");
      const state = await this.eventSuggestionState(owner);
      // A repeated dismissal cannot dismiss a newer suggestion or another owner.
      if (state.active?.id === suggestionId) {
        state.active = null;
        await this.saveEventSuggestionState(owner, state, now);
      }
    }).immediate();
  }

  async finishDiscovery(
    owner: string,
    revision: number,
    runId: string,
    status: Exclude<DiscoveryStatus, "running">,
    result: DiscoveryResult | null,
    coverage: Coverage,
    errorCode: string | null,
    now: Date,
  ) {
    return await this.db
      .transaction(async () => {
        const changed = (
          await this.db
            .prepare(
              `UPDATE event_discoveries SET status = ?, finished_at = ?, lease_expires_at = NULL, error_code = ?, result_json = COALESCE(?, result_json)
        WHERE owner_id = ? AND profile_revision = ? AND run_id = ? AND status = 'running'
        AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND revision = ?)`,
            )
            .run(
              status,
              now.toISOString(),
              errorCode,
              result ? JSON.stringify(result) : null,
              owner,
              revision,
              runId,
              owner,
              revision,
            )
        ).changes;
        if (changed)
          await this.db
            .prepare(
              "UPDATE runs SET result_json = ? WHERE id = ? AND session_id = ?",
            )
            .run(JSON.stringify({ coverage }), runId, owner);
        return changed > 0;
      })
      .immediate();
  }
  async readCalendar(token: string | undefined): Promise<CalendarRecord> {
    const row = (await this.db
      .prepare(
        "SELECT revision, connection_json FROM calendar_connections WHERE session_id = ?",
      )
      .get(await this.calendarOwner(token))) as
      | {
          revision: number;
          connection_json: string | null;
        }
      | undefined;
    return {
      revision: row?.revision ?? 0,
      connection: row?.connection_json
        ? (JSON.parse(row.connection_json) as CalendarConnection)
        : null,
    };
  }
  async writeCalendar(
    token: string | undefined,
    revision: number,
    connection: CalendarConnection | null,
  ): Promise<CalendarRecord> {
    return await this.db
      .transaction(async () => {
        const owner = await this.calendarOwner(token);
        if ((await this.readCalendar(token)).revision !== revision)
          throw new CalendarConflict("calendar_changed");
        const next = { revision: revision + 1, connection };
        await this.db
          .prepare(
            "INSERT INTO calendar_connections (session_id, revision, connection_json) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, connection_json = excluded.connection_json",
          )
          .run(
            owner,
            next.revision,
            connection ? JSON.stringify(connection) : null,
          );
        return next;
      })
      .immediate();
  }
  async startCalendarOAuth(
    token: string,
    state: string,
    encryptedVerifier: string,
    now = Date.now(),
  ) {
    await this.db
      .transaction(async () => {
        const owner = await this.calendarOwner(token);
        await this.db
          .prepare(
            "DELETE FROM calendar_oauth_states WHERE session_id = ? OR expires_at <= ?",
          )
          .run(owner, now);
        await this.db
          .prepare(
            "INSERT INTO calendar_oauth_states (state_hash, session_id, encrypted_verifier, expires_at, base_revision, browser_token_hash) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            hash(state),
            owner,
            encryptedVerifier,
            now + 10 * 60 * 1000,
            (await this.readCalendar(token)).revision,
            hash(token),
          );
      })
      .immediate();
  }
  async consumeCalendarOAuth(
    token: string | undefined,
    state: string,
    now = Date.now(),
  ) {
    const result = await this.db
      .transaction(async () => {
        const owner = await this.calendarOwner(token);
        const row = (await this.db
          .prepare(
            "SELECT encrypted_verifier, expires_at, base_revision FROM calendar_oauth_states WHERE state_hash = ? AND session_id = ? AND browser_token_hash = ?",
          )
          .get(hash(state), owner, hash(token!))) as
          | {
              encrypted_verifier: string;
              expires_at: number;
              base_revision: number;
            }
          | undefined;
        if (!row) throw new CalendarConflict("invalid_state");
        await this.db
          .prepare(
            "DELETE FROM calendar_oauth_states WHERE state_hash = ? AND session_id = ?",
          )
          .run(hash(state), owner);
        return row;
      })
      .immediate();
    if (result.expires_at <= now) throw new CalendarConflict("invalid_state");
    return result;
  }
  async connectCalendar(
    token: string,
    revision: number,
    connectionForOwner: (owner: string) => CalendarConnection,
  ): Promise<string> {
    return await this.db
      .transaction(async () => {
        const owner = await this.calendarOwner(token);
        if ((await this.readCalendar(token)).revision !== revision)
          throw new CalendarConflict("calendar_changed");
        const account = await this.account(token);
        if (account) {
          await this.writeCalendar(token, revision, connectionForOwner(owner));
          const nextToken = await this.createLogin(account.id);
          await this.logout(token);
          return nextToken;
        }
        const nextToken = randomBytes(32).toString("hex"),
          nextOwner = hash(nextToken);
        const connection = connectionForOwner(nextOwner);
        await this.db
          .prepare(
            "INSERT INTO sessions (token_hash, revision, context_json, confirmed_at, created_at) SELECT ?, revision, context_json, confirmed_at, created_at FROM sessions WHERE token_hash = ?",
          )
          .run(nextOwner, owner);
        await this.db
          .prepare("UPDATE runs SET session_id = ? WHERE session_id = ?")
          .run(nextOwner, owner);
        await this.db
          .prepare(
            "UPDATE event_discoveries SET owner_id = ? WHERE owner_id = ?",
          )
          .run(nextOwner, owner);
        await this.db
          .prepare(
            "UPDATE onboarding_chats SET session_id = ? WHERE session_id = ?",
          )
          .run(nextOwner, owner);
        await this.db
          .prepare("DELETE FROM calendar_oauth_states WHERE session_id = ?")
          .run(owner);
        await this.db
          .prepare("DELETE FROM calendar_connections WHERE session_id = ?")
          .run(owner);
        await this.db
          .prepare(
            "INSERT INTO calendar_connections (session_id, revision, connection_json) VALUES (?, ?, ?)",
          )
          .run(nextOwner, revision + 1, JSON.stringify(connection));
        await this.db
          .prepare("DELETE FROM sessions WHERE token_hash = ?")
          .run(owner);
        return nextToken;
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
const globalStore = globalThis as typeof globalThis & {
  sidekickStore?: ContextStore;
};
export function getStore() {
  if (globalStore.sidekickStore) return globalStore.sidekickStore;
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (url || authToken) {
    if (!url || !authToken)
      throw new Error("Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
    const demo = process.env.SIDEKICK_DEMO === "1";
    if (demo && process.env.DATABASE_PURPOSE !== "demo")
      throw new Error(
        "A remote demo requires DATABASE_PURPOSE=demo and a separate database.",
      );
    if (!demo && process.env.DATABASE_PURPOSE === "demo")
      throw new Error("A production deployment cannot use a demo database.");
    return (globalStore.sidekickStore = new ContextStore({
      url,
      authToken,
      purpose: demo ? "demo" : "production",
    }));
  }
  return (globalStore.sidekickStore = new ContextStore(
    process.env.DATABASE_PATH || "./data/sidekick.sqlite",
  ));
}
