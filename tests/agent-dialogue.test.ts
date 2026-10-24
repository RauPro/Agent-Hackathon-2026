import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore } from "../src/lib/server/store";
import { AgentDialogueService } from "../src/lib/server/agent-dialogue-service";
import type { DialogueAction, DialogueCompleter, DialogueReply } from "../src/lib/domain/agent-dialogue";
import type { NetworkSettingsInput } from "../src/lib/domain/network";
import { validContext } from "./fixtures";

let folder: string, path: string, store: ContextStore, service: AgentDialogueService;
let a: string, b: string, outsider: string;
let complete: ReturnType<typeof vi.fn<DialogueCompleter>>;
const tokens: Record<string, string> = {};
const reply = (message = "Our users could compare their experience building agent products."): DialogueReply => ({
  message, next: "continue", questionForUser: null, suggestedNextStep: null,
});
async function account(name: string, confirmed = true) {
  const registration = await store.registerAccount(`${name}@example.test`, "test-only-hash");
  const id = registration.account.id;
  tokens[id] = registration.token;
  if (confirmed) await saveProfile(id, name);
  return id;
}
async function saveProfile(id: string, name = "Alex", bio?: string) {
  const context = validContext();
  context.profile.name = `${name} Example`;
  if (bio) context.profile.bio = bio;
  context.commitments = { status: "provided", items: [{ date: "2026-10-25", start: "13:00", end: "14:00", title: "Secret appointment" }] };
  await store.save(tokens[id], { context, baseRevision: (await store.network.profile(id)).revision, requestId: randomUUID() });
}
async function share(id: string, visibility: Partial<NetworkSettingsInput["visibility"]> = { profile: "friends", goal: "friends" }) {
  const current = await store.network.settings(id);
  return store.network.saveSettings(id, {
    discoverable: false, area: "Private hotel", revision: current.revision,
    visibility: { profile: "private", goal: "private", trip: "private", events: "private", ...visibility },
  });
}
async function connect(first = a, second = b, accept = true) {
  await store.network.requestConnection(first, second, { source: "qr", token: (await store.network.settings(second)).qrToken, context: "Met in person." });
  if (accept) await store.network.connectionAction(second, first, "accept");
}
async function ready() { await connect(); await share(a); await share(b); await service.syncPair(a, b); }
async function view(owner = a) { return (await service.list(owner)).find((item) => item.userId === (owner === a ? b : a))!; }
async function act(owner: string, operation: DialogueAction["operation"], answer?: string) {
  const current = await view(owner);
  return service.act(owner, { action: "dialogue", toUserId: owner === a ? b : a, revision: current.revision, operation, ...(answer ? { answer } : {}) });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "sidekick-dialogue-"));
  path = join(folder, "test.sqlite");
  store = new ContextStore(path);
  complete = vi.fn<DialogueCompleter>().mockResolvedValue(reply());
  service = new AgentDialogueService(store.network, complete);
  a = await account("Alex"); b = await account("Blair"); outsider = await account("Casey");
});
afterEach(() => { vi.useRealTimers(); store.close(); rmSync(folder, { recursive: true, force: true }); });

