import assert from "node:assert/strict";
import test from "node:test";
import { MatrixClient } from "matrix-js-sdk";
import { OAuth2 } from "matrix-js-sdk/lib/oauth";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "../app/components/BrandMark";
import {
    assertDeclaredMediaLimits,
    assertMediaByteLength,
    assertSafeImageBytes,
    isMxcUri,
    MAX_MEDIA_CACHE_BYTES,
    MAX_MEDIA_BYTES,
    MediaLimitError,
    readBoundedResponse,
} from "../lib/matrix/media";
import {
    LEGACY_SSO_STATE_PARAM,
    OAuthPostGrantRevocationUnconfirmedError,
    completeRedirectLogin,
    hasRedirectLoginParameters,
    legacySsoRedirectUrl,
    normalizeHomeserverInput,
    parseRedirectLoginParameters,
    revokeIssuedOAuthTokensWithinDeadline,
    validateLegacySsoCallback,
} from "../lib/matrix/auth";
import { MatrixService } from "../lib/matrix/client";
import type { PersistedMatrixSession } from "../lib/matrix/types";
import { assertAllowedHomeserverUrl } from "../lib/matrix/url-policy";

const LOCAL_POLICY = {
    appOrigin: "http://localhost:3000",
    production: false,
};

function rasterFixture(
    mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp",
    width: number,
    height: number,
): Uint8Array {
    if (mimeType === "image/gif") {
        const bytes = new Uint8Array(13);

        bytes.set(new TextEncoder().encode("GIF89a"));
        const view = new DataView(bytes.buffer);

        view.setUint16(6, width, true);
        view.setUint16(8, height, true);

        return bytes;
    }

    if (mimeType === "image/png") {
        const bytes = new Uint8Array(24);

        bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
        bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
        const view = new DataView(bytes.buffer);

        view.setUint32(16, width);
        view.setUint32(20, height);

        return bytes;
    }

    if (mimeType === "image/jpeg") {
        const bytes = Uint8Array.from([
            0xff,
            0xd8,
            0xff,
            0xc0,
            0x00,
            0x0b,
            0x08,
            height >> 8,
            height & 0xff,
            width >> 8,
            width & 0xff,
            0x01,
            0x01,
            0x11,
            0x00,
        ]);

        return bytes;
    }

    const bytes = new Uint8Array(30);

    bytes.set(new TextEncoder().encode("RIFF"), 0);
    new DataView(bytes.buffer).setUint32(4, 22, true);
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
    new DataView(bytes.buffer).setUint32(16, 10, true);
    bytes[24] = (width - 1) & 0xff;
    bytes[25] = ((width - 1) >> 8) & 0xff;
    bytes[26] = ((width - 1) >> 16) & 0xff;
    bytes[27] = (height - 1) & 0xff;
    bytes[28] = ((height - 1) >> 8) & 0xff;
    bytes[29] = ((height - 1) >> 16) & 0xff;

    return bytes;
}

test("homeserver transport requires HTTPS outside loopback development", () => {
    assert.equal(
        assertAllowedHomeserverUrl("https://matrix.example", {
            appOrigin: "https://sub-etha-matrix.vercel.app",
            production: true,
        }),
        "https://matrix.example",
    );
    assert.equal(
        assertAllowedHomeserverUrl("http://localhost:8008", LOCAL_POLICY),
        "http://localhost:8008",
    );
    assert.equal(
        assertAllowedHomeserverUrl("http://127.0.0.2:8008", LOCAL_POLICY),
        "http://127.0.0.2:8008",
    );
    assert.equal(
        assertAllowedHomeserverUrl("http://[::1]:8008", LOCAL_POLICY),
        "http://[::1]:8008",
    );

    assert.throws(
        () => assertAllowedHomeserverUrl("http://matrix.example", LOCAL_POLICY),
        /HTTPS/i,
    );
    assert.throws(
        () =>
            assertAllowedHomeserverUrl("http://localhost:8008", {
                appOrigin: "https://sub-etha-matrix.vercel.app",
                production: true,
            }),
        /HTTPS/i,
    );
    assert.throws(
        () =>
            assertAllowedHomeserverUrl("https://user:secret@matrix.example", {
                appOrigin: "https://sub-etha-matrix.vercel.app",
                production: true,
            }),
        /credentials/i,
    );
    assert.throws(
        () => normalizeHomeserverInput("https://user:secret@matrix.example"),
        /credentials/i,
    );
});

