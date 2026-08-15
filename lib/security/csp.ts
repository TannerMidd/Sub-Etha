export const CONTENT_SECURITY_POLICY = "Content-Security-Policy";
export const CONTENT_SECURITY_POLICY_REPORT_ONLY = "Content-Security-Policy-Report-Only";

export const PERMISSIONS_POLICY = [
    "accelerometer=()",
    "autoplay=()",
    "camera=()",
    "display-capture=()",
    "encrypted-media=()",
    "geolocation=()",
    "gyroscope=()",
    "magnetometer=()",
    "microphone=()",
    "payment=()",
    "screen-wake-lock=()",
    "usb=()",
    "clipboard-write=(self)",
    "publickey-credentials-create=(self)",
    "publickey-credentials-get=(self)",
].join(", ");

export const DOCUMENT_SECURITY_HEADERS = {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "0",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
} as const;

const DOCUMENT_METHOD = "GET";
const EXCLUDED_PATH_PREFIXES = ["/_next", "/api", "/_matrix", "/fonts", "/images", "/static"];
const EXCLUDED_DOCUMENT_HEADERS = [
    "next-router-prefetch",
    "next-router-segment-prefetch",
    "next-router-state-tree",
    "rsc",
    "x-middleware-prefetch",
    "x-nextjs-data",
];
const STATIC_FILE_EXTENSION =
    /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|json|map|mjs|mp3|mp4|ogg|otf|png|svg|ttf|txt|wasm|wav|webm|webmanifest|woff2?|xml)$/i;

export interface DocumentRequestLike {
    headers: Headers;
    method: string;
    url: string;
}

export interface DocumentSecurityContext {
    forwardedRequestHeaders: Headers;
    nonce: string;
    policy: string;
    responseHeaders: Headers;
}

export type NonceFactory = () => string;
export type RandomValuesFiller = (bytes: Uint8Array) => void;

function isLoopbackHostname(hostname: string): boolean {
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

export function isLocalDevelopmentRequest(
    request: Pick<DocumentRequestLike, "url">,
    environment: string | undefined,
): boolean {
    return environment === "development" && isLoopbackHostname(new URL(request.url).hostname);
}

export function isLocalDevelopmentPreview(
    request: Pick<DocumentRequestLike, "url">,
    environment: string | undefined,
): boolean {
    if (!isLocalDevelopmentRequest(request, environment)) {
        return false;
    }

    const url = new URL(request.url);

    return url.searchParams.has("design-preview");
}

function hasPathPrefix(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function pathnameCandidates(url: string): string[] {
    const pathname = new URL(url).pathname.toLowerCase();

    try {
        const decoded = decodeURIComponent(pathname);

        return decoded === pathname ? [pathname] : [pathname, decoded];
    } catch {
        return [pathname];
    }
}

function isExcludedPath(pathname: string): boolean {
    if (EXCLUDED_PATH_PREFIXES.some((prefix) => hasPathPrefix(pathname, prefix))) {
        return true;
    }

    if (STATIC_FILE_EXTENSION.test(pathname)) {
        return true;
    }

    const leaf = pathname.slice(pathname.lastIndexOf("/") + 1);

    return (
        /^(?:apple-)?(?:touch-)?icon(?:[-.].*)?$/.test(leaf) ||
        /^favicon(?:[-.].*)?$/.test(leaf) ||
        /^(?:site\.)?manifest(?:\.(?:json|webmanifest))?$/.test(leaf) ||
        /^(?:service-worker|sw)(?:\.(?:js|mjs))?$/.test(leaf)
    );
}

function requestsPrefetch(headers: Headers): boolean {
    if (EXCLUDED_DOCUMENT_HEADERS.some((name) => headers.has(name))) {
        return true;
    }

    return [headers.get("purpose"), headers.get("sec-purpose")].some(
        (value) => value !== null && /(?:^|[\s;,])prefetch(?:$|[\s;,])/i.test(value),
    );
}

function acceptsReactServerComponents(headers: Headers): boolean {
    const accept = headers.get("accept");

    if (!accept) {
        return false;
    }

    return accept.split(",").some((range) => {
        const [mediaType, ...parameters] = range.split(";").map((part) => part.trim());

        if (mediaType.toLowerCase() !== "text/x-component") {
            return false;
        }

        const qualityParameter = parameters.find((parameter) =>
            parameter.toLowerCase().startsWith("q="),
        );

        if (!qualityParameter) {
            return true;
        }

        const quality = Number(qualityParameter.slice(2));

        return Number.isFinite(quality) && quality > 0;
    });
}

export function isDocumentRequest(request: DocumentRequestLike): boolean {
    if (request.method.toUpperCase() !== DOCUMENT_METHOD) {
        return false;
    }

    if (acceptsReactServerComponents(request.headers) || requestsPrefetch(request.headers)) {
        return false;
    }

    const fetchDestination = request.headers.get("sec-fetch-dest")?.toLowerCase();

    if (fetchDestination && fetchDestination !== "document" && fetchDestination !== "iframe") {
        return false;
    }

    return pathnameCandidates(request.url).every((pathname) => !isExcludedPath(pathname));
}

export function generateCspNonce(
    fillRandomValues: RandomValuesFiller = (bytes) => {
        crypto.getRandomValues(bytes);
    },
): string {
    const bytes = new Uint8Array(16);

    fillRandomValues(bytes);

    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

export function buildContentSecurityPolicy(nonce: string): string {
    return [
        "default-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "frame-src 'none'",
        "form-action 'none'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
        "script-src-attr 'none'",
        `style-src 'self' 'nonce-${nonce}'`,
        `style-src-elem 'self' 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        "connect-src 'self' https:",
        "img-src 'self' blob: data: https://i.ytimg.com",
        "media-src 'self' blob:",
        "font-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "require-trusted-types-for 'script'",
        "trusted-types subetha-matrix-html subetha-service-worker",
    ].join("; ");
}

export function createDocumentSecurityContext(
    request: DocumentRequestLike,
    createNonce: NonceFactory = generateCspNonce,
    enforcePolicy = true,
): DocumentSecurityContext | null {
    if (!isDocumentRequest(request)) {
        return null;
    }

    const nonce = createNonce();
    const policy = buildContentSecurityPolicy(nonce);
    const forwardedRequestHeaders = new Headers(request.headers);
    const responseHeaders = new Headers(DOCUMENT_SECURITY_HEADERS);

    // Forward the policy with the nonce so the document renderer can attach it
    // to every framework-owned script and style. Development's loopback Vite
    // runtime remains report-only because its HMR internals are not nonce/TT
    // compatible; every other document navigation enforces the same policy.
    forwardedRequestHeaders.delete(CONTENT_SECURITY_POLICY);
    forwardedRequestHeaders.delete(CONTENT_SECURITY_POLICY_REPORT_ONLY);

    if (enforcePolicy) {
        forwardedRequestHeaders.set(CONTENT_SECURITY_POLICY, policy);
        responseHeaders.set(CONTENT_SECURITY_POLICY, policy);
    } else {
        forwardedRequestHeaders.set(CONTENT_SECURITY_POLICY_REPORT_ONLY, policy);
        responseHeaders.set(CONTENT_SECURITY_POLICY_REPORT_ONLY, policy);
    }

    return { forwardedRequestHeaders, nonce, policy, responseHeaders };
}