describe("connection-only iterative agent dialogue", () => {
  it("never creates a dialogue or invokes a model before acceptance, regardless of discovery", async () => {
    await share(a, { profile: "network" }); await share(b, { profile: "network" });
    const current = await store.network.settings(b);
    await store.network.saveSettings(b, { discoverable: true, visibility: current.visibility, area: current.area, revision: current.revision });
    await service.syncPair(a, b);
    expect(await service.list(a)).toEqual([]);
    await connect(a, b, false);
    await service.syncPair(a, b);
    expect(await service.drain()).toBe(0);
    expect(await service.list(a)).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    await expect(service.act(a, { action: "dialogue", toUserId: b, revision: 0, operation: "pause" })).rejects.toMatchObject({ status: 403 });
  });

  it("backfills existing friendships and exposes confirmation and sharing blockers without calling a model", async () => {
    const unconfirmed = await account("Draft", false);
    await connect(a, unconfirmed);
    await service.syncForUser(a);
    const missing = (await service.list(a)).find((item) => item.userId === unconfirmed)!;
    expect(missing.status).toBe("awaiting_profile");
    expect(missing.ownProfileReady).toBe(true);
    await saveProfile(unconfirmed, "Draft");
    await service.syncPair(a, unconfirmed);
    expect((await service.list(unconfirmed))[0]).toMatchObject({ status: "awaiting_sharing", ownSharingReady: false });
    await share(a, { goal: "friends" });
    await share(unconfirmed, { profile: "friends" });
    await service.syncForUser(a);
    expect((await service.list(unconfirmed))[0].status).toBe("queued");
    expect(complete).not.toHaveBeenCalled();
  });

  it("starts for same-goal users without overlapping dates or discovery and sends only reciprocal shared projections", async () => {
    await ready();
    const context = validContext();
    context.trip.start = "2027-03-01"; context.trip.end = "2027-03-10";
    await store.save(tokens[b], { context, baseRevision: (await store.network.profile(b)).revision, requestId: randomUUID() });
    expect(await service.drain(1)).toBe(1);
    const input = complete.mock.calls[0][0];
    expect(input.self.goal?.type).toBe("seeking_role");
    expect(input.peer.goal?.type).toBe("seeking_role");
    expect(input.self.trip).toBeUndefined();
    expect(input.peer.trip).toBeUndefined();
    expect(JSON.stringify(input)).not.toMatch(/Secret appointment|Private hotel|email|calendar|commitments|password|qrToken/);
    expect((await view()).turns).toHaveLength(1);
  });

  it("alternates exactly six turns, persists through a new service, and does not restart on polling", async () => {
    await ready();
    expect(await service.drain(6)).toBe(6);
    const initial = await view();
    expect(initial.status).toBe("completed");
    expect(initial.turns).toHaveLength(6);
    expect(initial.turns.map((turn) => turn.actorUserId)).toEqual(Array.from({ length: 6 }, (_, i) => [...[a, b].sort()][i % 2]));
    expect(complete.mock.calls.map(([input]) => input.turnNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    const reopened = new ContextStore(path);
    try {
      const recovered = new AgentDialogueService(reopened.network, complete);
      expect((await recovered.list(a))[0]).toEqual(initial);
      await recovered.syncPair(a, b); await recovered.syncForUser(a);
      expect(await recovered.drain(2)).toBe(0);
      expect(complete).toHaveBeenCalledTimes(6);
    } finally { reopened.close(); }
  });

  it("fences concurrent workers on separate database clients and commits only one ordered turn", async () => {
    await ready();
    const started = deferred<void>(), response = deferred<DialogueReply>();
    complete.mockImplementationOnce(async () => { started.resolve(); return response.promise; });
    const first = service.drain(1); await started.promise;
    const secondStore = new ContextStore(path);
    try {
      const second = new AgentDialogueService(secondStore.network, complete);
      expect(await second.drain(1)).toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);
      response.resolve(reply()); await first;
      expect((await second.list(a))[0].turns).toHaveLength(1);
      expect(await second.drain(1)).toBe(1);
      expect((await view()).turns).toHaveLength(2);
    } finally { secondStore.close(); }
  });

  it("keeps errors visible and retryable without inventing replies", async () => {
    await ready(); complete.mockRejectedValueOnce(new Error("Provider unavailable"));
    await service.drain(1);
    expect(await view()).toMatchObject({ status: "error", turns: [] });
    expect(await service.drain(1)).toBe(0);
    await act(a, "retry"); await service.drain(1);
    expect((await view()).turns).toHaveLength(1);
    expect(complete.mock.calls[0][0]).toEqual(complete.mock.calls[1][0]);
  });

  it("rejects inconsistent model decisions and lets both agents iterate twice before completion", async () => {
    await ready();
    complete.mockResolvedValueOnce({ ...reply(), next: "ask_user", questionForUser: null });
    await service.drain(1);
    expect(await view()).toMatchObject({ status: "error", turns: [] });
    complete.mockResolvedValue({ ...reply(), next: "complete" });
    await act(a, "retry"); await service.drain(1);
    expect(await view()).toMatchObject({ status: "queued" });
    await service.drain(2);
    expect(await view()).toMatchObject({ status: "queued" });
    await service.drain(1);
    expect(await view()).toMatchObject({ status: "completed" });
    expect((await view()).turns).toHaveLength(4);
  });

  it("pauses immediately, preserves the pause through profile changes, and permits only the pausing user to resume", async () => {
    await ready(); await service.drain(1);
    await act(a, "pause");
    await expect(act(b, "resume")).rejects.toMatchObject({ status: 403 });
    await saveProfile(b, "Blair", "Production engineer working on a newly confirmed project.");
    expect(await view()).toMatchObject({ status: "paused", turns: [], pausedByUserId: a });
    expect(await service.drain(2)).toBe(0);
    await act(a, "resume");
    expect(await service.drain(1)).toBe(1);
    expect((await view()).turns).toHaveLength(1);
  });

  it("asks only the represented user, explicitly shares their answer, and resumes with the other agent", async () => {
    await ready();
    complete.mockResolvedValueOnce({ ...reply(), next: "ask_user", questionForUser: "Would you like to compare engineering projects?" });
    await service.drain(1);
    const current = await view();
    const owner = current.waitingForUserId!, peer = owner === a ? b : a;
    expect(current.status).toBe("needs_user");
    expect(await service.drain(1)).toBe(0);
    await expect(act(peer, "answer", "An unauthorized answer")).rejects.toMatchObject({ status: 403 });
    await expect(service.act(outsider, { action: "dialogue", toUserId: owner, revision: current.revision, operation: "answer", answer: "An outsider answer" })).rejects.toMatchObject({ status: 403 });
    await act(owner, "answer", "I can discuss my open source agent project.");
    await service.drain(1);
    expect((await view()).turns.map((turn) => turn.kind)).toEqual(["agent", "user", "agent"]);
    expect(complete.mock.calls[1][0].self.id).toBe(peer);
    expect(complete.mock.calls[1][0].history.at(-1)).toEqual({ speaker: "peer", text: "The other user: I can discuss my open source agent project." });
  });

  it("supports declining a question and rejects stale actions", async () => {
    await ready(); const before = await view();
    complete.mockResolvedValueOnce({ ...reply(), next: "ask_user", questionForUser: "Would you like to share another project?" });
    await service.drain(1);
    await expect(service.act(a, { action: "dialogue", toUserId: b, revision: before.revision, operation: "pause" })).rejects.toMatchObject({ status: 409 });
    const current = await view(); await act(current.waitingForUserId!, "decline");
    expect(await view()).toMatchObject({ status: "completed", question: null, waitingForUserId: null });
    expect(await service.drain(1)).toBe(0);
  });

  it.each(["sharing", "block", "remove", "pause"] as const)("discards in-flight output after %s changes", async (change) => {
    await ready();
    const started = deferred<void>(), response = deferred<DialogueReply>();
    complete.mockImplementationOnce(async () => { started.resolve(); return response.promise; });
    const running = service.drain(1); await started.promise;
    if (change === "sharing") await share(a, {});
    else if (change === "pause") await act(a, "pause");
    else await store.network.connectionAction(a, b, change);
    response.resolve(reply("Text produced from a revoked snapshot.")); await running;
    const current = await view();
    expect(current.turns).toEqual([]);
    expect(current.status).toBe(change === "sharing" ? "awaiting_sharing" : change === "pause" ? "paused" : "revoked");
    expect(JSON.stringify(current)).not.toContain("Text produced");
  });

  it("redacts previous generated text and one-off answers on permission changes, then starts a fresh round", async () => {
    await ready();
    complete.mockResolvedValueOnce({ ...reply("Old shared profile reference."), next: "ask_user", questionForUser: "What else may we share?" });
    await service.drain(1);
    await act((await view()).waitingForUserId!, "answer", "A one-off private answer now explicitly shared.");
    await service.drain(1);
    await share(a, { goal: "friends" });
    const redacted = await view();
    expect(redacted.turns).toEqual([]);
    expect(redacted.question).toBeNull();
    expect(redacted.suggestion).toBeNull();
    await service.drain(1);
    expect(complete.mock.calls.at(-1)![0].history).toEqual([]);
    expect(complete.mock.calls.at(-1)![0].turnNumber).toBe(1);
    expect(JSON.stringify(complete.mock.calls.at(-1))).not.toContain("one-off");
  });

  it("invalidates completed rounds when shared event content changes even without a profile revision", async () => {
    await ready(); await share(a, { profile: "friends", events: "friends" });
    let title = "Public engineering meetup";
    store.network.sharedEvents = async (owner) => owner === a ? [{ id: "event", title, start: "2026-11-02T17:00:00Z", end: "2026-11-02T18:00:00Z", sourceMode: "user_report" }] : [];
    complete.mockResolvedValue({ ...reply(), next: "complete" });
    await service.drain(4);
    expect((await view()).status).toBe("completed");
    title = "Updated engineering meetup";
    expect(await view()).toMatchObject({ status: "queued", turns: [] });
  });

  it("preserves the current round when only private context changes", async () => {
    await ready(); await service.drain(2);
    const before = await view();
    const profile = await store.network.profile(a);
    profile.context!.commitments = { status: "none", items: [] };
    await store.save(tokens[a], { context: profile.context!, baseRevision: profile.revision, requestId: randomUUID() });
    await service.syncPair(a, b);
    expect(await view()).toEqual(before);
  });

  it("drops an expired worker result after a new lease owner commits", async () => {
    await ready(); const started = deferred<void>(), response = deferred<DialogueReply>();
    complete.mockImplementationOnce(async () => { started.resolve(); return response.promise; });
    const first = service.drain(1); await started.promise;
    await store.network.db.prepare("UPDATE database_leases SET expires_at = 0 WHERE key LIKE 'agent-dialogue:%'").run();
    const second = new AgentDialogueService(store.network, complete);
    await second.drain(1);
    response.resolve(reply("Stale result must not appear.")); await first;
    expect((await view()).turns).toHaveLength(1);
    expect(JSON.stringify(await view())).not.toContain("Stale result");
  });

  it("bounds repeated restarts by a durable daily pair budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
    await ready();
    for (let round = 0; round < 4; round += 1) {
      await saveProfile(a, "Alex", `Production engineer working on confirmed project ${round}.`);
      await service.syncPair(a, b); await service.drain(6);
    }
    expect(complete).toHaveBeenCalledTimes(24);
    await saveProfile(a, "Alex", "Production engineer working on one more confirmed project.");
    await service.syncPair(a, b);
    expect(await service.drain(1)).toBe(0);
    expect((await view()).status).toBe("error");
    await expect(act(a, "retry")).rejects.toMatchObject({ status: 429 });
    // UTC midnight is still the previous SF afternoon. Reset at SF midnight.
    vi.setSystemTime(new Date("2026-10-25T06:59:59Z"));
    await expect(act(a, "retry")).rejects.toMatchObject({ status: 429 });
    vi.setSystemTime(new Date("2026-10-25T07:00:00Z"));
    await act(a, "retry"); await service.drain(1);
    expect(complete).toHaveBeenCalledTimes(25);
  });
});
