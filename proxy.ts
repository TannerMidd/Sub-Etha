import { NextResponse, type NextRequest } from "next/server";

function nonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function contentSecurityPolicy(value: string, development: boolean): string {
    const directives = [
        "default-src 'self'",
        [
            "script-src 'self'",
            "'nonce-" + value + "'",
            "'strict-dynamic'",
            "'wasm-unsafe-eval'",
            development ? "'unsafe-eval'" : "",
        ]
            .filter(Boolean)
            .join(" "),
        development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'nonce-" + value + "'",
        "style-src-attr 'unsafe-inline'",
        development ? "connect-src 'self' https: wss: http: ws:" : "connect-src 'self' https: wss:",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        development ? "" : "upgrade-insecure-requests",
    ];

    return directives.filter(Boolean).join("; ");
}

export function proxy(request: NextRequest) {
    const value = nonce();
    const development = process.env.NODE_ENV !== "production";
    const policy = contentSecurityPolicy(value, development);
    const header =
        process.env.CSP_REPORT_ONLY === "1"
            ? "Content-Security-Policy-Report-Only"
            : "Content-Security-Policy";
    const requestHeaders = new Headers(request.headers);

    requestHeaders.set(header, policy);
    requestHeaders.set("x-nonce", value);

    const response = NextResponse.next({
        request: {
            headers: requestHeaders,
        },
    });

    response.headers.set(header, policy);

    return response;
}

export const config = {
    matcher: [
        "/((?!api|_next/static|_next/image|favicon.ico|icon-192.png|icon-512.png|manifest.webmanifest|sw.js).*)",
    ],
};
