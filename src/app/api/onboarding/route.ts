import { NextRequest } from "next/server";
import { chatRequestSchema } from "@/lib/domain/onboarding-chat";
import { json, readJson, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";
import { ContextConflict, getStore, SessionMissing } from "@/lib/server/store";
import {
  AssistantError,
  assistantConfigured,
} from "@/lib/server/onboarding-model";
import {
  ChatBusy,
  ChatLimit,
  handleChat,
} from "@/lib/server/onboarding-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const store = getStore();
    const session = store.ensureSession(
      request.cookies.get(SESSION_COOKIE)?.value,
    );
    const response = json({
      chat: store.readChat(session.token),
      configured: assistantConfigured(),
    });
    if (session.created)
      response.cookies.set(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: "strict",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    return response;
  } catch {
    return json(
      {
        code: "unavailable",
        message: "Could not open the conversation. Try again.",
      },
      503,
    );
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return json(
      {
        code: "invalid_origin",
        message: "Open the conversation in SF Sidekick.",
      },
      403,
    );
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return json(
      {
        code: "invalid_content_type",
        message: "Invalid message format.",
      },
      415,
    );
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    return json(
      {
        code: "invalid_body",
        message: "The message is too long or could not be read.",
      },
      error instanceof Error && error.message === "payload_too_large"
        ? 413
        : 400,
    );
  }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success)
    return json(
      {
        code: "invalid_message",
        message: "Write a message of up to 3,000 characters.",
      },
      400,
    );
  try {
    return json(
      await handleChat(
        getStore(),
        request.cookies.get(SESSION_COOKIE)?.value,
        parsed.data,
      ),
    );
  } catch (error) {
    if (error instanceof SessionMissing)
      return json(
        {
          code: "session_missing",
          message: "Your session changed. Reconnect to continue.",
        },
        401,
      );
    if (error instanceof ContextConflict)
      return json(
        {
          code: error.code,
          message:
            error.code === "profile_changed"
              ? "Your profile changed in another tab. Load the saved version to continue."
              : "The conversation changed in another tab. Load the latest messages.",
        },
        409,
      );
    if (error instanceof ChatBusy)
      return json(
        {
          code: "busy",
          message:
            "A reply is already in progress. Try again in a few seconds.",
        },
        429,
      );
    if (error instanceof ChatLimit)
      return json(
        {
          code: "chat_limit",
          message:
            "This conversation reached its limit. Confirm your profile if ready, or restart from the saved profile.",
        },
        429,
      );
    if (error instanceof AssistantError)
      return json(
        {
          code: error.code,
          message:
            error.code === "not_configured"
              ? "OpenAI is not connected. Your message is still here."
              : "Could not get a reply. Your message is still here; try again.",
        },
        error.code === "timeout" ? 504 : 503,
      );
    if (error instanceof Error && error.message === "draft_incomplete")
      return json(
        {
          code: "draft_incomplete",
          message:
            "Some details or times need clarification before confirmation.",
        },
        400,
      );
    console.error("onboarding_request_failed");
    return json(
      {
        code: "unavailable",
        message:
          "Could not confirm the result. Try again; your message will not be duplicated.",
      },
      503,
    );
  }
}
