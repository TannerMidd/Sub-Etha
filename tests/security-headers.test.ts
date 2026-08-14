import assert from "node:assert/strict";
import test from "node:test";

import {
    buildContentSecurityPolicy,
    CONTENT_SECURITY_POLICY,
    CONTENT_SECURITY_POLICY_REPORT_ONLY,
    createDocumentSecurityContext,
    DOCUMENT_SECURITY_HEADERS,
    generateCspNonce,
    isDocumentRequest,
    isLocalDevelopmentPreview,
    isLocalDevelopmentRequest,
    PERMISSIONS_POLICY,
} from "../lib/security/csp";

const FIXED_NONCE = "AbCdEfGhIjKlMnOpQrStUv";

function request(
    pathname: string,
    headers: HeadersInit = { accept: "text/html" },
    method = "GET",
): Request {
    return new Request(`https://sub-etha.example${pathname}`, { headers, method });
}

test("document classification includes navigations and OAuth callback documents", () => {
    assert.equal(isDocumentRequest(request("/")), true);
    assert.equal(isDocumentRequest(request("/without-accept", {})), true);
    assert.equal(isDocumentRequest(request("/wildcard-accept", { accept: "*/*" })), true);
    assert.equal(isDocumentRequest(request("/json-accept", { accept: "application/json" })), true);
    assert.equal(
        isDocumentRequest(
            request("/oauth/callback?code=secret&state=opaque", {
                accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
            }),
        ),
        true,
    );
    assert.equal(
        isDocumentRequest(
            request("/embedded", {
                accept: "TEXT/HTML; charset=utf-8",
                "sec-fetch-dest": "iframe",
            }),
        ),
        true,
    );
});

test("only the loopback development design preview bypasses document security", () => {
    const localPreview = new Request("http://localhost:4173/?design-preview");

    assert.equal(isLocalDevelopmentPreview(localPreview, "development"), true);
    assert.equal(isLocalDevelopmentPreview(localPreview, "production"), false);
    assert.equal(isLocalDevelopmentPreview(localPreview, undefined), false);
    assert.equal(
        isLocalDevelopmentPreview(
            new Request("https://sub-etha.example/?design-preview"),
            "development",
        ),
        false,
    );
    assert.equal(isLocalDevelopmentPreview(request("/"), "development"), false);
});

test("only loopback development documents receive a report-only policy", () => {
    const loopbackDocument = new Request("http://localhost:4173/");
    const remoteDevelopmentDocument = new Request("https://sub-etha.example/");
    const production = createDocumentSecurityContext(request("/"), () => FIXED_NONCE, true);
    const loopbackDevelopment = createDocumentSecurityContext(
        loopbackDocument,
        () => FIXED_NONCE,
        !isLocalDevelopmentRequest(loopbackDocument, "development"),
    );
    const remoteDevelopment = createDocumentSecurityContext(
        remoteDevelopmentDocument,
        () => FIXED_NONCE,
        !isLocalDevelopmentRequest(remoteDevelopmentDocument, "development"),
    );
    const excluded = createDocumentSecurityContext(
        new Request("http://localhost:4173/sw.js"),
        () => FIXED_NONCE,
        false,
    );

    assert.equal(isLocalDevelopmentRequest(loopbackDocument, "development"), true);
    assert.equal(isLocalDevelopmentRequest(loopbackDocument, "production"), false);
    assert.equal(isLocalDevelopmentRequest(remoteDevelopmentDocument, "development"), false);
    assert.ok(production);
    assert.ok(loopbackDevelopment);
    assert.ok(remoteDevelopment);
    assert.equal(production.responseHeaders.get(CONTENT_SECURITY_POLICY), production.policy);
    assert.equal(loopbackDevelopment.responseHeaders.get(CONTENT_SECURITY_POLICY), null);
    assert.equal(
        loopbackDevelopment.responseHeaders.get(CONTENT_SECURITY_POLICY_REPORT_ONLY),
        loopbackDevelopment.policy,
    );
    assert.equal(
        remoteDevelopment.responseHeaders.get(CONTENT_SECURITY_POLICY),
        remoteDevelopment.policy,
    );
    assert.equal(excluded, null);
});

test("document classification bypasses methods, APIs, assets, RSC, and prefetches", () => {
    const excluded = [
        request("/", { accept: "text/html" }, "HEAD"),
        request("/", { accept: "text/html" }, "POST"),
        request("/api/push/test"),
        request("/%61pi/push/test"),
        request("/_matrix/push/v1/notify"),
        request("/_next/static/chunk.js"),
        request("/_next/image?url=%2Fog.png"),
        request("/static/runtime"),
        request("/images/avatar"),
        request("/fonts/commissioner-variable.ttf"),
        request("/favicon.ico"),
        request("/apple-touch-icon.png"),
        request("/manifest.webmanifest"),
        request("/manifest"),
        request("/sw.js"),
        request("/service-worker"),
        request("/", { accept: "text/x-component" }),
        request("/", { accept: "text/x-component", rsc: "1" }),
        request("/", { accept: "text/html", rsc: "1" }),
        request("/", { accept: "text/html", "next-router-prefetch": "1" }),
        request("/", { accept: "text/html", "next-router-segment-prefetch": "/children" }),
        request("/", { accept: "text/html", "next-router-state-tree": "tree" }),
        request("/", { accept: "text/html", purpose: "prefetch" }),
        request("/", { accept: "text/html", "sec-purpose": "prefetch;prerender" }),
        request("/", { accept: "text/html", "sec-fetch-dest": "empty" }),
    ];

    for (const excludedRequest of excluded) {
        assert.equal(
            isDocumentRequest(excludedRequest),
            false,
            `${excludedRequest.method} ${excludedRequest.url}`,
        );
        assert.equal(createDocumentSecurityContext(excludedRequest), null);
    }
});

