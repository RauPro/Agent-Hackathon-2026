import type {
  ChatRequest,
  ChatState,
  ModelReply,
} from "@/lib/domain/onboarding-chat";
import { ContextStore } from "./store";
import { completeOnboarding } from "./onboarding-model";

export class ChatBusy extends Error {}
export class ChatLimit extends Error {}
type Completion = (chat: ChatState, message: string) => Promise<ModelReply>;

export async function handleChat(
  store: ContextStore,
  token: string | undefined,
  request: ChatRequest,
  complete: Completion = completeOnboarding,
) {
  const cached = await store.cachedChat(token, request);
  if (cached) return cached;
  const current = await store.checkChat(token, request);
  if (request.action !== "message") return store.commitChat(token, request);
  if (current.messages.length >= 81) throw new ChatLimit();
  const owner = await store.calendarOwner(token);
  const key = `onboarding:${owner}`;
  const lease = await store.network.db.acquireLease(key, 35_000);
  if (!lease) throw new ChatBusy();
  try {
    const reply = await complete(current, request.message);
    // Re-check both revisions after the external request, before any mutation.
    return await store.commitChat(token, request, reply);
  } finally {
    await store.network.db.releaseLease(key, lease);
  }
}
