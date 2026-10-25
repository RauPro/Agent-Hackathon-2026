import { NextRequest } from "next/server";
import { meetingActionSchema } from "@/lib/domain/meetings";
import { MeetingService } from "@/lib/server/meeting-service";
import { getStore } from "@/lib/server/store";
import { json } from "@/lib/server/http";
import { CalendarError } from "@/lib/server/google-calendar";
import { calendarFailure } from "@/lib/server/calendar-http";
import {
  networkAccount,
  networkBody,
  networkFailure,
} from "@/lib/server/network-http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const account = await networkAccount(request);
    const input = meetingActionSchema.parse(await networkBody(request));
    const service = new MeetingService(getStore());
    const { action, ...payload } = input;
    let meeting;
    switch (action) {
      case "propose":
        meeting = await service.propose(
          account.id,
          payload as Extract<typeof input, { action: "propose" }>,
        );
        break;
      case "opt_in":
        meeting = await service.optIn(
          account.id,
          payload as Extract<typeof input, { action: "opt_in" }>,
        );
        break;
      case "approve":
        meeting = await service.approve(
          account.id,
          payload as Extract<typeof input, { action: "approve" }>,
        );
        break;
      case "suggest_times":
        meeting = await service.suggestTimes(
          account.id,
          payload as Extract<typeof input, { action: "suggest_times" }>,
        );
        break;
      case "set_location":
        meeting = await service.setLocation(
          account.id,
          payload as Extract<typeof input, { action: "set_location" }>,
        );
        break;
      case "publish":
        meeting = await service.publish(
          account.id,
          payload as Extract<typeof input, { action: "publish" }>,
        );
        break;
      case "withdraw":
        meeting = await service.withdraw(
          account.id,
          payload as Extract<typeof input, { action: "withdraw" }>,
        );
        break;
    }
    return json({ ok: true, meeting });
  } catch (error) {
    if (error instanceof CalendarError) return calendarFailure(error);
    return networkFailure(error);
  }
}
