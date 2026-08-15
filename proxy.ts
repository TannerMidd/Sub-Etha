import { NextResponse, type NextRequest } from "next/server";

import {
    createDocumentSecurityContext,
    isLocalDevelopmentPreview,
    isLocalDevelopmentRequest,
} from "./lib/security/csp";

export function proxy(request: NextRequest): NextResponse {
    if (isLocalDevelopmentPreview(request, process.env.NODE_ENV)) {
        return NextResponse.next();
    }

    const security = createDocumentSecurityContext(
        request,
        undefined,
        !isLocalDevelopmentRequest(request, process.env.NODE_ENV),
    );

    if (!security) {
        return NextResponse.next();
    }

    return NextResponse.next({
        headers: security.responseHeaders,
        request: { headers: security.forwardedRequestHeaders },
    });
}

export const config = {
    matcher: "/:path*",
};
