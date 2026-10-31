import OpenAI from "openai";
import { audioExtension, VOICE_MAX_BYTES } from "@/lib/domain/voice";
import { openAIKey } from "./ai-config";

export class VoiceError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
  }
}

export async function readVoiceRecording(request: Request): Promise<File> {
  const mime = request.headers.get("content-type") || "";
  const extension = audioExtension(mime);
  if (!extension)
    throw new VoiceError("invalid_audio", 415, "Record audio in a browser that supports WebM or MP4, or type your message.");
  const tooLarge = () => new VoiceError("audio_too_large", 413, "This recording is too large. Try a shorter recording.");
  if (Number(request.headers.get("content-length")) > VOICE_MAX_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new VoiceError("empty_audio", 400, "No audio was recorded. Try again.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VOICE_MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new VoiceError("empty_audio", 400, "No audio was recorded. Try again.");
  return new File([Buffer.concat(chunks)], `recording.${extension}`, { type: mime });
}

export async function transcribeVoice(file: File, signal?: AbortSignal): Promise<string> {
  const apiKey = openAIKey();
  if (!apiKey)
    throw new VoiceError("not_configured", 503, "Voice transcription is not connected. You can still type your message.");
  const client = new OpenAI({ apiKey, timeout: 25000, maxRetries: 0 });
  try {
    const result = await client.audio.transcriptions.create({
      file,
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-transcribe",
      response_format: "json",
    }, { signal });
    if (typeof result.text !== "string" || !result.text.trim())
      throw new VoiceError("no_speech", 422, "No speech was detected. Try recording again or type your message.");
    if (result.text.length > 12000)
      throw new VoiceError("transcript_too_long", 422, "Try a shorter recording so you can review the transcript.");
    return result.text.trim();
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    throw new VoiceError("transcription_failed", 503, "Could not transcribe the recording. Retry, record again, or type your message.");
  }
}
