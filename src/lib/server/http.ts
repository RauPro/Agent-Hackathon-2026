import { NextResponse } from "next/server";

export function sameOrigin(request: Request) {
  try {
    const origin = new URL(request.headers.get("origin") || "");
    return (
      origin.host === request.headers.get("host") &&
      origin.protocol === new URL(request.url).protocol
    );
  } catch {
    return false;
  }
}

export const SESSION_COOKIE = "sf_sidekick_session";
export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32768) {
      await reader.cancel();
      throw new Error("payload_too_large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

// Vercel overwrites x-forwarded-for with the connecting client. Loopback means a local
// proxy or dev server, where every visitor would share one address, so it is not limited.
export function clientIp(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim();
  return ip && !/^(127\.|::1$|::ffff:127\.)/.test(ip) ? ip : undefined;
}
