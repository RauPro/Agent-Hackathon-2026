export const VOICE_MAX_BYTES = 3 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 60;
export const VOICE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export function audioExtension(type: string) {
  const mime = type.split(";")[0].trim().toLowerCase();
  return mime === "audio/webm" ? "webm" : mime === "audio/mp4" ? "mp4" : null;
}