test("legacy SSO callbacks are bound to a fresh initiating transaction", () => {
    const pending = {
        kind: "sso" as const,
        baseUrl: "https://matrix.example",
        state: "expected-state",
        createdAt: 1_800_000_000_000,
    };
    const callback = new URLSearchParams({
        loginToken: "login-token",
        [LEGACY_SSO_STATE_PARAM]: pending.state,
    });

    assert.doesNotThrow(() =>
        validateLegacySsoCallback(pending, callback, pending.createdAt + 60_000),
    );
    assert.throws(
        () =>
            validateLegacySsoCallback(
                pending,
                new URLSearchParams({ loginToken: "login-token" }),
                pending.createdAt + 60_000,
            ),
        /state/i,
    );
    assert.throws(
        () =>
            validateLegacySsoCallback(
                pending,
                new URLSearchParams({
                    loginToken: "login-token",
                    [LEGACY_SSO_STATE_PARAM]: "attacker-state",
                }),
                pending.createdAt + 60_000,
            ),
        /state/i,
    );
    assert.throws(
        () => validateLegacySsoCallback(pending, callback, pending.createdAt + 10 * 60_000 + 1),
        /expired/i,
    );

    const redirect = new URL(
        legacySsoRedirectUrl("https://sub-etha-matrix.vercel.app", pending.state),
    );

    assert.equal(redirect.origin, "https://sub-etha-matrix.vercel.app");
    assert.equal(redirect.searchParams.get(LEGACY_SSO_STATE_PARAM), pending.state);
});

test("redirect callback parsing preserves query precedence and ignores ordinary room hashes", () => {
    const parsed = parseRedirectLoginParameters(
        "?code=query-code&state=query-state",
        "#code=fragment-code&state=fragment-state&loginToken=fragment-token",
    );

    assert.equal(parsed.get("code"), "query-code");
    assert.equal(parsed.get("state"), "query-state");
    assert.equal(parsed.get("loginToken"), "fragment-token");

    assert.equal(hasRedirectLoginParameters("", "#code=fragment-code"), true);
    assert.equal(hasRedirectLoginParameters("", "#loginToken=fragment-token"), true);
    assert.equal(hasRedirectLoginParameters("", "#error=access_denied"), true);
    assert.equal(hasRedirectLoginParameters("?code=query-code", "#code=fragment-code"), true);
    assert.equal(hasRedirectLoginParameters("?code=", "#code=fragment-code"), false);
    assert.equal(hasRedirectLoginParameters("?loginToken=", "#loginToken=fragment-token"), false);
    assert.equal(hasRedirectLoginParameters("?loginToken=&login_token=snake-token", ""), false);
    assert.equal(hasRedirectLoginParameters("?code=", ""), false);
    assert.equal(hasRedirectLoginParameters("?state=state-only", ""), false);
    assert.equal(hasRedirectLoginParameters("", "#/room/%21safe%3Aexample"), false);
    assert.equal(hasRedirectLoginParameters("", "#/room/%21safe%3Aexample?code=room-code"), false);
});

test("invalid and crossed auth callbacks clear state and URL data before token exchange", async () => {
    const originalWindow = globalThis.window;
    const originalSessionStorage = globalThis.sessionStorage;
    const hadWindow = "window" in globalThis;
    const hadSessionStorage = "sessionStorage" in globalThis;
    const values = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => {
            values.delete(key);
        },
        setItem: (key, value) => {
            values.set(key, value);
        },
    };
    const replaced: string[] = [];

    const installCallback = (search: string, hash = "") => {
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                location: { search, hash, pathname: "/" },
                history: {
                    replaceState: (_state: unknown, _unused: string, path: string) =>
                        replaced.push(path),
                },
            },
        });
        Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
    };

    try {
        installCallback("?loginToken=token&subetha_sso_state=missing");
        await assert.rejects(completeRedirectLogin(), /departure paperwork/i);
        assert.equal(replaced.pop(), "/");

        values.set(
            "sub-etha-pending-auth",
            JSON.stringify({
                kind: "sso",
                baseUrl: "https://matrix.example",
                state: "expected",
                createdAt: Date.now(),
            }),
        );
        installCallback("?loginToken=token&subetha_sso_state=wrong");
        await assert.rejects(completeRedirectLogin(), /state/i);
        assert.equal(values.size, 0);
        assert.equal(replaced.pop(), "/");

        values.set(
            "sub-etha-pending-auth",
            JSON.stringify({
                kind: "oauth",
                baseUrl: "https://matrix.example",
                state: "expected",
                metadata: {},
                context: {},
            }),
        );
        installCallback("?loginToken=token&state=expected");
        await assert.rejects(completeRedirectLogin(), /unexpected login response/i);
        assert.equal(values.size, 0);
        assert.equal(replaced.pop(), "/");
    } finally {
        if (hadWindow) {
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: originalWindow,
            });
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }

        if (hadSessionStorage) {
            Object.defineProperty(globalThis, "sessionStorage", {
                configurable: true,
                value: originalSessionStorage,
            });
        } else {
            Reflect.deleteProperty(globalThis, "sessionStorage");
        }
    }
});

