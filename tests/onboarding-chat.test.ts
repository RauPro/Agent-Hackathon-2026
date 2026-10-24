import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextStore, ContextConflict } from "../src/lib/server/store";
import { handleChat, ChatBusy } from "../src/lib/server/onboarding-service";
import {
  completeOnboarding,
  AssistantError,
} from "../src/lib/server/onboarding-model";
import {
  draftFromContext,
  validateDraft,
  chatRequestSchema,
  modelReplySchema,
  type ChatRequest,
} from "../src/lib/domain/onboarding-chat";
import { validContext } from "./fixtures";

describe("conversational onboarding", () => {
  let store: ContextStore;
  let token: string;
  beforeEach(() => {
    store = new ContextStore(":memory:");
    token = store.ensureSession().token;
  });
  afterEach(() => {
    store.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const request = (
    message = "I'm in SF looking for a founding engineer role.",
    revision = 0,
  ): ChatRequest => ({
    action: "message",
    message,
    revision,
    requestId: crypto.randomUUID(),
  });
  const reply = {
    reply: "Here is the profile for you to review.",
    draft: draftFromContext(validContext()),
  };

  it("starts with no inferred intent and keeps the confirmed profile separate", async () => {
    expect(store.readChat(token).draft.goalType).toBeNull();
    const chat = await handleChat(store, token, request(), async () => reply);
    expect(chat.confirmed).toBe(false);
    expect(validateDraft(chat.draft).success).toBe(true);
    expect(store.read(token)?.context).toBeNull();
    const saved = await handleChat(store, token, {
      action: "confirm",
      revision: chat.revision,
      requestId: crypto.randomUUID(),
    });
    expect(saved.confirmed).toBe(true);
    expect(store.read(token)?.revision).toBe(1);
  });

  it("does not confirm an incomplete or invalid draft", async () => {
    await expect(
      handleChat(store, token, {
        action: "confirm",
        revision: 0,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("draft_incomplete");
    const draft = draftFromContext(validContext());
    draft.departure = "2026-10-01";
    const chat = await handleChat(store, token, request(), async () => ({
      ...reply,
      draft,
    }));
    expect(validateDraft(chat.draft).success).toBe(false);
    expect(store.read(token)?.revision).toBe(0);
  });

  it("does not ask to reconfirm an unchanged saved profile", async () => {
    const first = await handleChat(store, token, request(), async () => reply);
    const confirmed = await handleChat(store, token, {
      action: "confirm",
      revision: first.revision,
      requestId: crypto.randomUUID(),
    });
    const chat = await handleChat(
      store,
      token,
      request("Can you summarize that?", confirmed.revision),
      async () => reply,
    );
    expect(chat.confirmed).toBe(true);
    expect(store.read(token)?.revision).toBe(1);
  });

  it("retries a lost response without calling the provider or duplicating messages", async () => {
    const input = request();
    const complete = vi.fn(async () => reply);
    const first = await handleChat(store, token, input, complete);
    expect(await handleChat(store, token, input, complete)).toEqual(first);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(store.readChat(token).messages).toHaveLength(3);
    await expect(
      handleChat(
        store,
        token,
        { ...input, action: "message", message: "different message" },
        complete,
      ),
    ).rejects.toThrow(ContextConflict);
  });

  it("keeps corrections as a draft until reconfirmed", async () => {
    const first = await handleChat(store, token, request(), async () => reply);
    const confirmed = await handleChat(store, token, {
      action: "confirm",
      revision: first.revision,
      requestId: crypto.randomUUID(),
    });
    const corrected = {
      ...reply,
      draft: {
        ...reply.draft,
        goalType: "hiring" as const,
        goalText: "I'm hiring a founding engineer for our agent team.",
      },
    };
    const next = await handleChat(
      store,
      token,
      request("Actually I'm hiring.", confirmed.revision),
      async () => corrected,
    );
    expect(next.confirmed).toBe(false);
    expect(store.read(token)?.context?.goal.type).toBe("seeking_role");
    await handleChat(store, token, {
      action: "confirm",
      revision: next.revision,
      requestId: crypto.randomUUID(),
    });
    expect(store.read(token)?.context?.goal.type).toBe("hiring");
    expect(store.read(token)?.revision).toBe(2);
  });

  it("rejects a stale tab and a profile change during a model request", async () => {
    await handleChat(store, token, request(), async () => reply);
    await expect(
      handleChat(store, token, request(), async () => reply),
    ).rejects.toThrow(ContextConflict);
    await expect(
      handleChat(store, token, request("Change my goal", 1), async () => {
        store.save(token, {
          context: validContext(),
          baseRevision: 0,
          requestId: crypto.randomUUID(),
        });
        return reply;
      }),
    ).rejects.toThrow("profile_changed");
    expect(store.readChat(token).messages).toHaveLength(3);
    const reloaded = await handleChat(store, token, {
      action: "reload_saved",
      revision: 1,
      requestId: crypto.randomUUID(),
    });
    expect(reloaded.baseRevision).toBe(1);
    expect(reloaded.confirmed).toBe(true);
  });

  it("isolates transcripts and leaves state untouched on provider failure", async () => {
    const other = store.ensureSession().token;
    await expect(
      handleChat(store, token, request(), async () => {
        throw new AssistantError("timeout");
      }),
    ).rejects.toThrow("timeout");
    expect(store.readChat(token).messages).toHaveLength(1);
    await handleChat(store, token, request(), async () => reply);
    expect(store.readChat(other).draft.name).toBe("");
    expect(store.readChat(other).messages).toHaveLength(1);
  });

  it("allows only one in-flight model request per session", async () => {
    let release!: () => void;
    const pending = handleChat(store, token, request(), async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return reply;
    });
    await expect(
      handleChat(store, token, request(), async () => reply),
    ).rejects.toThrow(ChatBusy);
    release();
    await pending;
  });

  it("does not accept client-supplied profile state or model confirmation", () => {
    expect(
      chatRequestSchema.safeParse({
        ...request(),
        draft: reply.draft,
        sessionId: "other",
      }).success,
    ).toBe(false);
    expect(
      modelReplySchema.safeParse({ ...reply, confirmed: true }).success,
    ).toBe(false);
  });

  it("reports missing configuration without inventing a reply", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(
      completeOnboarding(store.readChat(token), "Hi"),
    ).rejects.toThrow("not_configured");
  });

  it("uses the real SDK structured-output parser and disables provider response storage", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp_test",
            object: "response",
            status: "completed",
            output: [
              {
                id: "msg_test",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(reply),
                    annotations: [],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", transport);
    expect(
      await completeOnboarding(store.readChat(token), "My name is Alex"),
    ).toEqual(reply);
    const body = JSON.parse(
      (transport.mock.calls[0] as unknown as [unknown, RequestInit])[1]
        .body as string,
    );
    expect(body.store).toBe(false);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.tools).toBeUndefined();
  });
});
