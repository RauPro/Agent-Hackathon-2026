import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_MAX_BYTES } from "../src/lib/domain/voice";
import { readVoiceRecording, transcribeVoice } from "../src/lib/server/voice-transcription";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("bounded voice transcription", () => {
  it.each(["audio/webm;codecs=opus", "audio/mp4"])("reads %s without trusting a supplied filename", async (mime) => {
    const file = await readVoiceRecording(new Request("http://localhost", {
      method: "POST", headers: { "Content-Type": mime }, body: "recording fixture",
    }));
    expect(file.name).toBe(mime.includes("webm") ? "recording.webm" : "recording.mp4");
    expect(await file.text()).toBe("recording fixture");
  });
  it("rejects unsupported, empty, and oversized uploads including chunked bodies", async () => {
    const request = (body: string, mime = "audio/webm") => new Request("http://localhost", {
      method: "POST", headers: { "Content-Type": mime }, body,
    });
    await expect(readVoiceRecording(request("audio", "text/plain"))).rejects.toMatchObject({ status: 415 });
    await expect(readVoiceRecording(request(""))).rejects.toMatchObject({ status: 400 });
    await expect(readVoiceRecording(request("x".repeat(VOICE_MAX_BYTES + 1)))).rejects.toMatchObject({ status: 413 });
    const oversized = request("tiny body");
    oversized.headers.set("Content-Length", String(VOICE_MAX_BYTES + 1));
    await expect(readVoiceRecording(oversized)).rejects.toMatchObject({ status: 413 });
  });
  it("uses the installed SDK multipart transcription endpoint and returns editable text", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    const transport = vi.fn(async () => Response.json({ text: "  I build BIM tools for architects.  " }));
    vi.stubGlobal("fetch", transport);
    const text = await transcribeVoice(new File(["fixture"], "recording.webm", { type: "audio/webm" }));
    expect(text).toBe("I build BIM tools for architects.");
    const [url, options] = transport.mock.calls.at(-1) as unknown as [URL, RequestInit];
    expect(String(url)).toContain("/audio/transcriptions");
    const form = await new Response(options.body, { headers: options.headers }).formData();
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect((form.get("file") as File).size).toBe(7);
  });
  it("reports missing configuration, silence, and provider failure without making up text", async () => {
    const file = new File(["fixture"], "recording.webm", { type: "audio/webm" });
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(transcribeVoice(file)).rejects.toMatchObject({ code: "not_configured" });
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: " " })));
    await expect(transcribeVoice(file)).rejects.toMatchObject({ code: "no_speech" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "outage" } }, { status: 503 })));
    await expect(transcribeVoice(file)).rejects.toMatchObject({ code: "transcription_failed" });
  });
});
