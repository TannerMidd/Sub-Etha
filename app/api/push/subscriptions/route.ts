import { pushServer } from "@/lib/push-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
    return pushServer.changeSubscription(request);
}

export async function DELETE(request: Request): Promise<Response> {
    return pushServer.changeSubscription(request);
}

export async function PATCH(request: Request): Promise<Response> {
    return pushServer.changeSubscription(request);
}
