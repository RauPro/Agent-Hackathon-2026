import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { transcribeVoice } from "../src/lib/server/voice-transcription";

// Opt-in smoke test using locally synthesized fictional speech, never a user's microphone.
it.skipIf(process.env.LIVE_VOICE_EVAL !== "1")("transcribes a synthetic recording through the configured provider", async () => {
  process.loadEnvFile(".env.local");
  const path = process.env.VOICE_EVAL_AUDIO;
  if (!path) throw new Error("Set VOICE_EVAL_AUDIO to a synthetic MP4/M4A recording saying 'I build coordination tools for architects'.");
  const text = await transcribeVoice(new File([readFileSync(path)], "synthetic-speech.m4a", { type: "audio/mp4" }));
  expect(text).toMatch(/architects/i);
  expect(text).toMatch(/coordination/i);
}, 30000);