test("an OAuth callback revokes issued tokens when post-grant identity lookup fails", async (t) => {
    const originalWindow = globalThis.window;
    const originalSessionStorage = globalThis.sessionStorage;
    const hadWindow = "window" in globalThis;
    const hadSessionStorage = "sessionStorage" in globalThis;
    const values = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    };
    const revoked: string[] = [];

    values.set(
        "sub-etha-pending-auth",
        JSON.stringify({
            kind: "oauth",
            baseUrl: "https://matrix.example",
            state: "expected-state",
            metadata: {
                authorization_endpoint: "https://issuer.example/authorize",
                code_challenge_methods_supported: ["S256"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                issuer: "https://issuer.example/",
                registration_endpoint: "https://issuer.example/register",
                response_modes_supported: ["query", "fragment"],
                response_types_supported: ["code"],
                revocation_endpoint: "https://issuer.example/revoke",
                token_endpoint: "https://issuer.example/token",
            },
            context: {
                clientId: "client-id",
                deviceId: "DEVICE",
                codeVerifier: "code-verifier",
                redirectUri: "https://sub-etha.example/",
            },
        }),
    );
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            location: {
                search: "?code=authorization-code&state=expected-state",
                hash: "",
                pathname: "/",
            },
            history: { replaceState: () => undefined },
        },
    });
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: storage,
    });
    t.mock.method(OAuth2.prototype, "completeAuthorizationCodeGrant", async () => ({
        access_token: "issued-access",
        refresh_token: "issued-refresh",
        expires_in: 60,
        token_type: "Bearer",
    }));
    t.mock.method(MatrixClient.prototype, "whoami", async () => {
        throw new Error("identity lookup failed");
    });
    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        async (token: string, type?: "access_token" | "refresh_token") => {
            revoked.push(`${type}:${token}`);
        },
    );

    try {
        await assert.rejects(completeRedirectLogin(), /identity lookup failed/);
        assert.deepEqual(revoked, ["refresh_token:issued-refresh", "access_token:issued-access"]);
    } finally {
        if (hadWindow) {
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: originalWindow,
            });
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }

        if (hadSessionStorage) {
            Object.defineProperty(globalThis, "sessionStorage", {
                configurable: true,
                value: originalSessionStorage,
            });
        } else {
            Reflect.deleteProperty(globalThis, "sessionStorage");
        }
    }
});

