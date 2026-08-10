import { pushServer } from "@/lib/push-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
    return pushServer.getVapidKey();
}
