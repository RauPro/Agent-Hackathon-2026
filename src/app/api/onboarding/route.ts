import { NextRequest } from "next/server";
import { chatRequestSchema } from "@/lib/domain/onboarding-chat";
import { json, readJson, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";
import { ContextConflict, getStore, SessionMissing } from "@/lib/server/store";
import { AssistantError, assistantConfigured } from "@/lib/server/onboarding-model";
import { ChatBusy, ChatLimit, handleChat } from "@/lib/server/onboarding-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const store = getStore();
    const session = store.ensureSession(request.cookies.get(SESSION_COOKIE)?.value);
    const response = json({ chat: store.readChat(session.token), configured: assistantConfigured() });
    if (session.created) response.cookies.set(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return response;
  } catch { return json({ code: "unavailable", message: "No pudimos abrir tu conversación. Inténtalo de nuevo." }, 503); }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ code: "invalid_origin", message: "Abre la conversación desde SF Sidekick." }, 403);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return json({ code: "invalid_content_type", message: "Formato de mensaje no válido." }, 415);
  let body: unknown;
  try { body = await readJson(request); }
  catch (error) { return json({ code: "invalid_body", message: "El mensaje es demasiado largo o no se pudo leer." }, error instanceof Error && error.message === "payload_too_large" ? 413 : 400); }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) return json({ code: "invalid_message", message: "Escribe un mensaje de hasta 3.000 caracteres." }, 400);
  try { return json(await handleChat(getStore(), request.cookies.get(SESSION_COOKIE)?.value, parsed.data)); }
  catch (error) {
    if (error instanceof SessionMissing) return json({ code: "session_missing", message: "La sesión ha cambiado. Reconecta para continuar." }, 401);
    if (error instanceof ContextConflict) return json({ code: error.code, message: error.code === "profile_changed" ? "Tu perfil se actualizó en otra pestaña. Recupera esa versión antes de continuar." : "La conversación cambió en otra pestaña. Recupera los últimos mensajes." }, 409);
    if (error instanceof ChatBusy) return json({ code: "busy", message: "Ya estoy respondiendo a un mensaje. Reintenta en unos segundos." }, 429);
    if (error instanceof ChatLimit) return json({ code: "chat_limit", message: "Esta conversación ha llegado a su límite. Confirma el perfil si está listo o empieza de nuevo desde el perfil guardado." }, 429);
    if (error instanceof AssistantError) return json({ code: error.code, message: error.code === "not_configured" ? "OpenAI aún no está conectado. Tu mensaje sigue aquí." : "No pude responder ahora. Tu mensaje sigue aquí; puedes reintentarlo." }, error.code === "timeout" ? 504 : 503);
    if (error instanceof Error && error.message === "draft_incomplete") return json({ code: "draft_incomplete", message: "Faltan datos o hay horarios por aclarar antes de confirmar." }, 400);
    console.error("onboarding_request_failed");
    return json({ code: "unavailable", message: "No pudimos confirmar el resultado. Puedes reintentar sin duplicar el mensaje." }, 503);
  }
}
