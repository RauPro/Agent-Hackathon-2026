import { NextRequest } from "next/server";
import { getStore, isStoreError } from "@/lib/server/store";
import { json, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";
import { voiceLimits } from "@/lib/server/usage-limits";
import { readVoiceRecording, transcribeVoice, VoiceError } from "@/lib/server/voice-transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return json({ code: "invalid_origin", message: "Open voice input in SF Sidekick." }, 403);
  try {
    const store = getStore();
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    await store.requireAccount(token, request.headers.get("x-sidekick-account"));
    const file = await readVoiceRecording(request);
    const key = `voice:${await store.calendarOwner(token)}`;
    const lease = await store.network.db.acquireLease(key, 35000);
    if (!lease) return json({ code: "busy", message: "A recording is already being transcribed. Try again shortly." }, 429);
    try {
      await store.reserveUsage(voiceLimits(key.slice("voice:".length)));
      const text = await transcribeVoice(file, AbortSignal.any([request.signal, AbortSignal.timeout(25000)]));
      // Transcription never creates a chat turn or confirms a profile.
      await store.requireAccount(token, request.headers.get("x-sidekick-account"));
      return json({ text });
    } finally {
      await store.network.db.releaseLease(key, lease);
    }
  } catch (error) {
    if (isStoreError(error, "session_missing"))
      return json({ code: "session_missing", message: "Sign in again to use voice input." }, 401);
    if (isStoreError(error, "usage_limit"))
      return json({ code: "daily_limit", message: "Voice input reached today's limit. You can still type your message." }, 429);
    if (error instanceof VoiceError)
      return json({ code: error.code, message: error.message }, error.status);
    return json({ code: "unavailable", message: "Voice input is unavailable. Try again or type your message." }, 503);
  }
}
