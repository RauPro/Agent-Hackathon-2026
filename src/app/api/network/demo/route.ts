import { json } from "@/lib/server/http";
import { networkDemoEnabled } from "@/lib/server/demo-mode";
export const dynamic = "force-dynamic";
export function GET() {
  return json({ enabled: networkDemoEnabled() });
}
