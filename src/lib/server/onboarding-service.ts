import type {
  ChatRequest,
  ChatState,
  ModelReply,
} from "@/lib/domain/onboarding-chat";
import { ContextStore } from "./store";
import { completeOnboarding } from "./onboarding-model";

export class ChatBusy extends Error {}
export class ChatLimit extends Error {}
const active = new Set<string>();
type Completion = (chat: ChatState, message: string) => Promise<ModelReply>;

export async function handleChat(
  store: ContextStore,
  token: string | undefined,
  request: ChatRequest,
  complete: Completion = completeOnboarding,
) {
  const cached = store.cachedChat(token, request);
  if (cached) return cached;
  const current = store.checkChat(token, request);
  if (request.action !== "message") return store.commitChat(token, request);
  if (current.messages.length >= 81) throw new ChatLimit();
  const owner = store.calendarOwner(token);
  if (active.has(owner)) throw new ChatBusy();
  active.add(owner);
  try {
    const reply = await complete(current, request.message);
    // Re-check both revisions after the external request, before any mutation.
    return store.commitChat(token, request, reply);
  } finally {
    active.delete(owner);
  }
}
