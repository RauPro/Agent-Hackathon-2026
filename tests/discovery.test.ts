import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore } from "../src/lib/server/store";
import {
  enqueueDailyNetworkWork,
  startNetworkWorker,
} from "../src/lib/server/network-worker";
import { DiscoveryService } from "../src/lib/server/discovery-service";
import { AgentDialogueService } from "../src/lib/server/agent-dialogue-service";
import type { NetworkStore } from "../src/lib/server/network-store";
import type { NetworkSettingsInput } from "../src/lib/domain/network";
import type { NetworkEventInput } from "../src/lib/domain/discovery";
import type { UserContext } from "../src/lib/domain/context";
import { validContext } from "./fixtures";
type TestAccount = {
  id: string;
  token: string;
};
let folder: string,
  path: string,
  store: ContextStore,
  network: NetworkStore,
  discovery: DiscoveryService;
let a: TestAccount, b: TestAccount, c: TestAccount;
const shared = {
  profile: "network",
  goal: "network",
  trip: "network",
  events: "network",
} as const;
async function account(name: string, hiring = false): Promise<TestAccount> {
  const registration = await store.registerAccount(
    `${name.toLowerCase()}@example.test`,
    "test-only-password-hash",
  );
  const context = validContext();
  context.profile = {
    name: `${name} Example`,
    bio: hiring
      ? "Founder building AI agent infrastructure and production software."
      : "Engineer building production AI agents and infrastructure.",
    offers: hiring
      ? "An early-stage AI startup with funding and production engineering opportunities."
      : "Experience shipping AI infrastructure and agent products in early-stage startups.",
  };
  context.goal = {
    type: hiring ? "hiring" : "seeking_role",
    text: hiring
      ? "Hire a founding engineer to build AI agents and infrastructure."
      : "Find a founding engineer role building AI agents and infrastructure.",
  };
  context.trip.start = "2026-10-25";
  context.trip.end = "2026-11-15";
  await store.save(registration.token, {
    context,
    baseRevision: 0,
    requestId: randomUUID(),
  });
  return { id: registration.account.id, token: registration.token };
}
async function preferences(
  person: TestAccount,
  changes: Partial<NetworkSettingsInput> = {},
) {
  const current = await network.settings(person.id);
  return await network.saveSettings(person.id, {
    discoverable: current.discoverable,
    visibility: current.visibility,
    area: current.area,
    revision: current.revision,
    ...changes,
  });
}
async function discoverable(person: TestAccount) {
  await preferences(person, { discoverable: true, visibility: shared });
}
async function update(
  person: TestAccount,
  edit: (context: UserContext) => void,
) {
  const state = (await store.read(person.token))!;
  const context = structuredClone(state.context!);
  edit(context);
  return await store.save(person.token, {
    context,
    baseRevision: state.revision,
    requestId: randomUUID(),
  });
}
async function connect() {
  await network.requestConnection(a.id, b.id, {
    source: "qr",
    token: (await network.settings(b.id)).qrToken,
    context: "Met at a technology event.",
  });
  await network.connectionAction(b.id, a.id, "accept");
}
function event(changes: Partial<NetworkEventInput> = {}): NetworkEventInput {
  return {
    title: "AI Infrastructure Meetup",
    url: "https://events.example.test/ai-meetup",
    start: "2026-11-05T18:00:00-08:00",
    end: "2026-11-05T20:00:00-08:00",
    area: "Marina District",
    visibility: "network",
    ...changes,
  };
}
async function queued() {
  return (await network.db
    .prepare("SELECT user_id, version FROM network_jobs ORDER BY user_id")
    .all()) as {
    user_id: string;
    version: number;
  }[];
}
async function opportunityCount() {
  return (
    (await network.db
      .prepare("SELECT COUNT(*) AS count FROM network_opportunities")
      .get()) as {
      count: number;
    }
  ).count;
}
async function drainAll() {
  for (let pass = 0; pass < 100; pass++) {
    if (!(await discovery.drain())) return;
  }
  throw new Error("Discovery queue did not settle");
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T17:00:00Z"));
  vi.spyOn(Temporal.Now, "plainDateISO").mockReturnValue(
    Temporal.PlainDate.from("2026-10-24"),
  );
  vi.stubEnv("SIDEKICK_DEMO", "");
  folder = mkdtempSync(join(tmpdir(), "sidekick-discovery-"));
  path = join(folder, "test.sqlite");
  store = new ContextStore(path);
  network = store.network;
  discovery = new DiscoveryService(network);
  a = await account("Alex");
  b = await account("Blair", true);
  c = await account("Casey");
  await drainAll();
});
afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("proactive discovery with authorized context", () => {
  it("creates one reciprocal, evidence-backed opportunity for complementary goals", async () => {
    await discoverable(a);
    await discoverable(b);
    await update(b, (context) => {
      context.trip.start = "2026-11-01";
    });
    expect(await discovery.opportunities(a.id)).toHaveLength(0);
    await drainAll();
    const forA = await discovery.opportunities(a.id),
      forB = await discovery.opportunities(b.id);
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]).toMatchObject({
      userId: b.id,
      name: "Blair Example",
      source: "user_report",
      connected: false,
      overlap: { start: "2026-11-01", end: "2026-11-15" },
    });
    expect(forA[0].score).toBeGreaterThan(0);
    expect(forA[0].signals).toEqual(
      expect.arrayContaining(["AI", "agents", "infrastructure"]),
    );
    expect(forA[0].benefits.you).toContain("hiring");
    expect(forB[0].benefits.you).toContain("role search");
    expect(forA[0].id).toBe(forB[0].id);
    expect(await opportunityCount()).toBe(1);
    expect(JSON.stringify(forA)).not.toMatch(
      /password|calendar|@example.test|qrToken/,
    );
  });
  it("requires useful evidence in both directions and changes with professional goals", async () => {
    await discoverable(a);
    await discoverable(b);
    await update(b, (context) => {
      context.goal.text =
        "Hire a marine biologist specializing in coral conservation.";
    });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    await update(b, (context) => {
      context.goal = {
        type: "hiring",
        text: "Hire a founding engineer to build AI agent infrastructure.",
      };
    });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
    await update(a, (context) => {
      context.goal = {
        type: "customers",
        text: "Find customers for my AI infrastructure consulting service.",
      };
    });
    expect(await discovery.opportunities(a.id)).toEqual([]);
    await drainAll();
    expect(await discovery.opportunities(b.id)).toEqual([]);
  });
  it("does not recommend contradictory explicitly named roles", async () => {
    await discoverable(a);
    await discoverable(b);
    await update(b, (context) => {
      context.goal.text =
        "Hire an AI sales director for my infrastructure startup.";
    });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
  });
  it("supports the stated CTO and ICPC opportunity when both goals and profiles supply evidence", async () => {
    await discoverable(a);
    await discoverable(b);
    await update(a, (context) => {
      context.profile.bio =
        "Engineer with ICPC competitive programming experience and production software projects.";
      context.profile.offers =
        "Algorithms and competitive programming expertise for an early-stage technical team.";
      context.goal.text =
        "Explore technical leadership and CTO roles at algorithms startups.";
    });
    await update(b, (context) => {
      context.profile.bio =
        "Founder building an algorithms startup and production optimization systems.";
      context.profile.offers =
        "A funded algorithms startup seeking technical leadership and product experience.";
      context.goal.text =
        "Hire a CTO with ICPC or competitive programming experience for algorithms products.";
    });
    await drainAll();
    expect((await discovery.opportunities(a.id))[0].signals).toContain(
      "algorithms",
    );
    expect(await discovery.opportunities(b.id)).toHaveLength(1);
    await update(a, (context) => {
      context.goal.text =
        "Find a founding engineer role working on algorithms and optimization.";
    });
    expect(await discovery.opportunities(a.id)).toEqual([]);
  });
  it("excludes unconfirmed profiles even after an explicit discovery opt-in", async () => {
    await discoverable(a);
    const draftOnly = await store.registerAccount(
      "draft-only@example.test",
      "test-only-hash",
    );
    await discoverable({ id: draftOnly.account.id, token: draftOnly.token });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    expect(await discovery.opportunities(draftOnly.account.id)).toEqual([]);
  });
  it("rejects nonoverlapping and fully past stays and clamps current overlap to today", async () => {
    await discoverable(a);
    await discoverable(b);
    await update(b, (context) => {
      context.trip.start = "2026-12-01";
      context.trip.end = "2026-12-15";
    });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    for (const person of [a, b])
      await update(person, (context) => {
        context.trip.start = "2026-10-01";
        context.trip.end = "2026-10-20";
      });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    for (const person of [a, b])
      await update(person, (context) => {
        context.trip.end = "2026-10-25";
      });
    await drainAll();
    expect((await discovery.opportunities(a.id))[0].overlap).toEqual({
      start: "2026-10-24",
      end: "2026-10-25",
    });
  });
  it("excludes opt-outs and private matching fields, including saved recommendations after revocation", async () => {
    await discoverable(a);
    await preferences(b, { visibility: shared });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    await discoverable(b);
    await drainAll();
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
    await preferences(b, { visibility: { ...shared, goal: "private" } });
    expect(await discovery.opportunities(a.id)).toEqual([]);
    await discoverable(b);
    await drainAll();
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
    await preferences(b, { discoverable: false });
    expect(await discovery.opportunities(a.id)).toEqual([]);
    await expect(
      network.requestConnection(a.id, b.id, {
        source: "opportunity",
        context: "Discuss a role.",
      }),
    ).rejects.toThrow();
  });
  it("allows friends-only matching after acceptance while honoring blocks and per-field privacy", async () => {
    await preferences(a, {
      visibility: {
        profile: "friends",
        goal: "friends",
        trip: "friends",
        events: "friends",
      },
    });
    await preferences(b, {
      visibility: {
        profile: "friends",
        goal: "friends",
        trip: "friends",
        events: "friends",
      },
    });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    await connect();
    await drainAll();
    expect((await discovery.opportunities(a.id))[0].connected).toBe(true);
    expect((await network.settings(a.id)).discoverable).toBe(false);
    await network.connectionAction(b.id, a.id, "block");
    expect(await discovery.opportunities(a.id)).toEqual([]);
    expect(await discovery.opportunities(b.id)).toEqual([]);
  });
  it("suggests a shared-event reunion for connected people with matching interests even without complementary jobs", async () => {
    await discoverable(a);
    await discoverable(b);
    await update(b, (context) => {
      context.goal = {
        type: "seeking_role",
        text: "Find an AI infrastructure engineering role.",
      };
    });
    await discovery.saveEvent(a.id, event());
    const attendance = await discovery.saveEvent(b.id, event());
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    await connect();
    await drainAll();
    const reunion = (await discovery.opportunities(a.id))[0];
    expect(reunion.sharedEvents).toHaveLength(1);
    expect(reunion.benefits.you).toContain("Reconnect");
    expect(reunion.benefits.you).not.toContain("hiring");
    await discovery.saveEvent(b.id, {
      ...event(),
      id: attendance.id,
      visibility: "private",
    });
    expect(await discovery.opportunities(a.id)).toEqual([]);
  });
  it("queues one connected dialogue round and reconciles changed shared context without sending discovery messages", async () => {
    await discoverable(a);
    await discoverable(b);
    await connect();
    await drainAll();
    const dialogues = new AgentDialogueService(network);
    const initial = await dialogues.list(a.id);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      userId: b.id,
      status: "queued",
      turns: [],
    });
    expect(await network.messages(a.id)).toEqual([]);
    await network.enqueue(a.id);
    await network.enqueue(b.id);
    await drainAll();
    expect(await dialogues.list(a.id)).toEqual(initial);
    await update(b, (context) => {
      context.goal.text += " The role focuses on Python systems.";
    });
    await drainAll();
    const changed = await dialogues.list(a.id);
    expect(changed).toHaveLength(1);
    expect(changed[0].id).toBe(initial[0].id);
    expect(changed[0].revision).toBeGreaterThan(initial[0].revision);
    expect(await dialogues.list(b.id)).toHaveLength(1);
    expect(await dialogues.list(c.id)).toEqual([]);
  });
  it("starts authorized collaboration when a previously recommended pair accepts the connection", async () => {
    await discoverable(a);
    await discoverable(b);
    await drainAll();
    const recommendation = (await discovery.opportunities(a.id))[0];
    expect(recommendation.connected).toBe(false);
    expect(await network.messages(a.id)).toEqual([]);
    const dialogues = new AgentDialogueService(network);
    expect(await dialogues.list(a.id)).toEqual([]);
    await network.requestConnection(a.id, b.id, {
      source: "opportunity",
      context: "Discuss the founding engineer opportunity.",
    });
    await drainAll();
    expect(await network.messages(a.id)).toEqual([]);
    expect(await dialogues.list(a.id)).toEqual([]);
    await network.connectionAction(b.id, a.id, "accept");
    await drainAll();
    expect((await discovery.opportunities(a.id))[0]).toMatchObject({
      id: recommendation.id,
      connected: true,
    });
    expect(await network.messages(a.id)).toEqual([]);
    expect((await dialogues.list(a.id))[0]).toMatchObject({
      status: "queued",
      turns: [],
    });
    await network.enqueue(a.id);
    await drainAll();
    expect(await dialogues.list(a.id)).toHaveLength(1);
  });
  it("does not create agent messages or change opportunity signatures when only private commitments change", async () => {
    await discoverable(a);
    await discoverable(b);
    await connect();
    await drainAll();
    const dialogues = new AgentDialogueService(network);
    const initialRound = (await dialogues.list(a.id))[0];
    const opportunity = (await discovery.opportunities(a.id))[0];
    const signature = (
      (await network.db
        .prepare("SELECT signature FROM network_opportunities WHERE id = ?")
        .get(opportunity.id)) as {
        signature: string;
      }
    ).signature;
    await update(a, (context) => {
      context.commitments = {
        status: "provided",
        items: [
          {
            date: "2026-11-05",
            start: "10:00",
            end: "11:00",
            title: "Private medical appointment",
          },
        ],
      };
    });
    expect((await queued()).map((job) => job.user_id)).toEqual([a.id]);
    await drainAll();
    expect(await network.messages(a.id)).toEqual([]);
    expect((await dialogues.list(a.id))[0]).toEqual(initialRound);
    expect(
      (
        (await network.db
          .prepare("SELECT signature FROM network_opportunities WHERE id = ?")
          .get(opportunity.id)) as {
          signature: string;
        }
      ).signature,
    ).toBe(signature);
    expect(JSON.stringify(await discovery.opportunities(b.id))).not.toContain(
      "Private medical appointment",
    );
    expect(JSON.stringify(await network.messages(b.id))).not.toContain(
      "Private medical appointment",
    );
  });
  it("never contacts unconnected matches or requests private data automatically", async () => {
    await discoverable(a);
    await discoverable(b);
    await drainAll();
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
    expect(await network.messages(a.id)).toEqual([]);
    await connect();
    await preferences(a, { visibility: { ...shared, profile: "private" } });
    await drainAll();
    expect(await network.messages(a.id)).toEqual([]);
    expect(await network.messages(b.id)).toEqual([]);
  });
  it("applies both global and per-event visibility without exposing private attendance", async () => {
    await discoverable(a);
    await discoverable(b);
    await discoverable(c);
    await discovery.saveEvent(
      b.id,
      event({
        title: "Private Dinner",
        url: "https://events.example.test/private",
        visibility: "private",
      }),
    );
    await discovery.saveEvent(
      b.id,
      event({
        title: "Friends Meetup",
        url: "https://events.example.test/friends",
        visibility: "friends",
      }),
    );
    await discovery.saveEvent(
      b.id,
      event({
        title: "Network Meetup",
        url: "https://events.example.test/network",
        visibility: "network",
      }),
    );
    expect(
      (await network.project(a.id, b.id)).events?.map((item) => item.title),
    ).toEqual(["Network Meetup"]);
    await connect();
    expect(
      (await network.project(a.id, b.id)).events
        ?.map((item) => item.title)
        .sort(),
    ).toEqual(["Friends Meetup", "Network Meetup"]);
    expect(
      (await network.project(c.id, b.id)).events?.map((item) => item.title),
    ).toEqual(["Network Meetup"]);
    await preferences(b, { visibility: { ...shared, events: "private" } });
    expect((await network.project(a.id, b.id)).events).toBeUndefined();
  });
  it("uses a shared public event link as evidence and improves a justified match's rank", async () => {
    await discoverable(a);
    await discoverable(b);
    await drainAll();
    const baseline = (await discovery.opportunities(a.id))[0].score;
    const first = await discovery.saveEvent(a.id, event());
    const second = await discovery.saveEvent(b.id, event());
    expect(first.id).not.toBe(second.id);
    await drainAll();
    const opportunity = (await discovery.opportunities(a.id))[0];
    expect(opportunity.score).toBeGreaterThan(baseline);
    expect(opportunity.sharedEvents).toHaveLength(1);
    expect(opportunity.reasons).toContain(
      "Both reported plans to attend AI Infrastructure Meetup.",
    );
    expect(opportunity.sharedEvents[0].sourceMode).toBe("user_report");
    await discovery.saveEvent(b.id, {
      ...event(),
      id: second.id,
      visibility: "private",
    });
    expect((await discovery.opportunities(a.id))[0].sharedEvents).toEqual([]);
  });
  it("never equates same-named events without a shared link or distinct query-based event IDs", async () => {
    await discoverable(a);
    await discoverable(b);
    await discovery.saveEvent(a.id, event({ url: undefined }));
    await discovery.saveEvent(b.id, event({ url: undefined }));
    await discovery.saveEvent(
      a.id,
      event({ url: "https://events.example.test/event?id=alpha" }),
    );
    await discovery.saveEvent(
      b.id,
      event({ url: "https://events.example.test/event?id=beta" }),
    );
    await drainAll();
    expect((await discovery.opportunities(a.id))[0].sharedEvents).toEqual([]);
  });
  it("recognizes identical instants written with different offsets and uses SF event dates", async () => {
    await discoverable(a);
    await discoverable(b);
    for (const person of [a, b])
      await update(person, (context) => {
        context.trip.start = "2026-11-05";
        context.trip.end = "2026-11-05";
      });
    await discovery.saveEvent(a.id, event());
    await discovery.saveEvent(
      b.id,
      event({ start: "2026-11-06T02:00:00Z", end: "2026-11-06T04:00:00Z" }),
    );
    await drainAll();
    expect((await discovery.opportunities(a.id))[0].sharedEvents).toHaveLength(
      1,
    );
  });
  it("guards event ownership and labels explicit demo fixtures", async () => {
    const stored = await discovery.saveEvent(a.id, event());
    await expect(
      discovery.saveEvent(b.id, { ...event(), id: stored.id }),
    ).rejects.toThrow();
    await discovery.removeEvent(b.id, stored.id);
    expect(await discovery.events(a.id)).toHaveLength(1);
    vi.stubEnv("SIDEKICK_DEMO", "1");
    vi.stubEnv("DATABASE_PATH", join(folder, "test.demo.sqlite"));
    expect((await discovery.saveEvent(c.id, event())).sourceMode).toBe("demo");
  });
  it("queues confirmed profile changes, coalesces triggers and deduplicates repeated drains", async () => {
    await discoverable(a);
    await discoverable(b);
    await drainAll();
    const initial = (await discovery.opportunities(a.id))[0];
    expect(await queued()).toEqual([]);
    await update(a, (context) => {
      context.profile.offers += " I also build Python systems.";
    });
    expect((await queued()).map((job) => job.user_id)).toEqual([a.id]);
    await network.enqueue(a.id);
    await network.enqueue(a.id);
    expect(await queued()).toHaveLength(1);
    expect((await queued())[0].version).toBe(3);
    await drainAll();
    await drainAll();
    expect(await opportunityCount()).toBe(1);
    expect((await discovery.opportunities(a.id))[0].id).toBe(initial.id);
    expect((await discovery.opportunities(a.id))[0].createdAt).toBe(
      initial.createdAt,
    );
    expect(await queued()).toEqual([]);
  });
  it("keeps failed jobs for retry and rolls back a partial matching transaction", async () => {
    await discoverable(a);
    await discoverable(b);
    const original = network.sharedEvents;
    network.sharedEvents = () => {
      throw new Error("Injected processing failure");
    };
    await expect(drainAll()).rejects.toThrow("Injected processing failure");
    expect(await queued()).toHaveLength(2);
    expect(await opportunityCount()).toBe(0);
    network.sharedEvents = original;
    await drainAll();
    expect(await queued()).toEqual([]);
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
  });
  it("persists independent dismissals across reprocessing, profile changes and restart", async () => {
    await discoverable(a);
    await discoverable(b);
    await drainAll();
    const id = (await discovery.opportunities(a.id))[0].id;
    await discovery.dismiss(c.id, id);
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
    await discovery.dismiss(a.id, id);
    expect(await discovery.opportunities(a.id)).toEqual([]);
    expect(await discovery.opportunities(b.id)).toHaveLength(1);
    await update(b, (context) => {
      context.profile.offers += " We support remote collaboration too.";
    });
    await drainAll();
    expect(await discovery.opportunities(a.id)).toEqual([]);
    store.close();
    store = new ContextStore(path);
    network = store.network;
    discovery = new DiscoveryService(network);
    expect(await discovery.opportunities(a.id)).toEqual([]);
    expect((await discovery.opportunities(b.id))[0].id).toBe(id);
  });
  it("bounds peer comparisons and resumes a durable cursor after reopening the database", async () => {
    await discoverable(a);
    await discoverable(b);
    for (const name of ["Devon", "Ellis", "Finley", "Gray", "Harper"])
      await discoverable(await account(name));
    await network.db.prepare("DELETE FROM network_jobs").run();
    await network.enqueue(a.id);
    const peers = (await network.db
      .prepare(
        `SELECT u.id FROM users u JOIN network_settings ns ON ns.user_id = u.id
        WHERE u.id != ? AND json_extract(ns.settings_json, '$.discoverable') = 1 ORDER BY u.id`,
      )
      .all(a.id)) as {
      id: string;
    }[];
    expect(await discovery.drain(2)).toBe(2);
    const partial = (await network.db
      .prepare("SELECT cursor, version FROM network_jobs WHERE user_id = ?")
      .get(a.id)) as {
      cursor: string;
      version: number;
    };
    expect(partial).toEqual({ cursor: peers[1].id, version: 1 });
    store.close();
    store = new ContextStore(path);
    network = store.network;
    discovery = new DiscoveryService(network);
    expect(await discovery.drain(1)).toBe(1);
    expect(
      await network.db
        .prepare("SELECT cursor FROM network_jobs WHERE user_id = ?")
        .get(a.id),
    ).toEqual({ cursor: peers[2].id });
    await network.enqueue(a.id);
    expect(
      await network.db
        .prepare("SELECT cursor, version FROM network_jobs WHERE user_id = ?")
        .get(a.id),
    ).toEqual({ cursor: "", version: 2 });
    await drainAll();
    expect(await queued()).toEqual([]);
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
  });
  it("finds an active pair in a bounded drain despite older inactive and unfinished accounts", async () => {
    for (let index = 0; index < 30; index++) {
      const inactive = await account(`Inactive${index}`);
      await network.enqueue(inactive.id);
      const unfinished = await store.registerAccount(
        `unfinished${index}@example.test`,
        "test-only-hash",
      );
      await network.enqueue(unfinished.account.id);
    }
    // Make every inactive job older than the active pair's update.
    await network.db
      .prepare(
        "UPDATE network_jobs SET updated_at = '2026-10-23T00:00:00.000Z'",
      )
      .run();
    await discoverable(a);
    await discoverable(b);
    expect(await queued()).toHaveLength(62);
    expect(await discovery.drain()).toBe(2);
    expect(await discovery.opportunities(a.id)).toHaveLength(1);
    expect(await queued()).toEqual([]);
    expect(await network.messages(a.id)).toEqual([]);
  });
  it("lets only one client drain at once and deduplicates collaboration across clients", async () => {
    await discoverable(a);
    await discoverable(b);
    await connect();
    const secondStore = new ContextStore(path);
    const secondDiscovery = new DiscoveryService(secondStore.network);
    try {
      await secondStore.network.settings(a.id);
      const result = await Promise.all([
        discovery.drain(1),
        secondDiscovery.drain(1),
      ]);
      expect(result.sort()).toEqual([0, 1]);
      await drainAll();
      expect(await opportunityCount()).toBe(1);
      expect(await new AgentDialogueService(secondStore.network).list(a.id)).toHaveLength(1);
      await secondStore.network.enqueue(b.id);
      await secondDiscovery.drain();
      expect(await new AgentDialogueService(network).list(a.id)).toHaveLength(1);
    } finally {
      secondStore.close();
    }
  });
  it("retries expired worker leases without an old worker releasing the new lease", async () => {
    await discoverable(a);
    await discoverable(b);
    await network.enqueue(a.id);
    const oldLease = await network.db.acquireLease("network-discovery", 1000);
    expect(oldLease).toBeTruthy();
    expect(await discovery.drain(1)).toBe(0);
    vi.setSystemTime(new Date(Date.now() + 1001));
    const newLease = await network.db.acquireLease("network-discovery", 1000);
    expect(newLease).toBeTruthy();
    await network.db.releaseLease("network-discovery", oldLease!);
    expect(await discovery.drain(1)).toBe(0);
    await network.db.releaseLease("network-discovery", newLease!);
    expect(await discovery.drain(1)).toBe(1);
  });
  it("enqueues the daily sweep once across independent cold starts and never starts a Vercel timer", async () => {
    const secondStore = new ContextStore(path);
    try {
      const results = await Promise.all([
        enqueueDailyNetworkWork(network),
        enqueueDailyNetworkWork(secondStore.network),
      ]);
      expect(results.sort()).toEqual([false, true]);
      expect(await queued()).toHaveLength(3);
      expect((await queued()).map((job) => job.version)).toEqual([1, 1, 1]);
      await drainAll();
      expect(await enqueueDailyNetworkWork(secondStore.network)).toBe(false);
      expect(await queued()).toEqual([]);
      vi.setSystemTime(new Date("2026-10-25T17:00:00Z"));
      vi.mocked(Temporal.Now.plainDateISO).mockReturnValue(
        Temporal.PlainDate.from("2026-10-25"),
      );
      expect(await enqueueDailyNetworkWork(secondStore.network)).toBe(true);
      expect(await queued()).toHaveLength(3);
      vi.stubEnv("VERCEL", "1");
      const timers = vi.getTimerCount();
      startNetworkWorker();
      expect(vi.getTimerCount()).toBe(timers);
    } finally {
      secondStore.close();
    }
  });
});
