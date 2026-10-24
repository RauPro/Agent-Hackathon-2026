import { NextRequest } from "next/server";
import { fieldErrors, saveContextSchema } from "@/lib/domain/context";
import { ContextConflict, getStore, SessionMissing } from "@/lib/server/store";
import { json, readJson, SESSION_COOKIE } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return json({ code: "invalid_origin", message: "Abre el formulario desde SF Sidekick para guardar." }, 403);
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return json({ code: "invalid_content_type", message: "Formato de solicitud no válido." }, 415);
  }
  let body: unknown;
  try { body = await readJson(request); }
  catch (error) {
    const tooLarge = error instanceof Error && error.message === "payload_too_large";
    return json({ code: tooLarge ? "payload_too_large" : "invalid_json", message: "No pudimos leer estos datos. Revisa el formulario." }, tooLarge ? 413 : 400);
  }
  const parsed = saveContextSchema.safeParse(body);
  if (!parsed.success) return json({ code: "validation_failed", message: "Revisa los campos señalados.", errors: fieldErrors(parsed.error) }, 400);
  try {
    return json(getStore().save(request.cookies.get(SESSION_COOKIE)?.value, parsed.data));
  } catch (error) {
    if (error instanceof SessionMissing) return json({ code: "session_missing", message: "La sesión ha cambiado. Reconecta antes de guardar; conservamos tu formulario." }, 401);
    if (error instanceof ContextConflict) return json({ code: error.code, message: "Tu perfil cambió en otra pestaña. Revisa la versión guardada antes de continuar." }, 409);
    console.error("context_save_failed");
    return json({ code: "storage_unavailable", message: "No se pudo confirmar el guardado. Conservamos tus datos; puedes reintentar." }, 503);
  }
}
