import { NextRequest } from "next/server";
import { z } from "zod";
import { MeetingService } from "@/lib/server/meeting-service";
import { getStore } from "@/lib/server/store";
import { json } from "@/lib/server/http";
import { networkAccount, networkBody, networkFailure } from "@/lib/server/network-http";
import { interpretMeetingTime } from "@/lib/server/meeting-time-model";
import { AssistantError } from "@/lib/server/onboarding-model";

export const runtime = "nodejs";
const inputSchema = z.object({ meetingId: z.uuid(), revision: z.number().int().positive(), message: z.string().trim().min(1).max(3000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(3000) }).strict()).max(8).optional() }).strict();

export async function GET(request: NextRequest) {
  try {
    const account = await networkAccount(request);
    const store = getStore();
    const profile = await store.network.profile(account.id);
    return json({ accountId: account.id, meetings: await new MeetingService(store).list(account.id), suggestedArea: profile.context?.stay?.area || null });
  } catch (error) { return networkFailure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const account = await networkAccount(request);
    const input = inputSchema.parse(await networkBody(request));
    const store = getStore();
    const meeting = (await new MeetingService(store).list(account.id)).find((item) => item.id === input.meetingId);
    if (!meeting) return json({ message: "This meeting is not available to your account." }, 404);
    if (meeting.revision !== input.revision || !["awaiting_permission", "options_ready", "needs_user_input"].includes(meeting.status))
      return json({ message: "This meeting changed. Reload its latest question." }, 409);
    const profile = await store.network.profile(account.id);
    if (!profile.context) return json({ message: "Confirm your profile first." }, 409);
    const key = `meeting-time:${account.id}`;
    const lease = await store.db.acquireLease(key, 25000);
    if (!lease) return json({ message: "Your time suggestion is already being read. Try again shortly." }, 429);
    try {
      const interpretation = await interpretMeetingTime(input.message, meeting, profile.context.trip, input.history);
      // Re-read permission and revision after model latency; interpretation grants no authority.
      const current = (await new MeetingService(store).list(account.id)).find((item) => item.id === meeting.id);
      if (!current || current.revision !== meeting.revision)
        return json({ message: "This meeting changed. Reload its latest question." }, 409);
      return json({ ...interpretation, meetingId: meeting.id, revision: meeting.revision });
    } finally { await store.db.releaseLease(key, lease); }
  } catch (error) {
    if (error instanceof AssistantError) return json({ message: "I couldn't read that time yet. Your message is still here; try again." }, 503);
    return networkFailure(error);
  }
}
