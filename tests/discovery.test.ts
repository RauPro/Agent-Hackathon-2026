import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore } from "../src/lib/server/store";
import { DiscoveryService } from "../src/lib/server/discovery-service";
import type { NetworkStore } from "../src/lib/server/network-store";
import type { NetworkSettingsInput } from "../src/lib/domain/network";
import type { NetworkEventInput } from "../src/lib/domain/discovery";
import type { UserContext } from "../src/lib/domain/context";
import { validContext } from "./fixtures";

type TestAccount = { id: string; token: string };
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

function account(name: string, hiring = false): TestAccount {
  const registration = store.registerAccount(
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
  store.save(registration.token, {
    context,
    baseRevision: 0,
    requestId: randomUUID(),
  });
  return { id: registration.account.id, token: registration.token };
}

function preferences(
  person: TestAccount,
  changes: Partial<NetworkSettingsInput> = {},
) {
  const current = network.settings(person.id);
  return network.saveSettings(person.id, {
    discoverable: current.discoverable,
    visibility: current.visibility,
    area: current.area,
    revision: current.revision,
    ...changes,
  });
}

function discoverable(person: TestAccount) {
  preferences(person, { discoverable: true, visibility: shared });
}

function update(person: TestAccount, edit: (context: UserContext) => void) {
  const state = store.read(person.token)!;
  const context = structuredClone(state.context!);
  edit(context);
  return store.save(person.token, {
    context,
    baseRevision: state.revision,
    requestId: randomUUID(),
  });
}

function connect() {
  network.requestConnection(a.id, b.id, {
    source: "qr",
    token: network.settings(b.id).qrToken,
    context: "Met at a technology event.",
  });
  network.connectionAction(b.id, a.id, "accept");
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

function queued() {
  return network.db
    .prepare("SELECT user_id, version FROM network_jobs ORDER BY user_id")
    .all() as { user_id: string; version: number }[];
}
function opportunityCount() {
  return (
    network.db
      .prepare("SELECT COUNT(*) AS count FROM network_opportunities")
      .get() as { count: number }
  ).count;
}

beforeEach(() => {
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
  a = account("Alex");
  b = account("Blair", true);
  c = account("Casey");
  discovery.drain();
});

afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("proactive discovery with authorized context", () => {
  it("creates one reciprocal, evidence-backed opportunity for complementary goals", () => {
    discoverable(a);
    discoverable(b);
    update(b, (context) => {
      context.trip.start = "2026-11-01";
    });
    expect(discovery.opportunities(a.id)).toHaveLength(0);
    discovery.drain();
    const forA = discovery.opportunities(a.id),
      forB = discovery.opportunities(b.id);
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
    expect(opportunityCount()).toBe(1);
    expect(JSON.stringify(forA)).not.toMatch(
      /password|calendar|@example.test|qrToken/,
    );
  });

  it("requires useful evidence in both directions and changes with professional goals", () => {
    discoverable(a);
    discoverable(b);
    update(b, (context) => {
      context.goal.text =
        "Hire a marine biologist specializing in coral conservation.";
    });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    update(b, (context) => {
      context.goal = {
        type: "hiring",
        text: "Hire a founding engineer to build AI agent infrastructure.",
      };
    });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toHaveLength(1);
    update(a, (context) => {
      context.goal = {
        type: "customers",
        text: "Find customers for my AI infrastructure consulting service.",
      };
    });
    expect(discovery.opportunities(a.id)).toEqual([]);
    discovery.drain();
    expect(discovery.opportunities(b.id)).toEqual([]);
  });

  it("does not recommend contradictory explicitly named roles", () => {
    discoverable(a);
    discoverable(b);
    update(b, (context) => {
      context.goal.text =
        "Hire an AI sales director for my infrastructure startup.";
    });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
  });

  it("supports the stated CTO and ICPC opportunity when both goals and profiles supply evidence", () => {
    discoverable(a);
    discoverable(b);
    update(a, (context) => {
      context.profile.bio =
        "Engineer with ICPC competitive programming experience and production software projects.";
      context.profile.offers =
        "Algorithms and competitive programming expertise for an early-stage technical team.";
      context.goal.text =
        "Explore technical leadership and CTO roles at algorithms startups.";
    });
    update(b, (context) => {
      context.profile.bio =
        "Founder building an algorithms startup and production optimization systems.";
      context.profile.offers =
        "A funded algorithms startup seeking technical leadership and product experience.";
      context.goal.text =
        "Hire a CTO with ICPC or competitive programming experience for algorithms products.";
    });
    discovery.drain();
    expect(discovery.opportunities(a.id)[0].signals).toContain("algorithms");
    expect(discovery.opportunities(b.id)).toHaveLength(1);
    update(a, (context) => {
      context.goal.text =
        "Find a founding engineer role working on algorithms and optimization.";
    });
    expect(discovery.opportunities(a.id)).toEqual([]);
  });

  it("excludes unconfirmed profiles even after an explicit discovery opt-in", () => {
    discoverable(a);
    const draftOnly = store.registerAccount(
      "draft-only@example.test",
      "test-only-hash",
    );
    discoverable({ id: draftOnly.account.id, token: draftOnly.token });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    expect(discovery.opportunities(draftOnly.account.id)).toEqual([]);
  });

  it("rejects nonoverlapping and fully past stays and clamps current overlap to today", () => {
    discoverable(a);
    discoverable(b);
    update(b, (context) => {
      context.trip.start = "2026-12-01";
      context.trip.end = "2026-12-15";
    });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    for (const person of [a, b])
      update(person, (context) => {
        context.trip.start = "2026-10-01";
        context.trip.end = "2026-10-20";
      });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    for (const person of [a, b])
      update(person, (context) => {
        context.trip.end = "2026-10-25";
      });
    discovery.drain();
    expect(discovery.opportunities(a.id)[0].overlap).toEqual({
      start: "2026-10-24",
      end: "2026-10-25",
    });
  });

  it("excludes opt-outs and private matching fields, including saved recommendations after revocation", () => {
    discoverable(a);
    preferences(b, { visibility: shared });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    discoverable(b);
    discovery.drain();
    expect(discovery.opportunities(a.id)).toHaveLength(1);
    preferences(b, { visibility: { ...shared, goal: "private" } });
    expect(discovery.opportunities(a.id)).toEqual([]);
    discoverable(b);
    discovery.drain();
    expect(discovery.opportunities(a.id)).toHaveLength(1);
    preferences(b, { discoverable: false });
    expect(discovery.opportunities(a.id)).toEqual([]);
    expect(() =>
      network.requestConnection(a.id, b.id, {
        source: "opportunity",
        context: "Discuss a role.",
      }),
    ).toThrow();
  });

  it("allows friends-only matching after acceptance while honoring blocks and per-field privacy", () => {
    preferences(a, {
      visibility: {
        profile: "friends",
        goal: "friends",
        trip: "friends",
        events: "friends",
      },
    });
    preferences(b, {
      visibility: {
        profile: "friends",
        goal: "friends",
        trip: "friends",
        events: "friends",
      },
    });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    connect();
    discovery.drain();
    expect(discovery.opportunities(a.id)[0].connected).toBe(true);
    expect(network.settings(a.id).discoverable).toBe(false);
    network.connectionAction(b.id, a.id, "block");
    expect(discovery.opportunities(a.id)).toEqual([]);
    expect(discovery.opportunities(b.id)).toEqual([]);
  });

  it("suggests a shared-event reunion for connected people with matching interests even without complementary jobs", () => {
    discoverable(a);
    discoverable(b);
    update(b, (context) => {
      context.goal = {
        type: "seeking_role",
        text: "Find an AI infrastructure engineering role.",
      };
    });
    discovery.saveEvent(a.id, event());
    const attendance = discovery.saveEvent(b.id, event());
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    connect();
    discovery.drain();
    const reunion = discovery.opportunities(a.id)[0];
    expect(reunion.sharedEvents).toHaveLength(1);
    expect(reunion.benefits.you).toContain("Reconnect");
    expect(reunion.benefits.you).not.toContain("hiring");
    discovery.saveEvent(b.id, {
      ...event(),
      id: attendance.id,
      visibility: "private",
    });
    expect(discovery.opportunities(a.id)).toEqual([]);
  });

  it("persists one authorized agent query for a connected match and only creates another for changed context", () => {
    discoverable(a);
    discoverable(b);
    connect();
    discovery.drain();
    const initial = network.messages(a.id);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      fromUserId: b.id,
      toUserId: a.id,
      fields: ["profile", "goal"],
      status: "completed",
    });
    expect(initial[0].response.profile?.source).toBe("confirmed_profile");
    network.enqueue(a.id);
    network.enqueue(b.id);
    discovery.drain();
    expect(network.messages(a.id)).toHaveLength(1);
    update(b, (context) => {
      context.goal.text += " The role focuses on Python systems.";
    });
    discovery.drain();
    expect(network.messages(a.id)).toHaveLength(2);
    expect(network.messages(b.id)).toHaveLength(2);
    expect(network.messages(c.id)).toEqual([]);
  });

  it("starts authorized collaboration when a previously recommended pair accepts the connection", () => {
    discoverable(a);
    discoverable(b);
    discovery.drain();
    const recommendation = discovery.opportunities(a.id)[0];
    expect(recommendation.connected).toBe(false);
    expect(network.messages(a.id)).toEqual([]);
    network.requestConnection(a.id, b.id, {
      source: "opportunity",
      context: "Discuss the founding engineer opportunity.",
    });
    discovery.drain();
    expect(network.messages(a.id)).toEqual([]);
    network.connectionAction(b.id, a.id, "accept");
    discovery.drain();
    expect(discovery.opportunities(a.id)[0]).toMatchObject({
      id: recommendation.id,
      connected: true,
    });
    expect(network.messages(a.id)).toHaveLength(1);
    expect(network.messages(a.id)[0]).toMatchObject({
      type: "PROFILE_QUERY",
      status: "completed",
    });
    network.enqueue(a.id);
    discovery.drain();
    expect(network.messages(a.id)).toHaveLength(1);
  });

  it("does not create agent messages or change opportunity signatures when only private commitments change", () => {
    discoverable(a);
    discoverable(b);
    connect();
    discovery.drain();
    const initialMessage = network.messages(a.id)[0];
    const opportunity = discovery.opportunities(a.id)[0];
    const signature = (
      network.db
        .prepare("SELECT signature FROM network_opportunities WHERE id = ?")
        .get(opportunity.id) as { signature: string }
    ).signature;
    update(a, (context) => {
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
    expect(queued().map((job) => job.user_id)).toEqual([a.id]);
    discovery.drain();
    expect(network.messages(a.id)).toHaveLength(1);
    expect(network.messages(a.id)[0].id).toBe(initialMessage.id);
    expect(
      (
        network.db
          .prepare("SELECT signature FROM network_opportunities WHERE id = ?")
          .get(opportunity.id) as { signature: string }
      ).signature,
    ).toBe(signature);
    expect(JSON.stringify(discovery.opportunities(b.id))).not.toContain(
      "Private medical appointment",
    );
    expect(JSON.stringify(network.messages(b.id))).not.toContain(
      "Private medical appointment",
    );
  });

  it("never contacts unconnected matches or requests private data automatically", () => {
    discoverable(a);
    discoverable(b);
    discovery.drain();
    expect(discovery.opportunities(a.id)).toHaveLength(1);
    expect(network.messages(a.id)).toEqual([]);
    connect();
    preferences(a, { visibility: { ...shared, profile: "private" } });
    discovery.drain();
    expect(network.messages(a.id)).toEqual([]);
    expect(network.messages(b.id)).toEqual([]);
  });

  it("applies both global and per-event visibility without exposing private attendance", () => {
    discoverable(a);
    discoverable(b);
    discoverable(c);
    discovery.saveEvent(
      b.id,
      event({
        title: "Private Dinner",
        url: "https://events.example.test/private",
        visibility: "private",
      }),
    );
    discovery.saveEvent(
      b.id,
      event({
        title: "Friends Meetup",
        url: "https://events.example.test/friends",
        visibility: "friends",
      }),
    );
    discovery.saveEvent(
      b.id,
      event({
        title: "Network Meetup",
        url: "https://events.example.test/network",
        visibility: "network",
      }),
    );
    expect(
      network.project(a.id, b.id).events?.map((item) => item.title),
    ).toEqual(["Network Meetup"]);
    connect();
    expect(
      network
        .project(a.id, b.id)
        .events?.map((item) => item.title)
        .sort(),
    ).toEqual(["Friends Meetup", "Network Meetup"]);
    expect(
      network.project(c.id, b.id).events?.map((item) => item.title),
    ).toEqual(["Network Meetup"]);
    preferences(b, { visibility: { ...shared, events: "private" } });
    expect(network.project(a.id, b.id).events).toBeUndefined();
  });

  it("uses a shared public event link as evidence and improves a justified match's rank", () => {
    discoverable(a);
    discoverable(b);
    discovery.drain();
    const baseline = discovery.opportunities(a.id)[0].score;
    const first = discovery.saveEvent(a.id, event());
    const second = discovery.saveEvent(b.id, event());
    expect(first.id).not.toBe(second.id);
    discovery.drain();
    const opportunity = discovery.opportunities(a.id)[0];
    expect(opportunity.score).toBeGreaterThan(baseline);
    expect(opportunity.sharedEvents).toHaveLength(1);
    expect(opportunity.reasons).toContain(
      "Both reported plans to attend AI Infrastructure Meetup.",
    );
    expect(opportunity.sharedEvents[0].sourceMode).toBe("user_report");
    discovery.saveEvent(b.id, {
      ...event(),
      id: second.id,
      visibility: "private",
    });
    expect(discovery.opportunities(a.id)[0].sharedEvents).toEqual([]);
  });

  it("never equates same-named events without a shared link or distinct query-based event IDs", () => {
    discoverable(a);
    discoverable(b);
    discovery.saveEvent(a.id, event({ url: undefined }));
    discovery.saveEvent(b.id, event({ url: undefined }));
    discovery.saveEvent(
      a.id,
      event({ url: "https://events.example.test/event?id=alpha" }),
    );
    discovery.saveEvent(
      b.id,
      event({ url: "https://events.example.test/event?id=beta" }),
    );
    discovery.drain();
    expect(discovery.opportunities(a.id)[0].sharedEvents).toEqual([]);
  });

  it("recognizes identical instants written with different offsets and uses SF event dates", () => {
    discoverable(a);
    discoverable(b);
    for (const person of [a, b])
      update(person, (context) => {
        context.trip.start = "2026-11-05";
        context.trip.end = "2026-11-05";
      });
    discovery.saveEvent(a.id, event());
    discovery.saveEvent(
      b.id,
      event({ start: "2026-11-06T02:00:00Z", end: "2026-11-06T04:00:00Z" }),
    );
    discovery.drain();
    expect(discovery.opportunities(a.id)[0].sharedEvents).toHaveLength(1);
  });

  it("guards event ownership and labels explicit demo fixtures", () => {
    const stored = discovery.saveEvent(a.id, event());
    expect(() =>
      discovery.saveEvent(b.id, { ...event(), id: stored.id }),
    ).toThrow();
    discovery.removeEvent(b.id, stored.id);
    expect(discovery.events(a.id)).toHaveLength(1);
    vi.stubEnv("SIDEKICK_DEMO", "1");
    vi.stubEnv("DATABASE_PATH", join(folder, "test.demo.sqlite"));
    expect(discovery.saveEvent(c.id, event()).sourceMode).toBe("demo");
  });

  it("queues confirmed profile changes, coalesces triggers and deduplicates repeated drains", () => {
    discoverable(a);
    discoverable(b);
    discovery.drain();
    const initial = discovery.opportunities(a.id)[0];
    expect(queued()).toEqual([]);
    update(a, (context) => {
      context.profile.offers += " I also build Python systems.";
    });
    expect(queued().map((job) => job.user_id)).toEqual([a.id]);
    network.enqueue(a.id);
    network.enqueue(a.id);
    expect(queued()).toHaveLength(1);
    expect(queued()[0].version).toBe(3);
    discovery.drain();
    discovery.drain();
    expect(opportunityCount()).toBe(1);
    expect(discovery.opportunities(a.id)[0].id).toBe(initial.id);
    expect(discovery.opportunities(a.id)[0].createdAt).toBe(initial.createdAt);
    expect(queued()).toEqual([]);
  });

  it("keeps failed jobs for retry and rolls back a partial matching transaction", () => {
    discoverable(a);
    discoverable(b);
    const original = network.sharedEvents;
    network.sharedEvents = () => {
      throw new Error("Injected processing failure");
    };
    expect(() => discovery.drain()).toThrow("Injected processing failure");
    expect(queued()).toHaveLength(2);
    expect(opportunityCount()).toBe(0);
    network.sharedEvents = original;
    discovery.drain();
    expect(queued()).toEqual([]);
    expect(discovery.opportunities(a.id)).toHaveLength(1);
  });

  it("persists independent dismissals across reprocessing, profile changes and restart", () => {
    discoverable(a);
    discoverable(b);
    discovery.drain();
    const id = discovery.opportunities(a.id)[0].id;
    discovery.dismiss(c.id, id);
    expect(discovery.opportunities(a.id)).toHaveLength(1);
    discovery.dismiss(a.id, id);
    expect(discovery.opportunities(a.id)).toEqual([]);
    expect(discovery.opportunities(b.id)).toHaveLength(1);
    update(b, (context) => {
      context.profile.offers += " We support remote collaboration too.";
    });
    discovery.drain();
    expect(discovery.opportunities(a.id)).toEqual([]);
    store.close();
    store = new ContextStore(path);
    network = store.network;
    discovery = new DiscoveryService(network);
    expect(discovery.opportunities(a.id)).toEqual([]);
    expect(discovery.opportunities(b.id)[0].id).toBe(id);
  });
});
