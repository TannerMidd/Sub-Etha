import { relayToPushGateway } from "@/lib/vercel-push-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return relayToPushGateway(request, "/api/push/vapid-key");
}
