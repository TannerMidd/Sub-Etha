import { relayToPushGateway } from "@/lib/vercel-push-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return relayToPushGateway(request, "/api/push/subscriptions");
}

export async function DELETE(request: Request): Promise<Response> {
  return relayToPushGateway(request, "/api/push/subscriptions");
}
