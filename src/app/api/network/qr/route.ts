import { NextRequest } from "next/server";
import QRCode from "qrcode";
import { getStore } from "@/lib/server/store";
import { networkAccount, networkFailure } from "@/lib/server/network-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const account = await networkAccount(request);
    const { qrToken } = await getStore().network.settings(account.id);
    const origin = `${new URL(request.url).protocol}//${request.headers.get("host")}`;
    const url = new URL(`/connect/${qrToken}`, origin).toString();
    const svg = await QRCode.toString(url, {
      type: "svg",
      margin: 4,
      errorCorrectionLevel: "M",
      width: 280,
    });
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "private, no-store",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (error) {
    return networkFailure(error);
  }
}
