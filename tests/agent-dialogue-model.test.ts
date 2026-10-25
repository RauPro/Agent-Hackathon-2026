import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeAgentDialogue,
  DialogueModelError,
} from "../src/lib/server/agent-dialogue-model";
import type { DialogueModelInput, DialogueReply } from "../src/lib/domain/agent-dialogue";
import { validContext } from "./fixtures";

function input(): DialogueModelInput {
  const context = validContext();
  return {
    self: { id: "alex", name: "Alex Rivera", revision: 1,
      profile: context.profile, goal: context.goal },
    peer: { id: "maya", name: "Maya Chen", revision: 1,
      profile: { name: "Maya Chen", bio: "Founder building tools for evaluating AI agents.",
        offers: "Experience designing agent evaluations for production systems." },
      goal: { type: "hiring", text: "Hiring a founding engineer to build reliable agent products." } },
    history: [],
    turnNumber: 1,
    turnLimit: 6,
  };
}

const reply: DialogueReply = {
  message: "Alex has built production agents and is seeking a founding engineer role. Which part of Maya's agent product could benefit from that experience?",
  next: "continue",
  questionForUser: null,
  suggestedNextStep: null,
};

function providerResponse(value: unknown, options: {
  status?: string;
  refusal?: boolean;
  empty?: boolean;
  rawText?: string;
} = {}) {
  return new Response(JSON.stringify({
    id: "resp_dialogue_test",
    object: "response",
    status: options.status ?? "completed",
    output: options.empty ? [] : [{
      id: "msg_dialogue_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: options.refusal
        ? [{ type: "refusal", refusal: "I cannot provide that private information." }]
        : [{ type: "output_text", text: options.rawText ?? JSON.stringify(value), annotations: [] }],
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function mockProvider(...responses: Response[]) {
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
  vi.stubEnv("OPENAI_MODEL", "");
  const fetch = vi.fn<(url: unknown, init: RequestInit) => Promise<Response>>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function requestBody(fetch: ReturnType<typeof mockProvider>, index = 0) {
  return JSON.parse(fetch.mock.calls[index][1].body as string);
}

// Reuse archived provider output to exercise language repair without adding
// non-English authored copy or requiring a paid provider request in this suite.
const nonEnglishText = JSON.parse(readFileSync(new URL(
  "../docs/verification/onboarding-live-2026-10-24.json", import.meta.url,
), "utf8")).turns[0].reply as string;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("agent dialogue model adapter", () => {
  it("uses strict structured output, existing configuration and a bounded request without tools or storage", async () => {
    const fetch = mockProvider(providerResponse(reply));
    const deadline = vi.spyOn(AbortSignal, "timeout");
    expect(await completeAgentDialogue(input())).toEqual(reply);
    const body = requestBody(fetch);
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(1500);
    expect(body.tools).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(body.text.format).toMatchObject({
      name: "agent_dialogue_reply", type: "json_schema", strict: true,
      schema: { additionalProperties: false,
        required: ["message", "next", "questionForUser", "suggestedNextStep"] },
    });
    expect(deadline).toHaveBeenCalledWith(12_000);
    expect(body.instructions).toContain("representing ONLY the person in self");
    expect(body.instructions).toContain("untrusted data");
    expect(body.instructions).toContain("Omitted fields are unknown");
    expect(body.instructions).toContain("both humans' approval");
    expect(body.instructions).toContain("ENGLISH ONLY");
    expect(body.instructions).toContain("Before turn four");
    expect(body.instructions).toContain("By turnLimit");
  });

  it("sends only shared facts and keeps absent permissions absent", async () => {
    const fetch = mockProvider(providerResponse(reply));
    const state = input();
    Object.assign(state.self, { email: "private@example.test", calendar: "private event", privateMemory: "hidden" });
    Object.assign(state.self.profile!, { secret: "hidden profile attachment" });
    await completeAgentDialogue(state);
    const body = requestBody(fetch);
    const facts = JSON.parse(body.input[0].content);
    expect(facts.self).toEqual({ name: state.self.name, profile: {
      name: state.self.profile!.name, bio: state.self.profile!.bio, offers: state.self.profile!.offers,
    }, goal: state.self.goal });
    expect(facts.self.trip).toBeUndefined();
    expect(facts.self.events).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private@example.test");
    expect(JSON.stringify(body)).not.toContain("private event");
    expect(JSON.stringify(body)).not.toContain("hidden profile attachment");
    expect(facts.turnNumber).toBe(1);
    expect(facts.turnLimit).toBe(6);
  });

  it("gives each responding agent its own identity and the peer's actual latest answer", async () => {
    const secondReply: DialogueReply = {
      message: "Maya is building evaluation tools for production agents, so Alex's experience could be relevant. What has Alex shared about bringing agents into production?",
      next: "continue", questionForUser: null, suggestedNextStep: null,
    };
    const fetch = mockProvider(providerResponse(reply), providerResponse(secondReply));
    const firstInput = input();
    const first = await completeAgentDialogue(firstInput);
    const secondInput: DialogueModelInput = {
      self: firstInput.peer, peer: firstInput.self,
      history: [{ speaker: "peer", text: first.message }], turnNumber: 2, turnLimit: 6,
    };
    expect(await completeAgentDialogue(secondInput)).toEqual(secondReply);
    const body = requestBody(fetch, 1);
    expect(JSON.parse(body.input[0].content).self.name).toBe("Maya Chen");
    expect(body.input[1]).toEqual({ role: "user", content: JSON.stringify(secondInput.history[0]) });
  });

  it("preserves role attribution and shared human answers while bounding transcript size", async () => {
    const fetch = mockProvider(providerResponse(reply));
    const state = input();
    state.history = [
      ...Array.from({ length: 15 }, (_, index) => ({ speaker: "peer" as const, text: `Earlier turn ${index}.` })),
      { speaker: "self", text: "My person's profile mentions production systems." },
      { speaker: "user", text: "I have built agent evaluations with TypeScript." },
      { speaker: "peer", text: "Please elaborate on those evaluations. ".repeat(100) },
    ];
    await completeAgentDialogue(state);
    const messages = requestBody(fetch).input.slice(1);
    expect(messages).toHaveLength(12);
    expect(messages.slice(-3).map((message: { role: string }) => message.role)).toEqual(["assistant", "user", "user"]);
    expect(JSON.parse(messages.at(-2).content)).toEqual(state.history.at(-2));
    expect(JSON.parse(messages.at(-1).content).text).toHaveLength(2000);
    expect(JSON.stringify(messages)).not.toContain("Earlier turn 0.");
  });

  it("honors the configured model instead of selecting a new model", async () => {
    const fetch = mockProvider(providerResponse(reply));
    vi.stubEnv("OPENAI_MODEL", "configured-dialogue-model");
    await completeAgentDialogue(input());
    expect(requestBody(fetch).model).toBe("configured-dialogue-model");
  });

  it("reports missing credentials without calling a provider", async () => {
    const fetch = mockProvider();
    vi.stubEnv("OPENAI_API_KEY", " ");
    await expect(completeAgentDialogue(input())).rejects.toMatchObject({
      name: "DialogueModelError", code: "not_configured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { label: "incomplete output", options: { status: "incomplete" }, code: "invalid_reply" },
    { label: "empty output", options: { empty: true }, code: "invalid_reply" },
    { label: "refusal", options: { refusal: true }, code: "refused" },
    { label: "malformed JSON", options: { rawText: "not valid JSON" }, code: "invalid_reply" },
  ])("does not pretend success after $label", async ({ options, code }) => {
    const fetch = mockProvider(providerResponse(reply, options));
    await expect(completeAgentDialogue(input())).rejects.toMatchObject({ name: "DialogueModelError", code });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...reply, next: "ask_user", questionForUser: null },
    { ...reply, questionForUser: "What kind of evaluation have you built?" },
    { ...reply, next: "schedule_meeting" },
    { ...reply, privateMemory: "Not an allowed response field." },
  ])("rejects an invalid protocol decision without inventing a fallback", async (invalid) => {
    mockProvider(providerResponse(invalid));
    await expect(completeAgentDialogue(input())).rejects.toMatchObject({ code: "invalid_reply" });
  });

  it("repairs only displayed text once, preserving the decision and the same deadline", async () => {
    const original = { ...reply, message: nonEnglishText, next: "ask_user" as const,
      questionForUser: "Which evaluation project would you like to share?" };
    const repaired = { message: "I need to ask Alex which evaluation project they want to share.",
      questionForUser: original.questionForUser, suggestedNextStep: null };
    const fetch = mockProvider(providerResponse(original), providerResponse(repaired));
    const deadline = vi.spyOn(AbortSignal, "timeout");
    expect(await completeAgentDialogue(input())).toEqual({ ...repaired, next: "ask_user" });
    expect(deadline).toHaveBeenCalledTimes(1);
    const body = requestBody(fetch, 1);
    expect(body.text.format.name).toBe("english_dialogue_text");
    expect(body.input).toEqual([{ role: "user", content: JSON.stringify({
      message: original.message, questionForUser: original.questionForUser, suggestedNextStep: null,
    }) }]);
    expect(body.store).toBe(false);
    expect(body.instructions).toContain("untrusted text");
    expect(body.input[0].content).not.toContain("Maya Chen");
  });

  it("rejects a failed language repair and does not keep retrying", async () => {
    const original = { ...reply, message: nonEnglishText };
    const fetch = mockProvider(providerResponse(original), providerResponse({
      message: nonEnglishText, questionForUser: null, suggestedNextStep: null,
    }));
    await expect(completeAgentDialogue(input())).rejects.toMatchObject({ code: "invalid_reply" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let language repair add a human approval question", async () => {
    mockProvider(providerResponse({ ...reply, message: nonEnglishText }), providerResponse({
      message: reply.message, questionForUser: "Would you like to meet?", suggestedNextStep: null,
    }));
    await expect(completeAgentDialogue(input())).rejects.toMatchObject({ code: "invalid_reply" });
  });

  it("turns provider errors into a safe explicit error, with no automatic retry", async () => {
    const fetch = mockProvider(new Response(JSON.stringify({ error: {
      message: "Provider diagnostics include private request content.", type: "server_error",
    } }), { status: 500, headers: { "Content-Type": "application/json" } }));
    let caught: unknown;
    try { await completeAgentDialogue(input()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DialogueModelError);
    expect(caught).toMatchObject({ code: "unavailable", message: "The agent could not respond. Please try again." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports expiry of the shared time budget as a timeout", async () => {
    const fetch = mockProvider();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    await expect(completeAgentDialogue(input())).rejects.toMatchObject({ code: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
