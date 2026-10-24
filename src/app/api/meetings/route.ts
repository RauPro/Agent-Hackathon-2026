import { NextRequest } from "next/server";
import { meetingActionSchema } from "@/lib/domain/meetings";
import { MeetingService } from "@/lib/server/meeting-service";
import { getStore } from "@/lib/server/store";
import { json } from "@/lib/server/http";
import {
  networkAccount,
  networkBody,
  networkFailure,
} from "@/lib/server/network-http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const account = networkAccount(request);
    const input = meetingActionSchema.parse(await networkBody(request));
    const service = new MeetingService(getStore());
    const { action, ...payload } = input;
    let meeting;
    switch (action) {
      case "propose":
        meeting = service.propose(
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
      case "withdraw":
        meeting = service.withdraw(
          account.id,
          payload as Extract<typeof input, { action: "withdraw" }>,
        );
        break;
    }
    return json({ ok: true, meeting });
  } catch (error) {
    return networkFailure(error);
  }
}
