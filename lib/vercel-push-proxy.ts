const DEFAULT_PUSH_GATEWAY_ORIGIN = "https://sub-etha-matrix.middletontanne137269.chatgpt.site";
const MAX_BODY_BYTES = 64 * 1024;

function gatewayOrigin(): URL {
  const configured = process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN || DEFAULT_PUSH_GATEWAY_ORIGIN;
  const gateway = new URL(configured);
  if (gateway.protocol !== "https:") throw new Error("The Sub-Etha push gateway must use HTTPS.");
  return gateway;
}

export async function relayToPushGateway(request: Request, path: string): Promise<Response> {
  try {
    const gateway = gatewayOrigin();
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return Response.json({ error: "Request body is too large." }, { status: 413 });
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    if (body && body.byteLength > MAX_BODY_BYTES) return Response.json({ error: "Request body is too large." }, { status: 413 });

    const headers = new Headers({
      Accept: "application/json",
      Origin: gateway.origin,
    });
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);

    const upstream = await fetch(new URL(path, gateway), {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "The Sub-Etha push gateway is unavailable." }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
