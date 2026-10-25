import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextStore } from "../src/lib/server/store";
import { AgentDialogueService } from "../src/lib/server/agent-dialogue-service";
import type { DialogueCompleter } from "../src/lib/domain/agent-dialogue";
import { validContext } from "./fixtures";

let store: ContextStore;
beforeEach(() => { store = new ContextStore(":memory:"); });
afterEach(() => { store.close(); });

async function account(name: string) {
  const account = await store.registerAccount(`${name}@example.test`, "test-only-hash");
  const context = validContext();
  context.profile.name = name;
  context.stay = { status: "provided", area: "Private neighborhood", hotel: "Private Hotel" };
  await store.save(account.token, { context, baseRevision: 0, requestId: crypto.randomUUID() });
  const settings = await store.network.settings(account.account.id);
  await store.network.saveSettings(account.account.id, {
    revision: settings.revision, discoverable: true, area: "San Francisco",
    visibility: { profile: "network", goal: "network", trip: "network", events: "network" },
  });
  return account;
}

describe("private onboarding stay", () => {
  it("never projects hotel or private stay area, even when the trip is network-visible", async () => {
    const a = await account("Alex");
    const b = await account("Blair");
    expect((await store.read(b.token))?.context?.stay?.hotel).toBe("Private Hotel");
    for (const viewer of [a.account.id, b.account.id]) {
      const shared = await store.network.project(viewer, b.account.id);
      expect(shared.trip).toBeDefined();
      expect(shared.area).toBe("San Francisco");
      expect(JSON.stringify(shared)).not.toMatch(/Private Hotel|Private neighborhood|"stay"|"hotel"/);
    }
  });

  it("keeps stay out of typed profile answers and both agent model contexts after connection", async () => {
    const a = await account("Alex");
    const b = await account("Blair");
    const aid = a.account.id, bid = b.account.id;
    await store.network.requestConnection(aid, bid, {
      source: "qr", token: (await store.network.settings(bid)).qrToken, context: "Met at a demo event.",
    });
    await store.network.connectionAction(bid, aid, "accept");
    const message = await store.network.requestInformation(aid, {
      toUserId: bid, requestId: crypto.randomUUID(), fields: ["profile", "goal", "trip"],
      purpose: "Explore a conversation about agent engineering.",
    });
    expect(JSON.stringify(message)).not.toMatch(/Private Hotel|Private neighborhood|"stay"|"hotel"/);
    const complete = vi.fn<DialogueCompleter>().mockResolvedValue({
      message: "Our users could compare their experience building agents. Which topic is useful?",
      next: "continue", questionForUser: null, suggestedNextStep: null,
    });
    const dialogue = new AgentDialogueService(store.network, complete);
    await dialogue.syncPair(aid, bid);
    expect(await dialogue.drain(1)).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
    const input = complete.mock.calls[0][0];
    expect(input.self.trip).toBeDefined();
    expect(input.peer.trip).toBeDefined();
    expect(JSON.stringify(input)).not.toMatch(/Private Hotel|Private neighborhood|"stay"|"hotel"/);
  });
});
