import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_LIMITS,
  type DiscoveryRequest,
} from "../src/lib/domain/event-discovery";
import { draftFromContext } from "../src/lib/domain/onboarding-chat";
import { ContextStore } from "../src/lib/server/store";
import {
  discoveryStatus,
  startDiscovery,
  type DiscoveryDeps,
} from "../src/lib/server/event-discovery-service";
import { discoveryNow, eventFixture } from "./discovery-fixtures";
import { validContext } from "./fixtures";
let store: ContextStore, token: string, folder: string, path: string;
const request = (
  action: "start" | "refresh" = "start",
  revision = 1,
): DiscoveryRequest => ({ action, revision, requestId: crypto.randomUUID() });
async function confirmed(target = token, context = validContext()) {
  const before = await store.readChat(target);
  const draft = await store.commitChat(
    target,
    {
      action: "message",
      revision: before.revision,
      message: "Synthetic profile",
      requestId: crypto.randomUUID(),
    },
    { reply: "Review your profile.", draft: draftFromContext(context) },
  );
  return await store.commitChat(target, {
    action: "confirm",
    revision: draft.revision,
    requestId: crypto.randomUUID(),
  });
}
function dependencies(): DiscoveryDeps {
  const f = eventFixture();
  return {
    now: discoveryNow,
    plan: vi.fn(async () => ({
      topics: ["typescript" as const, "ai_agents" as const],
      audiences: ["early_stage_engineers" as const],
      formats: ["meetup" as const],
      avoid: [],
    })),
    search: vi.fn(async (q) =>
      q.includeDomains?.includes("luma.com")
        ? [
            {
              url: f.candidate.url,
              title: f.candidate.title,
              text: f.candidate.texts[0],
            },
          ]
        : [],
    ),
    contents: vi.fn(async () => ({ results: [], statuses: [] })),
    extract: vi.fn<DiscoveryDeps["extract"]>(async (candidates) =>
      candidates.map((c) => ({ ...f.extracted, candidateId: c.id })),
    ),
    rank: vi.fn<DiscoveryDeps["rank"]>(async (_, candidates) => ({
      picks: candidates.slice(0, 1).map((c) => ({
        candidateId: c.id,
        reason:
          "The builder format could help you explore early-stage engineering work.",
        evidenceQuote: c.description,
        caveat: null,
      })),
    })),
  };
}
async function run(deps = dependencies(), input = request(), target = token) {
  const started = await startDiscovery(store, target, input, deps);
  await started.run?.();
  return await discoveryStatus(store, target, deps.now());
}
beforeEach(async () => {
  vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "100");
  vi.stubEnv("OPENAI_API_KEY", "fixture-key");
  vi.stubEnv("EXA_API_KEY", "fixture-key");
  vi.stubEnv("EXA_TEST_BASE_URL", "");
  folder = mkdtempSync(join(tmpdir(), "discovery-unit-"));
  path = join(folder, "test.sqlite");
  store = new ContextStore(path);
  token = (await store.ensureSession()).token;
  await confirmed();
});
afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("claims and durable results", () => {
  it("two starts and the same request ID schedule exactly one four-search pipeline", async () => {
    const deps = dependencies(),
      input = request();
    const a = await startDiscovery(store, token, input, deps);
    const b = await startDiscovery(store, token, request(), deps);
    const c = await startDiscovery(store, token, input, deps);
    expect(a.view.discovery?.status).toBe("running");
    expect(b.run).toBeNull();
    expect(c.run).toBeNull();
    await Promise.all([a.run?.(), a.run?.()]);
    expect(deps.search).toHaveBeenCalledTimes(4);
    expect((await run(deps, input)).discovery?.attempts).toBe(1);
    expect(deps.search).toHaveBeenCalledTimes(4);
    expect(
      (await discoveryStatus(store, token, discoveryNow())).discovery?.status,
    ).toBe("ready");
    store.close();
    store = new ContextStore(path);
    expect(
      (await discoveryStatus(store, token, discoveryNow())).discovery
        ?.recommendations,
    ).toHaveLength(1);
  });
  it("failed start is retryable; a failed refresh preserves last good results", async () => {
    const deps = dependencies();
    const good = await run(deps);
    deps.plan = vi.fn(async () => {
      throw new Error("fixture outage");
    });
    const failed = await run(deps, request("refresh"));
    expect(failed.discovery).toMatchObject({
      status: "failed",
      attempts: 2,
      canRefresh: true,
      errorCode: "planner_failed",
    });
    expect(failed.discovery?.recommendations).toEqual(
      good.discovery?.recommendations,
    );
    expect(failed.discovery?.checkedAt).toBe(good.discovery?.checkedAt);
    expect((await run()).discovery).toMatchObject({
      status: "ready",
      attempts: 3,
    });
  });
  it("retry after initial failure creates attempt 2", async () => {
    const deps = dependencies();
    deps.rank = vi.fn(async () => {
      throw new Error();
    });
    expect((await run(deps)).discovery?.status).toBe("failed");
    expect((await run()).discovery?.attempts).toBe(2);
  });
  it("expired leases read as failed/interrupted and can be retried", async () => {
    await store.claimDiscovery(token, request(), discoveryNow(), true);
    const now = new Date(
      discoveryNow().getTime() + DISCOVERY_LIMITS.leaseMs + 1,
    );
    expect((await discoveryStatus(store, token, now)).discovery).toMatchObject({
      status: "failed",
      errorCode: "interrupted",
      canRefresh: true,
    });
    expect(
      (await run({ ...dependencies(), now: () => now })).discovery,
    ).toMatchObject({ status: "ready", attempts: 2 });
  });
  it("wrong revisions, missing profiles and ended trips cannot start", async () => {
    await expect(
      startDiscovery(store, token, request("start", 2), dependencies()),
    ).rejects.toThrow("profile_changed");
    const another = (await store.ensureSession()).token;
    await expect(
      startDiscovery(store, another, request(), dependencies()),
    ).rejects.toThrow("profile_missing");
    await expect(
      startDiscovery(store, token, request(), {
        ...dependencies(),
        now: () => new Date("2026-11-06T18:00:00Z"),
      }),
    ).rejects.toThrow("trip_past");
    expect(await store.readDiscovery(token, discoveryNow())).toBeNull();
  });
  it.each(["OPENAI_API_KEY", "EXA_API_KEY"])(
    "missing %s makes no row and calls no providers",
    async (key) => {
      vi.stubEnv(key, "");
      const deps = dependencies();
      expect(
        (await discoveryStatus(store, token, discoveryNow())).configured,
      ).toBe(false);
      await expect(
        startDiscovery(store, token, request(), deps),
      ).rejects.toThrow("not_configured");
      expect(await store.readDiscovery(token, discoveryNow())).toBeNull();
      expect(deps.plan).not.toHaveBeenCalled();
    },
  );
  it("a newer confirmed revision aborts the old run and its guarded write cannot land", async () => {
    const deps = dependencies();
    let release!: () => void;
    deps.plan = vi.fn<DiscoveryDeps["plan"]>(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ topics: [], audiences: [], formats: [], avoid: [] });
        }),
    );
    const old = await startDiscovery(store, token, request(), deps),
      oldRun = old.run!();
    const row = (await store.readDiscovery(token, discoveryNow()))!;
    const next = validContext();
    next.goal.type = "hiring";
    await confirmed(token, next);
    expect(await discoveryStatus(store, token, discoveryNow())).toMatchObject({
      profileRevision: 2,
      discovery: null,
    });
    const latest = await run(dependencies(), request("start", 2));
    release();
    await oldRun;
    expect(latest.discovery?.revision).toBe(2);
    expect(
      await store.finishDiscovery(
        row.owner_id,
        1,
        row.run_id,
        "ready",
        null,
        latest.discovery!.coverage,
        null,
        discoveryNow(),
      ),
    ).toBe(false);
    expect(
      (await discoveryStatus(store, token, discoveryNow())).discovery?.revision,
    ).toBe(2);
  });
  it("stale flags follow unconfirmed drafts and checked time; ended cards are filtered", async () => {
    await run();
    expect((await discoveryStatus(store, token, discoveryNow())).stale).toBe(
      false,
    );
    const chat = await store.readChat(token),
      context = validContext();
    context.goal.type = "customers";
    await store.commitChat(
      token,
      {
        action: "message",
        message: "Change goal",
        revision: chat.revision,
        requestId: crypto.randomUUID(),
      },
      { reply: "Review the change.", draft: draftFromContext(context) },
    );
    expect(
      (await discoveryStatus(store, token, discoveryNow())).draftChanged,
    ).toBe(true);
    expect(
      (await discoveryStatus(store, token, new Date("2026-10-26T18:00:00Z")))
        .outdated,
    ).toBe(true);
    expect(
      (await discoveryStatus(store, token, new Date("2026-11-06T18:00:00Z")))
        .discovery?.recommendations,
    ).toHaveLength(0);
  });
  it("does not hold a transaction during provider calls", async () => {
    const second = new Database(path);
    second.pragma("busy_timeout = 0");
    const deps = dependencies(),
      original = deps.search;
    let writes = 0;
    deps.search = async (...args) => {
      second.prepare("UPDATE sessions SET created_at = created_at").run();
      writes++;
      await Promise.resolve();
      return original(...args);
    };
    try {
      expect((await run(deps)).discovery?.status).toBe("ready");
      expect(writes).toBe(4);
    } finally {
      second.close();
    }
  });
  it("enforces the total deadline even when a provider ignores aborts", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const deps = dependencies();
    deps.plan = () => new Promise(() => {});
    const pending = (await startDiscovery(store, token, request(), deps))
      .run!();
    await vi.advanceTimersByTimeAsync(55001);
    await pending;
    expect(
      (await discoveryStatus(store, token, discoveryNow())).discovery,
    ).toMatchObject({
      status: "failed",
      errorCode: "timeout",
      canRefresh: true,
    });
    expect(deps.search).not.toHaveBeenCalled();
  });
  it("isolates accounts and keeps results through login and Google session rotation", async () => {
    const registered = await store.registerAccount(
      "first@example.test",
      "test-hash",
      token,
    );
    token = registered.token;
    await run();
    const other = await store.registerAccount(
      "second@example.test",
      "test-hash",
    );
    expect(
      (await discoveryStatus(store, other.token, discoveryNow())).discovery,
    ).toBeNull();
    const login = await store.createLogin(registered.account.id);
    expect(
      (await discoveryStatus(store, login, discoveryNow())).discovery?.status,
    ).toBe("ready");
    token = await store.connectCalendar(token, 0, () => ({
      subject: "fixture",
      email: "google@example.test",
      encryptedTokens: "encrypted-fixture",
      calendars: [],
      selectedIds: [],
      snapshot: null,
      issue: null,
    }));
    expect(
      (await discoveryStatus(store, token, discoveryNow())).discovery?.status,
    ).toBe("ready");
  });
  it("re-keys anonymous discovery rows before deleting the old session without a foreign-key error", async () => {
    await run();
    const oldOwner = await store.calendarOwner(token);
    token = await store.connectCalendar(token, 0, () => ({
      subject: "fixture",
      email: "google@example.test",
      encryptedTokens: "encrypted-fixture",
      calendars: [],
      selectedIds: [],
      snapshot: null,
      issue: null,
    }));
    expect(await store.calendarOwner(token)).not.toBe(oldOwner);
    expect(
      (await discoveryStatus(store, token, discoveryNow())).discovery
        ?.recommendations,
    ).toHaveLength(1);
  });
  it("adds the discovery table to a pre-existing database without losing profiles", async () => {
    store.close();
    const old = new Database(path);
    old.exec("DROP TABLE event_discoveries");
    old.close();
    store = new ContextStore(path);
    expect((await store.read(token))?.revision).toBe(1);
    expect(await store.readDiscovery(token, discoveryNow())).toBeNull();
  });
  it("enforces rolling per-revision and per-owner caps even when old snapshots are pruned", async () => {
    const deps = dependencies();
    deps.plan = vi.fn(async () => {
      throw new Error();
    });
    for (let rev = 1; rev <= 3; rev++) {
      if (rev > 1) {
        const c = validContext();
        c.goal.text = `Explore engineering projects revision ${rev}`;
        await confirmed(token, c);
      }
      for (let n = 0; n < 5; n++) await run(deps, request("refresh", rev));
      await expect(
        startDiscovery(store, token, request("refresh", rev), deps),
      ).rejects.toThrow("refresh_limit");
    }
    const c = validContext();
    c.goal.text = "Explore a fourth set of engineering projects";
    await confirmed(token, c);
    await expect(
      startDiscovery(store, token, request("start", 4), deps),
    ).rejects.toThrow("refresh_limit");
    const later = {
      ...dependencies(),
      now: () =>
        new Date(discoveryNow().getTime() + DISCOVERY_LIMITS.dayMs + 1),
    };
    await run(later, request("start", 4));
    const db = new Database(path);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM event_discoveries").get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
    db.close();
  });
  it("bounds concurrent pipelines and returns running state despite a full process", async () => {
    const deps = dependencies();
    const tokens = [
      token,
      ...(await Promise.all(
        Array.from({ length: 3 }, async () => {
          const t = (await store.ensureSession()).token;
          await confirmed(t);
          return t;
        }),
      )),
    ];
    const runs = await Promise.all(
      tokens.slice(0, 3).map((t) => startDiscovery(store, t, request(), deps)),
    );
    expect(
      (await startDiscovery(store, token, request(), deps)).run,
    ).toBeNull();
    await expect(
      startDiscovery(store, tokens[3], request(), deps),
    ).rejects.toThrow("busy");
    await Promise.all(runs.map((r) => r.run!()));
  });
  it("enforces a persistent global daily cap across owners and resets at SF midnight", async () => {
    vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "1");
    await run();
    const other = (await store.ensureSession()).token;
    await confirmed(other);
    await expect(
      startDiscovery(store, other, request(), dependencies()),
    ).rejects.toThrow("daily_limit");
    expect(
      (await discoveryStatus(store, other, discoveryNow())).dailyLimitReached,
    ).toBe(true);
    expect(await store.readDiscovery(other, discoveryNow())).toBeNull();
    store.close();
    store = new ContextStore(path);
    expect(await store.discoveryDailyUsage(discoveryNow())).toEqual({
      limit: 1,
      used: 1,
      reached: true,
    });
    expect(
      (await startDiscovery(store, token, request(), dependencies())).run,
    ).toBeNull();
    const nextDay = {
      ...dependencies(),
      now: () => new Date("2026-10-25T07:00:00Z"),
    };
    expect((await run(nextDay, request(), other)).discovery?.status).toBe(
      "ready",
    );
  });
  it("only fixed vocabulary labels reach Exa even with private names and company/product details", async () => {
    const c = validContext();
    c.profile.bio = "Maya Chen builds SecretOrbit's LaunchWidget agents.";
    c.goal.text = "Find buyers for SecretOrbit LaunchWidget with Maya Chen.";
    await confirmed(token, c);
    const deps = dependencies();
    await run(deps, request("start", 2));
    const bodies = JSON.stringify(
      vi.mocked(deps.search).mock.calls.map(([query]) => query),
    );
    expect(bodies).not.toMatch(
      /Maya|Chen|SecretOrbit|LaunchWidget|Alex|Rivera|userIdentifier|coordinates/i,
    );
    expect(bodies).toContain("typescript");
  });
  it("persists verified yield per source before cross-platform merging", async () => {
    const deps = dependencies();
    const view = await run(deps);
    expect(view.discovery?.coverage.sources).toEqual([
      { platform: "luma", status: "ok", results: 1, verified: 1 },
      { platform: "eventbrite", status: "ok", results: 0, verified: 0 },
      { platform: "partiful", status: "ok", results: 0, verified: 0 },
      { platform: "web", status: "ok", results: 0, verified: 0 },
    ]);
    store.close();
    store = new ContextStore(path);
    expect(
      (await discoveryStatus(store, token, discoveryNow())).discovery?.coverage,
    ).toEqual(view.discovery?.coverage);
  });
});
describe("coverage and pipeline outcomes", () => {
  it("all source failures are failed, one failure with picks is partial", async () => {
    const deps = dependencies();
    deps.search = vi.fn(async () => {
      throw new Error();
    });
    expect((await run(deps)).discovery?.status).toBe("failed");
    const partial = dependencies(),
      original = partial.search;
    partial.search = async (q, s) => {
      if (q.includeDomains?.includes("partiful.com")) throw new Error();
      return original(q, s);
    };
    expect((await run(partial)).discovery?.status).toBe("partial");
  });
  it("only past events and zero rank picks produce empty, not failed", async () => {
    const deps = dependencies(),
      original = deps.search;
    deps.search = async (...args) =>
      (await original(...args)).map((r) => ({
        ...r,
        text: `${r.text}\nPast Event`,
      }));
    expect((await run(deps)).discovery?.status).toBe("empty");
    const none = dependencies();
    none.rank = vi.fn(async () => ({ picks: [] }));
    expect((await run(none, request("refresh"))).discovery?.status).toBe(
      "empty",
    );
  });
  it("retains cached search evidence when fresh enrichment loses a date", async () => {
    const deps = dependencies(),
      f = eventFixture({
        timeQuote: null,
        startTime: null,
        endTime: null,
        timeZone: null,
      });
    deps.search = vi.fn(async (q) =>
      q.includeDomains?.includes("luma.com")
        ? [
            {
              url: f.candidate.url,
              title: f.candidate.title,
              text: f.candidate.texts[0],
            },
          ]
        : [],
    );
    deps.contents = vi.fn(async () => ({
      results: [{ url: f.candidate.url, text: "Fresh content has no date." }],
      statuses: [{ id: f.candidate.url, status: "success" as const }],
    }));
    deps.extract = vi.fn(async (candidates) => {
      expect(candidates[0].texts.join(" ")).toContain("Nov 5, 2026");
      expect(candidates[0].texts).toContain("Fresh content has no date.");
      return [f.extracted];
    });
    expect((await run(deps)).discovery?.status).toBe("ready");
    expect(deps.contents).toHaveBeenCalledTimes(1);
  });
  it("a failed enrichment continues with existing evidence and partial coverage", async () => {
    const deps = dependencies(),
      original = deps.search;
    deps.search = async (...args) =>
      (await original(...args)).map((r) => ({
        ...r,
        text: r.text!.replace("5:00 PM – 9:00 PM (UTC-08:00)", ""),
      }));
    deps.contents = vi.fn(async () => {
      throw new Error();
    });
    expect((await run(deps)).discovery).toMatchObject({
      status: "partial",
      coverage: { enrichment: "failed" },
    });
  });
});
