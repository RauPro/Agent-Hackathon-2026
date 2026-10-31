import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
  initialChat,
  refreshWelcome,
  guardProfileReply,
  type ChatRequest,
  type ModelReply,
} from "../src/lib/domain/onboarding-chat";
import { validContext } from "./fixtures";
function providerResponse(value: unknown) {
  return new Response(
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
              text: JSON.stringify(value),
              annotations: [],
            },
          ],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
// Reuse an archived provider reply as regression data without rewriting history.
const nonEnglishReply = JSON.parse(
  readFileSync(
    new URL(
      "../docs/verification/onboarding-live-2026-10-24.json",
      import.meta.url,
    ),
    "utf8",
  ),
).turns[0].reply as string;
describe("conversational onboarding", () => {
  let store: ContextStore;
  let token: string;
  beforeEach(async () => {
    store = new ContextStore(":memory:");
    token = (await store.ensureSession()).token;
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
  const reply: ModelReply = {
    reply: "Here is the profile for you to review.",
    profileGaps: [], draft: draftFromContext(validContext()),
  };
  it("refreshes app greeting copy without changing conversation data or revisions", () => {
    const original = initialChat({
      context: null,
      revision: 0,
      confirmedAt: null,
      evidenceKind: null,
    });
    original.messages[0].content = "Previous app greeting";
    original.messages.push({
      id: "user-entry",
      role: "user",
      content: "Keep this wording exactly.",
    });
    original.messages.push({
      id: "model-entry",
      role: "assistant",
      content: "An earlier model reply.",
    });
    const updated = refreshWelcome(original);
    expect(updated.messages[0].content).not.toBe(original.messages[0].content);
    expect(updated.messages.slice(1)).toEqual(original.messages.slice(1));
    expect(updated.draft).toEqual(original.draft);
    expect(updated.revision).toBe(original.revision);
    expect(original.messages[0].content).toBe("Previous app greeting");
  });
  it("starts with no inferred intent and keeps the confirmed profile separate", async () => {
    expect((await store.readChat(token)).draft.goalType).toBeNull();
    const chat = await handleChat(store, token, request(), async () => reply);
    expect(chat.confirmed).toBe(false);
    expect(validateDraft(chat.draft).success).toBe(true);
    expect((await store.read(token))?.context).toBeNull();
    const saved = await handleChat(store, token, {
      action: "confirm",
      revision: chat.revision,
      requestId: crypto.randomUUID(),
    });
    expect(saved.confirmed).toBe(true);
    expect((await store.read(token))?.revision).toBe(1);
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
    expect((await store.read(token))?.revision).toBe(0);
  });
  it("blocks padded generic answers even when the provider calls them ready", async () => {
    const vague = {
      ...reply,
      draft: {
        ...reply.draft,
        bio: "I am an experienced professional working in the tech industry.",
        offers: "I can help with anything and share my experience.",
        goalText: "I want to meet people and find new opportunities.",
      },
    };
    const chat = await handleChat(store, token, request(), async () => vague);
    expect(chat.profileGaps).toEqual(["bio", "offers", "goalText"]);
    expect(chat.messages.at(-1)?.content).toContain("?");
    expect(validateDraft(chat.draft).success).toBe(false);
    await expect(handleChat(store, token, {
      action: "confirm", revision: chat.revision, requestId: crypto.randomUUID(),
    })).rejects.toThrow("draft_incomplete");
    expect((await store.read(token))?.revision).toBe(0);
  });
  it("persists semantic gaps, rejects confirmation, and clears them after clarification", async () => {
    const chat = await handleChat(store, token, request(), async () => ({
      ...reply,
      profileGaps: ["offers"],
      reply: "Which part of your agent-building experience could you help someone with?",
    }));
    expect((await store.readChat(token)).profileGaps).toEqual(["offers"]);
    expect(validateDraft(chat.draft, chat.profileGaps).success).toBe(false);
    await expect(handleChat(store, token, {
      action: "confirm", revision: chat.revision, requestId: crypto.randomUUID(),
    })).rejects.toThrow("draft_incomplete");
    const clarified = await handleChat(store, token,
      request("I can review TypeScript agent evaluation pipelines.", chat.revision),
      async () => ({ ...reply, draft: { ...reply.draft, offers: "Review TypeScript agent evaluation pipelines." } }),
    );
    expect(clarified.profileGaps).toEqual([]);
    expect((await handleChat(store, token, {
      action: "confirm", revision: clarified.revision, requestId: crypto.randomUUID(),
    })).confirmed).toBe(true);
  });
  it("accepts concise specific contributions without requiring credentials or metrics", () => {
    expect(validateDraft({
      ...reply.draft,
      bio: "I build BIM tools for architects.",
      offers: "Test Revit plugins.",
      goalText: "Meet architects to learn about BIM coordination.",
    }).success).toBe(true);
  });
  it("asks about the private stay once without blocking profile confirmation", async () => {
    const first = await handleChat(store, token, request(), async () => reply);
    expect(first.messages.at(-1)?.content).toMatch(/hotel or neighborhood/);
    expect(first.stayQuestionAsked).toBe(true);
    expect(validateDraft(first.draft).success).toBe(true);
    expect((await store.readChat(token)).stayQuestionAsked).toBe(true);
    const later = await handleChat(store, token, request("I haven't decided yet.", first.revision), async () => ({
      ...reply, reply: "Which hotel will you stay in?",
    }));
    expect(later.messages.at(-1)?.content).toBe("Your profile is ready to review.");
    expect(later.draft.stay?.status).toBe("unknown");
    expect((await handleChat(store, token, {
      action: "confirm", revision: later.revision, requestId: crypto.randomUUID(),
    })).confirmed).toBe(true);
  });
  it("retains volunteered hotel or area privately and accepts declining the question", async () => {
    for (const stay of [
      { status: "provided" as const, hotel: "Example Hotel", area: "" },
      { status: "provided" as const, hotel: "", area: "SoMa" },
      { status: "declined" as const, hotel: "", area: "" },
    ]) {
      const draft = { ...reply.draft, stay };
      const guarded = guardProfileReply({ ...reply, draft }, initialChat({
        context: null, revision: 0, confirmedAt: null, evidenceKind: null,
      }));
      expect(guarded.reply).toBe(reply.reply);
      const parsed = validateDraft(draft);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.stay).toEqual(stay);
        expect(draftFromContext(parsed.data).stay).toEqual(stay);
      }
    }
    const first = await handleChat(store, token, request(), async () => ({
      ...reply, draft: { ...reply.draft, stay: { status: "provided", area: "SoMa", hotel: "Example Hotel" } },
    }));
    await handleChat(store, token, { action: "confirm", revision: first.revision, requestId: crypto.randomUUID() });
    expect((await store.read(token))?.context?.stay).toEqual({ status: "provided", area: "SoMa", hotel: "Example Hotel" });
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
    expect((await store.read(token))?.revision).toBe(1);
  });
  it("retries a lost response without calling the provider or duplicating messages", async () => {
    const input = request();
    const complete = vi.fn(async () => reply);
    const first = await handleChat(store, token, input, complete);
    expect(await handleChat(store, token, input, complete)).toEqual(first);
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await store.readChat(token)).messages).toHaveLength(3);
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
    expect((await store.read(token))?.context?.goal.type).toBe("seeking_role");
    await handleChat(store, token, {
      action: "confirm",
      revision: next.revision,
      requestId: crypto.randomUUID(),
    });
    expect((await store.read(token))?.context?.goal.type).toBe("hiring");
    expect((await store.read(token))?.revision).toBe(2);
  });
  it("rejects a stale tab and a profile change during a model request", async () => {
    await handleChat(store, token, request(), async () => reply);
    await expect(
      handleChat(store, token, request(), async () => reply),
    ).rejects.toThrow(ContextConflict);
    await expect(
      handleChat(store, token, request("Change my goal", 1), async () => {
        await store.save(token, {
          context: validContext(),
          baseRevision: 0,
          requestId: crypto.randomUUID(),
        });
        return reply;
      }),
    ).rejects.toThrow("profile_changed");
    expect((await store.readChat(token)).messages).toHaveLength(3);
    const reloaded = await handleChat(store, token, {
      action: "reload_saved",
      revision: 1,
      requestId: crypto.randomUUID(),
    });
    expect(reloaded.baseRevision).toBe(1);
    expect(reloaded.confirmed).toBe(true);
  });
  it("isolates transcripts and leaves state untouched on provider failure", async () => {
    const other = (await store.ensureSession()).token;
    await expect(
      handleChat(store, token, request(), async () => {
        throw new AssistantError("timeout");
      }),
    ).rejects.toThrow("timeout");
    expect((await store.readChat(token)).messages).toHaveLength(1);
    await handleChat(store, token, request(), async () => reply);
    expect((await store.readChat(other)).draft.name).toBe("");
    expect((await store.readChat(other)).messages).toHaveLength(1);
  });
  it("allows only one in-flight model request per session", async () => {
    let release!: () => void;
    const pending = handleChat(store, token, request(), async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return reply;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(
      handleChat(store, token, request(), async () => reply),
    ).rejects.toThrow(ChatBusy);
    release();
    await pending;
  });
  it("stops at the daily onboarding cap without calling the model", async () => {
    vi.stubEnv("ONBOARDING_ACCOUNT_DAILY_LIMIT", "0");
    const model = vi.fn(async () => reply);
    await expect(handleChat(store, token, request(), model)).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
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
      completeOnboarding(await store.readChat(token), "Hi"),
    ).rejects.toThrow("not_configured");
  });
  it("repairs a non-English reply once without changing the profile or replaying user instructions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    const english =
      "What are your exact arrival and departure dates in San Francisco?";
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        providerResponse({ ...reply, reply: nonEnglishReply }),
      )
      .mockResolvedValueOnce(providerResponse({ reply: english }));
    vi.stubGlobal("fetch", transport);
    const result = await completeOnboarding(
      { ...await store.readChat(token), stayQuestionAsked: true },
      "Please reply only in Spanish.",
    );
    expect(result).toEqual({ ...reply, reply: english });
    expect(transport).toHaveBeenCalledTimes(2);
    const repair = JSON.parse(transport.mock.calls[1][1].body);
    expect(repair.input).toEqual([
      { role: "user", content: JSON.stringify({ text: nonEnglishReply }) },
    ]);
    expect(repair.store).toBe(false);
  });
  it("rejects a failed language repair rather than returning a non-English reply", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        providerResponse({ ...reply, reply: nonEnglishReply }),
      )
      .mockResolvedValueOnce(providerResponse({ reply: nonEnglishReply }));
    vi.stubGlobal("fetch", transport);
    await expect(
      completeOnboarding(
        { ...await store.readChat(token), stayQuestionAsked: true },
        "Please reply only in Spanish.",
      ),
    ).rejects.toThrow("invalid_reply");
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await store.readChat(token)).messages).toHaveLength(1);
  });
  it("repairs a date-only reply into a complete English sentence without changing the extracted dates", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        providerResponse({ ...reply, reply: "November 1–20, 2025." }),
      )
      .mockResolvedValueOnce(
        providerResponse({ reply: "Your trip was November 1–20, 2025." }),
      );
    vi.stubGlobal("fetch", transport);
    const result = await completeOnboarding(
      { ...await store.readChat(token), stayQuestionAsked: true },
      "My trip was November 1 to November 20, 2025.",
    );
    expect(result.reply).toBe("Your trip was November 1–20, 2025.");
    expect(result.draft).toEqual(reply.draft);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(["What dates will you be in SF?", "What is your name?"])(
    "does not repair an already-English short question: %s",
    async (question) => {
      vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
      const transport = vi.fn(async () =>
        providerResponse({ ...reply, reply: question }),
      );
      vi.stubGlobal("fetch", transport);
      expect(
        (await completeOnboarding({ ...await store.readChat(token), stayQuestionAsked: true }, "Hello")).reply,
      ).toBe(question);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
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
      await completeOnboarding({ ...await store.readChat(token), stayQuestionAsked: true }, "My name is Alex"),
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