test("the enforced policy contains each settled directive exactly once", () => {
    const policy = buildContentSecurityPolicy(FIXED_NONCE);
    const directives = policy.split("; ");

    assert.deepEqual(directives, [
        "default-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "frame-src 'none'",
        "form-action 'none'",
        `script-src 'self' 'nonce-${FIXED_NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'`,
        "script-src-attr 'none'",
        `style-src 'self' 'nonce-${FIXED_NONCE}'`,
        `style-src-elem 'self' 'nonce-${FIXED_NONCE}'`,
        "style-src-attr 'unsafe-inline'",
        "connect-src 'self' https:",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "require-trusted-types-for 'script'",
        "trusted-types subetha-matrix-html subetha-service-worker",
    ]);
    assert.equal(new Set(directives.map((directive) => directive.split(" ", 1)[0])).size, 19);
    assert.equal(policy.includes("report-uri"), false);
    assert.equal(policy.includes("report-to"), false);
    assert.equal(policy.includes("upgrade-insecure-requests"), false);
    assert.equal(
        directives
            .find((directive) => directive.startsWith("script-src "))
            ?.includes("'unsafe-eval'"),
        false,
    );
    assert.equal(
        directives
            .find((directive) => directive.startsWith("script-src "))
            ?.includes("'unsafe-inline'"),
        false,
    );
});

test("nonce generation fills exactly 16 random bytes and emits fresh base64url values", () => {
    let invocation = 0;
    const lengths: number[] = [];

    const fill = (bytes: Uint8Array) => {
        lengths.push(bytes.byteLength);
        bytes.forEach((_value, index) => {
            bytes[index] = (invocation + index) & 0xff;
        });
        invocation += 1;
    };

    const first = generateCspNonce(fill);
    const second = generateCspNonce(fill);

    assert.equal(first, "AAECAwQFBgcICQoLDA0ODw");
    assert.match(first, /^[A-Za-z0-9_-]{22}$/);
    assert.match(second, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(first, second);
    assert.deepEqual(lengths, [16, 16]);
});

test("each document context requests a fresh nonce and excluded requests request none", () => {
    const nonces = ["FirstDocumentNonce", "SecondDocumentNonce"];
    let nonceIndex = 0;
    const createNonce = () => nonces[nonceIndex++];
    const first = createDocumentSecurityContext(request("/first"), createNonce);
    const second = createDocumentSecurityContext(request("/second"), createNonce);
    const excluded = createDocumentSecurityContext(request("/api/data"), createNonce);

    assert.ok(first);
    assert.ok(second);
    assert.equal(excluded, null);
    assert.equal(nonceIndex, 2);
    assert.equal(first.nonce, nonces[0]);
    assert.equal(second.nonce, nonces[1]);
    assert.notEqual(first.policy, second.policy);
});

test("forwarded and response policies enforce the same nonce policy without mutating the request", () => {
    const original = request("/oauth/callback", {
        accept: "text/html",
        [CONTENT_SECURITY_POLICY]: "default-src https:",
        [CONTENT_SECURITY_POLICY_REPORT_ONLY]: "default-src https:",
        "x-request-id": "request-1",
    });
    const security = createDocumentSecurityContext(original, () => FIXED_NONCE);

    assert.ok(security);
    assert.equal(original.headers.get(CONTENT_SECURITY_POLICY), "default-src https:");
    assert.equal(original.headers.get(CONTENT_SECURITY_POLICY_REPORT_ONLY), "default-src https:");
    assert.notEqual(security.forwardedRequestHeaders, original.headers);
    assert.equal(security.forwardedRequestHeaders.get(CONTENT_SECURITY_POLICY), security.policy);
    assert.equal(
        security.forwardedRequestHeaders.get(CONTENT_SECURITY_POLICY_REPORT_ONLY),
        security.policy,
    );
    assert.equal(security.responseHeaders.get(CONTENT_SECURITY_POLICY), security.policy);
    assert.equal(
        security.responseHeaders.get(CONTENT_SECURITY_POLICY_REPORT_ONLY),
        security.policy,
    );
    assert.equal(security.forwardedRequestHeaders.get("x-request-id"), "request-1");
    assert.equal(security.forwardedRequestHeaders.get("referrer-policy"), null);

    for (const headers of [security.forwardedRequestHeaders, security.responseHeaders]) {
        assert.equal(
            [...headers].filter(([name]) => name === CONTENT_SECURITY_POLICY.toLowerCase()).length,
            1,
        );
        assert.equal(
            [...headers].filter(
                ([name]) => name === CONTENT_SECURITY_POLICY_REPORT_ONLY.toLowerCase(),
            ).length,
            1,
        );
    }
});

test("document responses receive only the exact fixed defensive header values", () => {
    const security = createDocumentSecurityContext(request("/"), () => FIXED_NONCE);

    assert.ok(security);
    assert.equal(PERMISSIONS_POLICY.includes("fullscreen"), false);
    assert.deepEqual(Object.fromEntries(security.responseHeaders), {
        "content-security-policy": buildContentSecurityPolicy(FIXED_NONCE),
        "content-security-policy-report-only": buildContentSecurityPolicy(FIXED_NONCE),
        "cross-origin-opener-policy": "same-origin",
        "permissions-policy":
            "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), screen-wake-lock=(), usb=(), clipboard-write=(self), publickey-credentials-create=(self), publickey-credentials-get=(self)",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "x-xss-protection": "0",
    });

    for (const [name, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
        assert.equal(security.responseHeaders.get(name), value);
    }
});
