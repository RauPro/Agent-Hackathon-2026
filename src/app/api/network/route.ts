import { after, NextRequest } from "next/server";
import { z } from "zod";
import {
  networkSettingsSchema,
  connectionRequestSchema,
  informationRequestSchema,
  informationAnswerSchema,
} from "@/lib/domain/network";
import { networkEventSchema } from "@/lib/domain/discovery";
import { DiscoveryService } from "@/lib/server/discovery-service";
import { MeetingService } from "@/lib/server/meeting-service";
import { getStore } from "@/lib/server/store";
import { json } from "@/lib/server/http";
import {
  networkAccount,
  networkBody,
  networkFailure,
} from "@/lib/server/network-http";
import { drainNetworkWork } from "@/lib/server/network-worker";
import { networkDemoEnabled } from "@/lib/server/demo-mode";
import { dialogueActionSchema } from "@/lib/domain/agent-dialogue";
import { AgentDialogueService } from "@/lib/server/agent-dialogue-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const actionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("settings"), settings: networkSettingsSchema })
    .strict(),
  z.object({ action: z.literal("rotate_qr") }).strict(),
  connectionRequestSchema.extend({
    action: z.literal("connect"),
    toUserId: z.uuid(),
  }),
  z
    .object({
      action: z.literal("connection"),
      toUserId: z.uuid(),
      decision: z.enum(["accept", "decline", "remove", "block", "unblock"]),
    })
    .strict(),
  informationRequestSchema.extend({ action: z.literal("query") }),
  informationAnswerSchema.safeExtend({ action: z.literal("answer") }),
  z.object({ action: z.literal("dismiss"), opportunityId: z.uuid() }).strict(),
  z.object({ action: z.literal("event"), event: networkEventSchema }).strict(),
  z.object({ action: z.literal("remove_event"), eventId: z.uuid() }).strict(),
  dialogueActionSchema,
]);
export async function GET(request: NextRequest) {
  try {
    const account = await networkAccount(request),
      store = getStore();
    const qr = request.nextUrl.searchParams.get("qr");
    if (qr)
      return json({ person: await store.network.resolveQr(account.id, qr) });
    const discovery = new DiscoveryService(store.network);
    const dialogue = new AgentDialogueService(store.network);
    after(async () => {
      try {
        await drainNetworkWork();
      } catch {
        console.error("network_jobs_pending_retry");
      }
    });
    return json({
      accountId: account.id,
      settings: await store.network.settings(account.id),
      connections: await store.network.connections(account.id),
      messages: await store.network.messages(account.id),
      // Reconciles existing accepted connections without invoking the model.
      dialogues: await dialogue.list(account.id),
      opportunities: await discovery.opportunities(account.id),
      events: await discovery.events(account.id),
      meetings: await new MeetingService(store).list(account.id),
      demo: networkDemoEnabled(),
    });
  } catch (error) {
    return networkFailure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    const account = await networkAccount(request);
    const input = actionSchema.parse(await networkBody(request));
    const store = getStore(),
      network = store.network,
      discovery = new DiscoveryService(network);
    switch (input.action) {
      case "settings":
        await network.saveSettings(account.id, input.settings);
        break;
      case "rotate_qr":
        await network.rotateQr(account.id);
        break;
      case "connect": {
        const { action: _, toUserId, ...payload } = input;
        void _;
        await network.requestConnection(account.id, toUserId, payload);
        break;
      }
      case "connection":
        await network.connectionAction(
          account.id,
          input.toUserId,
          input.decision,
        );
        break;
      case "query": {
        const { action: _, ...payload } = input;
        void _;
        await network.requestInformation(account.id, payload);
        break;
      }
      case "answer": {
        const { action: _, ...payload } = input;
        void _;
        await network.answerInformation(account.id, payload);
        break;
      }
      case "dismiss":
        await discovery.dismiss(account.id, input.opportunityId);
        break;
      case "event":
        await discovery.saveEvent(account.id, input.event);
        break;
      case "remove_event":
        await discovery.removeEvent(account.id, input.eventId);
        break;
      case "dialogue":
        await new AgentDialogueService(network).act(account.id, input);
        break;
    }
    after(async () => {
      try {
        await drainNetworkWork();
      } catch {
        console.error("network_jobs_pending_retry");
      }
    });
    return json({ ok: true });
  } catch (error) {
    return networkFailure(error);
  }
}
