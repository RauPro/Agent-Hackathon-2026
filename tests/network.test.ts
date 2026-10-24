import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ContextStore } from "../src/lib/server/store";
import { NetworkStore } from "../src/lib/server/network-store";
import {
  informationRequestSchema,
  type NetworkSettingsInput,
} from "../src/lib/domain/network";
import { validContext } from "./fixtures";

let folder: string,
  path: string,
  store: ContextStore,
  db: Database.Database,
  network: NetworkStore;
let a: string, b: string, c: string;
function account(name: string) {
  const registration = store.registerAccount(
    `${name.toLowerCase()}@example.test`,
    "test-only-hash",
  );
  const context = validContext();
  context.profile.name = `${name} Example`;
  context.commitments = {
    status: "provided",
    items: [
      {
        date: "2026-10-25",
        start: "13:00",
        end: "14:00",
        title: "Private appointment",
      },
    ],
  };
  store.save(registration.token, {
    context,
    baseRevision: 0,
    requestId: randomUUID(),
  });
  return registration.account.id;
}
function settings(id: string, changes: Partial<NetworkSettingsInput> = {}) {
  const current = network.settings(id);
  return network.saveSettings(id, {
    discoverable: current.discoverable,
    visibility: current.visibility,
    area: current.area,
    revision: current.revision,
    ...changes,
  });
}
function connect(first = a, second = b) {
  network.requestConnection(first, second, {
    source: "qr",
    token: network.settings(second).qrToken,
    context: "Met at an AI event.",
  });
  network.connectionAction(second, first, "accept");
}
function query(
  fields: ("profile" | "goal" | "trip" | "events")[] = ["profile"],
) {
  return {
    toUserId: b,
    requestId: randomUUID(),
    fields,
    purpose: "Explore an early-stage engineering opportunity.",
  };
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sidekick-network-"));
  path = join(folder, "test.sqlite");
  store = new ContextStore(path);
  db = new Database(path);
  db.pragma("foreign_keys = ON");
  network = new NetworkStore(db);
  a = account("Alex");
  b = account("Blair");
  c = account("Casey");
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe("authorized social graph and agent messages", () => {
  it("starts private and resolves a QR to a name only, without creating a relationship", () => {
    const current = network.settings(b);
    expect(current.discoverable).toBe(false);
    expect(Object.values(current.visibility)).toEqual([
      "private",
      "private",
      "private",
      "private",
    ]);
    expect(network.resolveQr(a, current.qrToken)).toEqual({
      id: b,
      name: "Blair Example",
    });
    expect(network.isConnected(a, b)).toBe(false);
    expect(() => network.project(a, b)).toThrow();
    network.rotateQr(b);
    expect(() => network.resolveQr(a, current.qrToken)).toThrow();
  });

  it("requires the target's acceptance and deduplicates scans in either direction", () => {
    const input = {
      source: "qr" as const,
      token: network.settings(b).qrToken,
      context: "Met at an AI event.",
    };
    expect(network.requestConnection(a, b, input).status).toBe("pending");
    network.requestConnection(a, b, input);
    expect(network.connections(a)).toHaveLength(1);
    expect(() => network.connectionAction(a, b, "accept")).toThrow();
    expect(
      network.requestConnection(b, a, {
        ...input,
        token: network.settings(a).qrToken,
      }).direction,
    ).toBe("incoming");
    expect(network.isConnected(a, b)).toBe(false);
    network.connectionAction(b, a, "accept");
    expect(network.isConnected(a, b)).toBe(true);
    expect(network.isConnected(b, a)).toBe(true);
  });

  it("waits a day before retrying a declined connection and cannot bypass the cooldown by removing or blocking", () => {
    vi.useFakeTimers();
    const start = new Date("2026-10-24T17:00:00Z");
    vi.setSystemTime(start);
    const input = {
      source: "qr" as const,
      token: network.settings(b).qrToken,
      context: "Discuss a shared interest.",
    };
    const pending = network.requestConnection(a, b, input);
    expect(network.requestConnection(a, b, input)).toEqual(pending);
    const declined = network.connectionAction(b, a, "decline");
    expect(declined?.status).toBe("removed");
    expect(network.connections(a)).toEqual([]);
    expect(network.connections(b)).toEqual([]);
    expect(() => network.requestConnection(a, b, input)).toThrow("Wait a day");
    network.connectionAction(a, b, "remove");
    expect(() => network.requestConnection(a, b, input)).toThrow("Wait a day");
    network.connectionAction(a, b, "block");
    network.connectionAction(a, b, "unblock");
    expect(() => network.requestConnection(a, b, input)).toThrow("Wait a day");
    vi.setSystemTime(new Date(start.getTime() + 86400000 - 1));
    expect(() => network.requestConnection(a, b, input)).toThrow("Wait a day");
    vi.setSystemTime(new Date(start.getTime() + 86400000));
    expect(network.requestConnection(a, b, input).status).toBe("pending");
    network.connectionAction(b, a, "accept");
    expect(network.isConnected(a, b)).toBe(true);
  });

  it("rejects forged QR targets, unavailable opportunities and unconnected agent requests", () => {
    expect(() =>
      network.requestConnection(a, b, {
        source: "qr",
        token: network.settings(c).qrToken,
        context: "Hello",
      }),
    ).toThrow();
    expect(() =>
      network.requestConnection(a, b, {
        source: "opportunity",
        context: "Hello",
      }),
    ).toThrow();
    expect(() => network.requestInformation(a, query())).toThrow();
    expect(
      informationRequestSchema.safeParse({
        ...query(),
        senderAgentId: `agent:${c}`,
      }).success,
    ).toBe(false);
    expect(
      informationRequestSchema.safeParse({
        ...query(),
        fields: ["calendar", "password"],
      }).success,
    ).toBe(false);
  });

  it("projects only permitted confirmed fields and never emails, calendars or commitments", () => {
    connect();
    settings(b, {
      visibility: {
        profile: "friends",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    const projected = network.project(a, b);
    expect(projected.profile?.name).toBe("Blair Example");
    expect(projected.goal).toBeUndefined();
    expect(projected.trip).toBeUndefined();
    expect(JSON.stringify(projected)).not.toMatch(
      /email|commitments|Private appointment|calendar|password|qrToken/,
    );
    expect(() => network.project(c, b)).toThrow();
    settings(b, {
      discoverable: true,
      visibility: {
        profile: "network",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    expect(network.project(c, b).profile?.name).toBe("Blair Example");
  });

  it("records typed agent identities, authorized answers and pending owner questions", () => {
    connect();
    settings(b, {
      visibility: {
        profile: "friends",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    const message = network.requestInformation(a, query(["profile", "goal"]));
    expect(message).toMatchObject({
      senderAgentId: `agent:${a}`,
      recipientAgentId: `agent:${b}`,
      representedUserId: a,
      status: "needs_user",
      type: "PROFILE_QUERY",
    });
    expect(message.response.profile).toMatchObject({
      status: "shared",
      source: "confirmed_profile",
    });
    expect(message.response.goal).toEqual({ status: "not_shared" });
    expect(network.messages(c)).toHaveLength(0);
    expect(() =>
      network.answerInformation(a, {
        messageId: message.id,
        answers: { goal: "I want a technical role." },
        decline: false,
      }),
    ).toThrow();
    expect(() =>
      network.answerInformation(c, {
        messageId: message.id,
        answers: { goal: "I want a technical role." },
        decline: false,
      }),
    ).toThrow();
    const reply = network.answerInformation(b, {
      messageId: message.id,
      answers: { goal: "I am open to discussing this engineering role." },
      decline: false,
    });
    expect(reply.status).toBe("completed");
    expect(reply.response.goal).toEqual({
      status: "shared",
      value: "I am open to discussing this engineering role.",
      source: "user_answer",
    });
    expect(network.project(a, b).goal).toBeUndefined();
  });

  it("records the actual request, agent response and owner answer times without rewriting shared snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T17:00:00Z"));
    connect();
    settings(b, {
      visibility: {
        profile: "friends",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    const message = network.requestInformation(a, query(["profile", "goal"]));
    expect(message.trigger).toBe("user");
    expect(message.activity.map((entry) => entry.kind)).toEqual([
      "request",
      "response",
      "permission_needed",
    ]);
    expect(message.activity[0]).toMatchObject({
      at: "2026-10-24T17:00:00.000Z",
      actorUserId: a,
      fields: ["profile", "goal"],
    });
    expect(message.activity[1]).toMatchObject({
      at: "2026-10-24T17:00:00.000Z",
      actorUserId: b,
      fields: ["profile"],
      response: { profile: { value: { name: "Blair Example" } } },
    });
    expect(message.activity[2].fields).toEqual(["goal"]);

    vi.setSystemTime(new Date("2026-10-24T17:45:00Z"));
    const answer = network.answerInformation(b, {
      messageId: message.id,
      answers: { goal: "I am open to a founding engineer role." },
      decline: false,
    });
    expect(answer.activity.slice(0, 3)).toEqual(message.activity);
    expect(answer.activity[3]).toMatchObject({
      kind: "user_answer",
      at: "2026-10-24T17:45:00.000Z",
      actorUserId: b,
      shareRevision: network.settings(b).revision,
      response: {
        goal: {
          status: "shared",
          source: "user_answer",
          value: "I am open to a founding engineer role.",
        },
      },
    });
    expect(new Set(answer.activity.map((entry) => entry.id)).size).toBe(4);

    const changed = network.profile(b).context!;
    changed.profile.name = "Blair Updated";
    db.prepare(
      "UPDATE sessions SET context_json = ? WHERE token_hash = (SELECT profile_id FROM users WHERE id = ?)",
    ).run(JSON.stringify(changed), b);
    const later = network.messages(a)[0];
    expect(later.response.profile?.value).toMatchObject({
      name: "Blair Updated",
    });
    expect(later.activity).toEqual(answer.activity);
  });

  it("does not append activity on partial answer retries and records decline only once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T17:00:00Z"));
    connect();
    const message = network.requestInformation(a, query(["profile", "goal"]));
    expect(message.activity.map((entry) => entry.kind)).toEqual([
      "request",
      "permission_needed",
    ]);
    const input = {
      messageId: message.id,
      answers: { profile: "I work on infrastructure." },
      decline: false,
    };
    vi.setSystemTime(new Date("2026-10-24T18:00:00Z"));
    const partial = network.answerInformation(b, input);
    expect(partial.status).toBe("needs_user");
    vi.setSystemTime(new Date("2026-10-24T18:30:00Z"));
    expect(network.answerInformation(b, input).activity).toEqual(
      partial.activity,
    );
    const decline = { messageId: message.id, answers: {}, decline: true };
    const declined = network.answerInformation(b, decline);
    expect(declined.activity).toHaveLength(4);
    expect(declined.activity[3]).toMatchObject({
      kind: "declined",
      at: "2026-10-24T18:30:00.000Z",
      actorUserId: b,
    });
    vi.setSystemTime(new Date("2026-10-24T19:00:00Z"));
    expect(network.answerInformation(b, decline).activity).toEqual(
      declined.activity,
    );
  });

  it("accepts discovery provenance only from the internal caller and preserves it on retries", () => {
    connect();
    const input = query();
    expect(
      informationRequestSchema.safeParse({ ...input, trigger: "discovery" })
        .success,
    ).toBe(false);
    const discovered = network.requestInformation(a, input, {
      trigger: "discovery",
    });
    expect(discovered.trigger).toBe("discovery");
    expect(network.requestInformation(a, input)).toEqual(discovered);
  });

  it("keeps legacy requests readable without inventing response history or timestamps", () => {
    connect();
    settings(b, {
      visibility: {
        profile: "friends",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    const message = network.requestInformation(a, query());
    const legacy = { ...message } as Partial<typeof message>;
    delete legacy.activity;
    delete legacy.trigger;
    db.prepare("UPDATE agent_messages SET message_json = ? WHERE id = ?").run(
      JSON.stringify(legacy),
      message.id,
    );
    const loaded = network.messages(a)[0];
    expect(loaded.response.profile?.status).toBe("shared");
    expect(loaded.activity).toEqual([
      {
        id: `${message.id}:request`,
        kind: "request",
        at: message.createdAt,
        actorUserId: a,
        fields: ["profile"],
      },
    ]);
    expect(network.messages(a)[0].activity).toEqual(loaded.activity);
  });

  it("hides historical event details when their individual sharing permission is removed", () => {
    connect();
    settings(b, {
      visibility: {
        profile: "private",
        goal: "private",
        trip: "private",
        events: "friends",
      },
    });
    const event = {
      id: "shared-event",
      title: "Infrastructure meetup",
      start: "2026-10-25T17:00:00Z",
      end: "2026-10-25T18:00:00Z",
      sourceMode: "user_report" as const,
    };
    network.sharedEvents = () => [event];
    const message = network.requestInformation(a, query(["events"]));
    expect(message.activity[1].response?.events?.value).toEqual([event]);
    network.sharedEvents = () => [];
    const result = network.messages(a)[0];
    expect(result.activity[1].response?.events).toEqual({
      status: "not_shared",
    });
    expect(JSON.stringify(result)).not.toContain("Infrastructure meetup");
  });

  it("deduplicates exact requests and owner answer retries, rejects reused keys and extra fields", () => {
    connect();
    const input = query();
    const message = network.requestInformation(a, input);
    expect(network.requestInformation(a, input)).toEqual(message);
    expect(network.messages(a)).toHaveLength(1);
    expect(() =>
      network.requestInformation(a, {
        ...input,
        purpose: "A different opportunity.",
      }),
    ).toThrow();
    expect(() =>
      network.answerInformation(b, {
        messageId: message.id,
        answers: { trip: "Tomorrow" },
        decline: false,
      }),
    ).toThrow();
    const answer = {
      messageId: message.id,
      answers: { profile: "I build agent infrastructure." },
      decline: false,
    };
    const result = network.answerInformation(b, answer);
    expect(network.answerInformation(b, answer)).toEqual(result);
    expect(() =>
      network.answerInformation(b, {
        ...answer,
        answers: { profile: "Changed response" },
      }),
    ).toThrow();
  });

  it("rechecks field permissions on every retrieval and revokes one-shot answers on settings changes", () => {
    connect();
    settings(b, {
      visibility: {
        profile: "friends",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    const message = network.requestInformation(a, query(["profile", "goal"]));
    network.answerInformation(b, {
      messageId: message.id,
      answers: { goal: "Private answer for this request only." },
      decline: false,
    });
    settings(b, {
      visibility: {
        profile: "private",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    const result = network.messages(a)[0];
    expect(result.response.profile).toEqual({ status: "not_shared" });
    expect(result.response.goal).toEqual({ status: "not_shared" });
    expect(JSON.stringify(result)).not.toContain("Private answer");
    expect(JSON.stringify(result.activity)).not.toContain('"name"');
    expect(
      result.activity.find((entry) => entry.kind === "response")?.response
        ?.profile,
    ).toEqual({ status: "not_shared" });
    expect(
      result.activity.find((entry) => entry.kind === "user_answer")?.response
        ?.goal,
    ).toEqual({ status: "not_shared" });
    expect(JSON.stringify(network.messages(b)[0].activity)).not.toContain(
      "Private answer",
    );

    // Later answers must not persist a redacted replacement for older history.
    const rawBefore = JSON.parse(
      (
        db
          .prepare("SELECT message_json FROM agent_messages WHERE id = ?")
          .get(message.id) as { message_json: string }
      ).message_json,
    );
    network.answerInformation(b, {
      messageId: message.id,
      answers: { goal: "A newly authorized answer." },
      decline: false,
    });
    const rawAfter = JSON.parse(
      (
        db
          .prepare("SELECT message_json FROM agent_messages WHERE id = ?")
          .get(message.id) as { message_json: string }
      ).message_json,
    );
    expect(rawAfter.activity.slice(0, rawBefore.activity.length)).toEqual(
      rawBefore.activity,
    );
    const visible = network.messages(a)[0];
    expect(JSON.stringify(visible.activity)).not.toContain("Private answer");
    expect(JSON.stringify(visible.activity)).toContain(
      "A newly authorized answer.",
    );
  });

  it("removes access immediately and never resurrects messages after reconnection", () => {
    connect();
    settings(b, {
      visibility: {
        profile: "friends",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    network.requestInformation(a, query());
    network.connectionAction(b, a, "remove");
    expect(network.messages(a)[0]).toMatchObject({
      status: "revoked",
      response: {},
    });
    expect(
      network.messages(a)[0].activity.find((entry) => entry.kind === "response")
        ?.response?.profile,
    ).toEqual({ status: "not_shared" });
    expect(() => network.requestInformation(a, query())).toThrow();
    connect();
    expect(network.messages(a)[0]).toMatchObject({
      status: "revoked",
      response: {},
    });
  });

  it("keeps blocks directional and does not restore friendship when unblocked", () => {
    connect();
    const token = network.settings(b).qrToken;
    network.connectionAction(b, a, "block");
    expect(network.blocked(a, b)).toBe(true);
    expect(() => network.resolveQr(a, token)).toThrow();
    network.connectionAction(a, b, "unblock");
    expect(network.blocked(a, b)).toBe(true);
    network.connectionAction(b, a, "unblock");
    expect(network.blocked(a, b)).toBe(false);
    expect(network.isConnected(a, b)).toBe(false);
  });

  it("advances relationship revisions across removal, reconnection and blocks even when timestamps collide", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T17:00:00Z"));
    expect(network.relationshipRevision(a, b)).toBe(0);
    connect();
    const accepted = network.relationshipRevision(a, b);
    expect(accepted).toBeGreaterThan(0);
    network.connectionAction(b, a, "accept");
    expect(network.relationshipRevision(a, b)).toBe(accepted);
    network.connectionAction(b, a, "remove");
    const removed = network.relationshipRevision(a, b);
    expect(removed).toBeGreaterThan(accepted);
    connect();
    const reconnected = network.relationshipRevision(a, b);
    expect(reconnected).toBeGreaterThan(removed);
    network.connectionAction(a, b, "block");
    const blocked = network.relationshipRevision(a, b);
    expect(blocked).toBeGreaterThan(reconnected);
    network.connectionAction(a, b, "unblock");
    expect(network.relationshipRevision(a, b)).toBeGreaterThan(blocked);
  });

  it("expires requests and prevents later answers", () => {
    connect();
    settings(b, {
      visibility: {
        profile: "friends",
        goal: "private",
        trip: "private",
        events: "private",
      },
    });
    const message = network.requestInformation(a, query());
    db.prepare("UPDATE agent_messages SET message_json = ? WHERE id = ?").run(
      JSON.stringify({ ...message, expiresAt: "2000-01-01T00:00:00.000Z" }),
      message.id,
    );
    expect(network.messages(a)[0]).toMatchObject({
      status: "expired",
      response: {},
    });
    expect(
      network.messages(a)[0].activity.find((entry) => entry.kind === "response")
        ?.response?.profile,
    ).toEqual({ status: "not_shared" });
    expect(() =>
      network.answerInformation(b, {
        messageId: message.id,
        answers: { profile: "Late answer" },
        decline: false,
      }),
    ).toThrow();
  });

  it("persists connections, requests, replies, QR identity and coalesced jobs across restart", () => {
    connect();
    const qrToken = network.settings(b).qrToken;
    const message = network.requestInformation(a, query());
    network.answerInformation(b, {
      messageId: message.id,
      answers: { profile: "An authorized persisted answer." },
      decline: false,
    });
    network.enqueue(a);
    network.enqueue(a);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM network_jobs WHERE user_id = ?")
          .get(a) as { n: number }
      ).n,
    ).toBe(1);
    db.close();
    store.close();
    store = new ContextStore(path);
    db = new Database(path);
    network = new NetworkStore(db);
    expect(network.isConnected(a, b)).toBe(true);
    expect(network.settings(b).qrToken).toBe(qrToken);
    expect(network.messages(a)[0].response.profile?.value).toBe(
      "An authorized persisted answer.",
    );
    expect(network.messages(b)[0].id).toBe(message.id);
    expect(network.messages(a)[0].activity.map((entry) => entry.kind)).toEqual([
      "request",
      "permission_needed",
      "user_answer",
    ]);
  });
});