test("an OAuth callback surfaces typed uncertainty when post-grant revocation fails", async (t) => {
    const originalWindow = globalThis.window;
    const originalSessionStorage = globalThis.sessionStorage;
    const hadWindow = "window" in globalThis;
    const hadSessionStorage = "sessionStorage" in globalThis;
    const values = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    };

    values.set(
        "sub-etha-pending-auth",
        JSON.stringify({
            kind: "oauth",
            baseUrl: "https://matrix.example",
            state: "expected-state",
            metadata: {
                authorization_endpoint: "https://issuer.example/authorize",
                code_challenge_methods_supported: ["S256"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                issuer: "https://issuer.example/",
                registration_endpoint: "https://issuer.example/register",
                response_modes_supported: ["query", "fragment"],
                response_types_supported: ["code"],
                revocation_endpoint: "https://issuer.example/revoke",
                token_endpoint: "https://issuer.example/token",
            },
            context: {
                clientId: "client-id",
                deviceId: "DEVICE",
                codeVerifier: "code-verifier",
                redirectUri: "https://sub-etha.example/",
            },
        }),
    );
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            location: {
                search: "?code=authorization-code&state=expected-state",
                hash: "",
                pathname: "/",
            },
            history: { replaceState: () => undefined },
        },
    });
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: storage,
    });
    t.mock.method(OAuth2.prototype, "completeAuthorizationCodeGrant", async () => ({
        access_token: "issued-access-unconfirmed",
        refresh_token: "issued-refresh-unconfirmed",
        expires_in: 60,
        token_type: "Bearer",
    }));
    t.mock.method(MatrixClient.prototype, "whoami", async () => {
        throw new Error("post-grant identity failed");
    });
    t.mock.method(OAuth2.prototype, "revokeToken", async () => {
        throw new Error("revocation endpoint unavailable");
    });

    try {
        await assert.rejects(
            completeRedirectLogin(),
            (error: unknown) =>
                error instanceof OAuthPostGrantRevocationUnconfirmedError &&
                error.remoteSessionEnded === false &&
                error.cause instanceof Error &&
                error.cause.message === "post-grant identity failed",
        );
    } finally {
        if (hadWindow) {
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: originalWindow,
            });
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }

        if (hadSessionStorage) {
            Object.defineProperty(globalThis, "sessionStorage", {
                configurable: true,
                value: originalSessionStorage,
            });
        } else {
            Reflect.deleteProperty(globalThis, "sessionStorage");
        }
    }
});

test("issued OAuth token revocation treats a deadline as unconfirmed", async () => {
    const result = await revokeIssuedOAuthTokensWithinDeadline(
        { revokeToken: () => new Promise<void>(() => undefined) },
        { access_token: "stalled-access", refresh_token: "stalled-refresh" },
        1,
    );

    assert.equal(result, false);
});

test("OAuth metadata and authorization navigation reject unsafe URL schemes", async () => {
    const auth = (await import("../lib/matrix/auth")) as typeof import("../lib/matrix/auth") & {
        assertSafeOAuthMetadata?: (metadata: unknown) => unknown;
        assertSafeOAuthNavigationUrl?: (value: string) => string;
        assertSafeSsoNavigationUrl?: (value: string, baseUrl: string) => string;
    };

    assert.equal(typeof auth.assertSafeOAuthMetadata, "function");
    assert.equal(typeof auth.assertSafeOAuthNavigationUrl, "function");
    assert.equal(typeof auth.assertSafeSsoNavigationUrl, "function");

    assert.doesNotThrow(() =>
        auth.assertSafeOAuthMetadata?.({
            issuer: "https://issuer.example",
            authorization_endpoint: "https://issuer.example/authorize",
            token_endpoint: "https://issuer.example/token",
            registration_endpoint: "https://issuer.example/register",
        }),
    );
    assert.equal(
        auth.assertSafeOAuthNavigationUrl?.("https://issuer.example/authorize?client_id=sub-etha"),
        "https://issuer.example/authorize?client_id=sub-etha",
    );

    for (const unsafe of [
        "javascript:alert(document.domain)",
        "data:text/html,unsafe",
        "http://issuer.example/authorize",
        "https://user:secret@issuer.example/authorize",
    ]) {
        assert.throws(
            () => auth.assertSafeOAuthMetadata?.({ authorization_endpoint: unsafe }),
            /OAuth|HTTPS|credentials/i,
        );
        assert.throws(
            () => auth.assertSafeOAuthNavigationUrl?.(unsafe),
            /OAuth|HTTPS|credentials/i,
        );
    }

    assert.equal(
        auth.assertSafeSsoNavigationUrl?.(
            "https://matrix.example/_matrix/client/v3/login/sso/redirect?redirectUrl=https%3A%2F%2Fapp.example",
            "https://matrix.example",
        ),
        "https://matrix.example/_matrix/client/v3/login/sso/redirect?redirectUrl=https%3A%2F%2Fapp.example",
    );
    assert.throws(
        () => auth.assertSafeSsoNavigationUrl?.("javascript:alert(1)", "https://matrix.example"),
        /SSO/i,
    );
    assert.throws(
        () =>
            auth.assertSafeSsoNavigationUrl?.(
                "https://attacker.example/login",
                "https://matrix.example",
            ),
        /SSO/i,
    );
});

