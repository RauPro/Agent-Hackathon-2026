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
    const message = network.requestInformation(a, query());
    db.prepare("UPDATE agent_messages SET message_json = ? WHERE id = ?").run(
      JSON.stringify({ ...message, expiresAt: "2000-01-01T00:00:00.000Z" }),
      message.id,
    );
    expect(network.messages(a)[0]).toMatchObject({
      status: "expired",
      response: {},
    });
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
  });
});
