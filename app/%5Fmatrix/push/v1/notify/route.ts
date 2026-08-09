import { pushServer } from "@/lib/push-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return pushServer.notify(request);
}