test("malformed room URL fragments are ignored without throwing", async () => {
    const chatShell =
        (await import("../app/components/ChatShell")) as typeof import("../app/components/ChatShell") & {
            parseRoomHash?: (hash: string) => string | null;
        };

    assert.equal(typeof chatShell.parseRoomHash, "function");
    assert.equal(chatShell.parseRoomHash?.("#/room/%"), null);
    assert.equal(chatShell.parseRoomHash?.("#/room/%E0%A4%A"), null);
    assert.equal(
        chatShell.parseRoomHash?.("#/room/%21safe%3Amatrix.example"),
        "!safe:matrix.example",
    );
});

test("only Matrix content URIs qualify as remote avatars", () => {
    assert.equal(isMxcUri("mxc://matrix.example/avatar"), true);
    assert.equal(isMxcUri("https://tracker.example/avatar.png"), false);
    assert.equal(isMxcUri("//tracker.example/avatar.png"), false);
    assert.equal(isMxcUri("/night-receiver-plate.png"), false);
    assert.equal(isMxcUri(null), false);

    const externalAvatar = renderToStaticMarkup(
        createElement(Avatar, {
            name: "Ford Prefect",
            mxcUrl: "https://tracker.example/avatar.png",
        }),
    );

    assert.equal(externalAvatar.includes("tracker.example"), false);
    assert.equal(externalAvatar.includes("<img"), false);
    assert.equal(externalAvatar.includes("FP"), true);
});

test("media downloads enforce declared, header, and streamed byte limits", async () => {
    assert.throws(() => assertDeclaredMediaLimits({ size: MAX_MEDIA_BYTES + 1 }), MediaLimitError);
    await assert.rejects(
        readBoundedResponse(new Response("safe", { headers: { "Content-Length": "5" } }), 4),
        MediaLimitError,
    );

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(Uint8Array.of(1, 2, 3));
            controller.enqueue(Uint8Array.of(4, 5));
        },
        cancel() {
            cancelled = true;
        },
    });

    await assert.rejects(readBoundedResponse(new Response(body), 4), MediaLimitError);
    assert.equal(cancelled, true);

    const exact = await readBoundedResponse(new Response(Uint8Array.of(1, 2, 3, 4)), 4);

    assert.equal(exact.byteLength, 4);
    assert.doesNotThrow(() => assertMediaByteLength(MAX_MEDIA_BYTES));
    assert.throws(() => assertMediaByteLength(MAX_MEDIA_BYTES + 1), MediaLimitError);
});

test("stalled media streams time out, cancel, and remain retriable", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        cancel() {
            cancelled = true;
        },
    });
    const result = await Promise.race([
        (
            readBoundedResponse as unknown as (
                response: Response,
                maximumBytes: number,
                options: { idleTimeoutMs: number; totalTimeoutMs: number },
            ) => Promise<ArrayBuffer>
        )(new Response(body), 4, { idleTimeoutMs: 10, totalTimeoutMs: 25 })
            .then(() => ({ settled: true, error: null }))
            .catch((error: unknown) => ({ settled: true, error })),
        new Promise<{ settled: false; error: null }>((resolve) => {
            setTimeout(() => resolve({ settled: false, error: null }), 100);
        }),
    ]);

    assert.equal(result.settled, true);
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /timed out/i);
    assert.notEqual(result.error, null);
    assert.equal((result.error as Error & { retryable?: boolean }).retryable, true);
    assert.equal(cancelled, true);
});

test("image previews validate actual dimensions rather than declared MIME metadata", () => {
    const onePixelPng = Uint8Array.from(
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
        ),
    );

    assert.doesNotThrow(() => assertSafeImageBytes(onePixelPng));

    for (const mimeType of ["image/gif", "image/jpeg", "image/webp"] as const) {
        const safety = assertSafeImageBytes(rasterFixture(mimeType, 32, 24));

        assert.equal(safety.mimeType, mimeType);
        assert.equal(safety.width, 32);
        assert.equal(safety.height, 24);
    }

    const oversizedPngHeader = new Uint8Array(24);

    oversizedPngHeader.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    oversizedPngHeader.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
    new DataView(oversizedPngHeader.buffer).setUint32(16, 16_385);
    new DataView(oversizedPngHeader.buffer).setUint32(20, 1);
    assert.throws(() => assertSafeImageBytes(oversizedPngHeader), MediaLimitError);
    assert.throws(
        () => assertSafeImageBytes(new TextEncoder().encode("not an image")),
        MediaLimitError,
    );
});

test("image previews bound decoded bytes and cumulative animation work", () => {
    const pngHeader = (width: number, height: number) => {
        const bytes = new Uint8Array(24);

        bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
        bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
        const view = new DataView(bytes.buffer);

        view.setUint32(16, width);
        view.setUint32(20, height);

        return bytes;
    };

    assert.doesNotThrow(() => assertSafeImageBytes(pngHeader(4096, 4096)));
    assert.throws(() => assertSafeImageBytes(pngHeader(4097, 4096)), MediaLimitError);

    const animatedGif = Uint8Array.from([
        71, 73, 70, 56, 57, 97, 0, 16, 0, 16, 0, 0, 0, 44, 0, 0, 0, 0, 0, 16, 0, 16, 0, 2, 2, 76, 1,
        0, 44, 0, 0, 0, 0, 0, 16, 0, 16, 0, 2, 2, 76, 1, 0, 59,
    ]);

    assert.throws(() => assertSafeImageBytes(animatedGif), MediaLimitError);
});

test("forged image MIME metadata cannot bypass byte inspection", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
        new Response(new TextEncoder().encode("not an image"), {
            headers: { "Content-Type": "image/png" },
        })) as typeof fetch;
    const service = mediaService();

    try {
        await assert.rejects(
            service.getMediaAsset(
                { mxcUrl: "mxc://matrix.example/forged", mimeType: "image/png" },
                { expectedKind: "image" },
            ),
            MediaLimitError,
        );
    } finally {
        (service as unknown as { releaseMediaAssets: () => void }).releaseMediaAssets();
        globalThis.fetch = originalFetch;
    }
});

test("validated raster bytes determine the preview MIME type and SVG is rejected", async () => {
    const onePixelPng = Uint8Array.from(
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
        ),
    );
    const svg = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    );

    assert.throws(() => assertSafeImageBytes(svg), MediaLimitError);

    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
        new Response(onePixelPng, {
            headers: { "Content-Type": "text/html" },
        })) as typeof fetch;
    const service = mediaService();

    try {
        const asset = await service.getMediaAsset(
            { mxcUrl: "mxc://matrix.example/mime-confusion", mimeType: "text/html" },
            { expectedKind: "image" },
        );

        assert.equal(asset.mimeType, "image/png");
        assert.equal(asset.blob.type, "image/png");
    } finally {
        (service as unknown as { releaseMediaAssets: () => void }).releaseMediaAssets();
        globalThis.fetch = originalFetch;
    }
});

const SESSION: PersistedMatrixSession = {
    accessToken: "token",
    authKind: "token",
    baseUrl: "https://matrix.example",
    cryptoDatabasePrefix: "sub-etha-crypto-record-1",
    cryptoStorageKey: "AQID",
    deviceId: "DEVICE",
    userId: "@arthur:matrix.example",
};

function mediaService(): MatrixService {
    const service = new MatrixService({
        session: SESSION,
        recordId: "record-1",
        revision: 1,
        cryptoDatabasePrefix: "sub-etha-crypto-record-1",
        reseal: async () => undefined,
        dispose: () => undefined,
    } as never);
    const client = {
        getAccessToken: () => "token",
        getHomeserverUrl: () => "https://matrix.example",
        mxcUrlToHttp: (mxcUrl: string) =>
            `https://matrix.example/media/${encodeURIComponent(mxcUrl)}`,
    };

    (service as unknown as { client: typeof client }).client = client;

    return service;
}

test("automatic Matrix media loading never exceeds three concurrent fetches", async () => {
    const originalFetch = globalThis.fetch;
    const pending: Array<() => void> = [];
    let active = 0;
    let maximum = 0;

    globalThis.fetch = (async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active -= 1;

        return new Response(Uint8Array.of(1));
    }) as typeof fetch;
    const service = mediaService();

    try {
        const loads = Array.from({ length: 4 }, (_, index) =>
            service.getMediaAsset(
                { mxcUrl: `mxc://matrix.example/${index}`, size: 1 },
                { cacheKey: `media-${index}`, expectedKind: "file" },
            ),
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(maximum, 3);
        pending.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(maximum, 3);

        while (pending.length) {
            pending.shift()?.();
        }

        await Promise.all(loads);
    } finally {
        (service as unknown as { releaseMediaAssets: () => void }).releaseMediaAssets();
        globalThis.fetch = originalFetch;
    }
});

test("Matrix media cache uses LRU order and revokes every object URL", async () => {
    const originalFetch = globalThis.fetch;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    let sequence = 0;

    globalThis.fetch = (async () => new Response(Uint8Array.of(1))) as typeof fetch;
    URL.createObjectURL = () => `blob:test-${++sequence}`;

    URL.revokeObjectURL = (url) => {
        revoked.push(url);
    };

    const service = mediaService();

    try {
        for (let index = 0; index < 97; index += 1) {
            if (index === 96) {
                await service.getMediaAsset(
                    { mxcUrl: "mxc://matrix.example/cache-0", size: 1 },
                    { cacheKey: "cache-0", expectedKind: "file" },
                );
            }

            await service.getMediaAsset(
                { mxcUrl: `mxc://matrix.example/cache-${index}`, size: 1 },
                { cacheKey: `cache-${index}`, expectedKind: "file" },
            );
        }

        const cache = (service as unknown as { mediaAssets: Map<string, unknown> }).mediaAssets;

        assert.equal(cache.size, 96);
        assert.deepEqual(revoked, ["blob:test-2"]);
    } finally {
        (service as unknown as { releaseMediaAssets: () => void }).releaseMediaAssets();
        await Promise.resolve();
        assert.equal(new Set(revoked).size, 97);
        globalThis.fetch = originalFetch;
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
    }
});

test("media cache byte cap evicts the least-recently-used asset", async () => {
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];

    URL.revokeObjectURL = (url) => {
        revoked.push(url);
    };

    const service = mediaService();

    type FakeEntry = {
        promise: Promise<{ url: string; blob: Blob; mimeType: string; animated: boolean }>;
        byteLength: number;
        lastUsed: number;
        settled: boolean;
        released: boolean;
    };
    const internal = service as unknown as {
        mediaAssets: Map<string, FakeEntry>;
        mediaCacheBytes: number;
        evictMediaCache: (kind: "media", key: string) => void;
    };

    try {
        for (let index = 0; index < 5; index += 1) {
            internal.mediaAssets.set(`asset-${index}`, {
                promise: Promise.resolve({
                    url: `blob:large-${index}`,
                    blob: new Blob(),
                    mimeType: "application/octet-stream",
                    animated: false,
                }),
                byteLength: 64 * 1024 * 1024,
                lastUsed: index,
                settled: true,
                released: false,
            });
        }

        internal.mediaCacheBytes = 5 * 64 * 1024 * 1024;
        internal.evictMediaCache("media", "asset-4");
        await Promise.resolve();
        assert.equal(internal.mediaCacheBytes, MAX_MEDIA_CACHE_BYTES);
        assert.equal(internal.mediaAssets.size, 4);
        assert.deepEqual(revoked, ["blob:large-0"]);
    } finally {
        internal.mediaAssets.clear();
        URL.revokeObjectURL = originalRevoke;
    }
});

test("evicting or shutting down media work aborts pending downloads", async () => {
    const originalFetch = globalThis.fetch;
    let aborted = 0;

    globalThis.fetch = ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;

            signal?.addEventListener(
                "abort",
                () => {
                    aborted += 1;
                    reject(signal.reason);
                },
                { once: true },
            );
        })) as typeof fetch;
    const service = mediaService();

    try {
        const loads = Array.from({ length: 97 }, (_, index) =>
            service.getMediaAsset(
                { mxcUrl: `mxc://matrix.example/pending-${index}` },
                { cacheKey: `pending-${index}`, expectedKind: "file" },
            ),
        );
        const settled = Promise.allSettled(loads);

        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(aborted >= 1);
        (service as unknown as { releaseMediaAssets: () => void }).releaseMediaAssets();
        await settled;
        assert.ok(aborted >= 3);
    } finally {
        (service as unknown as { releaseMediaAssets: () => void }).releaseMediaAssets();
        globalThis.fetch = originalFetch;
    }
});
