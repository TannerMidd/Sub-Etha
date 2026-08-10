import type { ValidatedAuthMetadata } from "matrix-js-sdk/lib/oauth";
import type { LoginResponse } from "matrix-js-sdk";
import { createSession, randomBase64Url } from "./session-store";
import type { LoginCapabilities, PersistedMatrixSession } from "./types";
import { assertAllowedHomeserverUrl } from "./url-policy";

const PENDING_AUTH_KEY = "sub-etha-pending-auth";
const OAUTH_CLIENT_PREFIX = "sub-etha-oauth-client:";
const LEGACY_SSO_MAX_AGE_MS = 10 * 60 * 1_000;

export const LEGACY_SSO_STATE_PARAM = "subetha_sso_state";
const OAUTH_URL_FIELDS = [
    "account_management_uri",
    "authorization_endpoint",
    "device_authorization_endpoint",
    "issuer",
    "registration_endpoint",
    "revocation_endpoint",
    "token_endpoint",
] as const;

export interface PendingSso {
    kind: "sso";
    baseUrl: string;
    state: string;
    createdAt: number;
}

interface PendingOAuth {
    kind: "oauth";
    baseUrl: string;
    state: string;
    metadata: ValidatedAuthMetadata;
    context: {
        clientId: string;
        deviceId: string;
        codeVerifier: string;
        redirectUri: string;
    };
}

type PendingAuth = PendingSso | PendingOAuth;

export function assertSafeOAuthNavigationUrl(value: string): string {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new Error("The homeserver returned an invalid OAuth URL.");
    }

    if (url.protocol !== "https:") {
        throw new Error("OAuth endpoints must use HTTPS.");
    }

    if (url.username || url.password) {
        throw new Error("OAuth endpoints must not contain credentials.");
    }

    return url.toString();
}

export function assertSafeOAuthMetadata<T>(metadata: T): T {
    if (!metadata || typeof metadata !== "object") {
        throw new Error("The homeserver returned invalid OAuth metadata.");
    }

    const values = metadata as Record<string, unknown>;

    for (const field of OAUTH_URL_FIELDS) {
        const value = values[field];

        if (value === undefined) {
            continue;
        }

        if (typeof value !== "string") {
            throw new Error(`The homeserver returned an invalid OAuth ${field}.`);
        }

        const safeUrl = new URL(assertSafeOAuthNavigationUrl(value));

        if (safeUrl.hash) {
            throw new Error("OAuth metadata endpoints must not contain fragments.");
        }
    }

    return metadata;
}

export function assertSafeSsoNavigationUrl(value: string, baseUrl: string): string {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new Error("The homeserver returned an invalid SSO URL.");
    }

    const expectedOrigin = new URL(baseUrl).origin;

    if (url.origin !== expectedOrigin || url.username || url.password) {
        throw new Error("The homeserver returned an unsafe SSO URL.");
    }

    return url.toString();
}

export function humanizeMatrixError(error: unknown): string {
    if (error && typeof error === "object") {
        const value = error as { errcode?: string; data?: { error?: string }; message?: string };

        if (value.data?.error) {
            return value.data.error;
        }

        if (value.errcode === "M_FORBIDDEN") {
            return "The homeserver declined those credentials.";
        }

        if (value.errcode === "M_LIMIT_EXCEEDED") {
            return "The homeserver is busy. Give it a moment, then try again.";
        }

        if (value.message) {
            if (/fetch|network|cors/i.test(value.message)) {
                return "The homeserver could not be reached from this browser. Check its address and browser-client support.";
            }

            return value.message;
        }
    }

    return "Something improbable happened while contacting the homeserver.";
}

export function normalizeHomeserverInput(raw: string): {
    serverName: string;
    explicitUrl?: string;
} {
    const value = raw.trim();

    if (!value) {
        throw new Error("Enter a Matrix ID, server name, or homeserver URL.");
    }

    if (/^https?:\/\//i.test(value)) {
        const allowedUrl = new URL(assertAllowedHomeserverUrl(value));

        return { serverName: allowedUrl.host, explicitUrl: allowedUrl.origin };
    }

    const serverName =
        value.startsWith("@") && value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;

    if (!serverName || /[\s/]/.test(serverName)) {
        throw new Error("That does not look like a Matrix server.");
    }

    return { serverName };
}

export async function discoverHomeserver(
    raw: string,
): Promise<{ baseUrl: string; serverName: string }> {
    const { serverName, explicitUrl } = normalizeHomeserverInput(raw);
    const candidates: string[] = [];

    if (explicitUrl) {
        candidates.push(explicitUrl);
    } else {
        try {
            const response = await fetch(`https://${serverName}/.well-known/matrix/client`, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(8_000),
            });

            if (response.ok) {
                const body = (await response.json()) as { "m.homeserver"?: { base_url?: string } };

                if (body["m.homeserver"]?.base_url) {
                    candidates.push(body["m.homeserver"].base_url);
                }
            }
        } catch {
            // The direct hostname fallback below is required by Matrix discovery.
        }

        candidates.push(`https://${serverName}`);
    }

    let lastError: unknown;

    for (const candidate of [...new Set(candidates)]) {
        try {
            const baseUrl = assertAllowedHomeserverUrl(candidate.replace(/\/$/, ""));
            const response = await fetch(`${baseUrl}/_matrix/client/versions`, {
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(10_000),
            });

            if (response.ok) {
                return { baseUrl, serverName };
            }

            lastError = new Error(`The server returned ${response.status}.`);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error("No compatible Matrix homeserver was found.");
}

export async function inspectLoginCapabilities(raw: string): Promise<LoginCapabilities> {
    const { baseUrl, serverName } = await discoverHomeserver(raw);
    const { createClient } = await import("matrix-js-sdk");
    const client = createClient({ baseUrl, localTimeoutMs: 10_000, disableVoip: true });
    const [legacy, oauth] = await Promise.allSettled([
        client.loginFlows(),
        client.getAuthMetadata().then(assertSafeOAuthMetadata),
    ]);
    const flows = legacy.status === "fulfilled" ? legacy.value.flows : [];
    const ssoFlow = flows.find(
        (flow) => flow.type === "m.login.sso" || flow.type === "m.login.cas",
    );
    const providers =
        ssoFlow && "identity_providers" in ssoFlow ? (ssoFlow.identity_providers ?? []) : [];

    return {
        baseUrl,
        serverName,
        password: flows.some((flow) => flow.type === "m.login.password"),
        token: flows.some((flow) => flow.type === "m.login.token"),
        sso: Boolean(ssoFlow),
        oauth: oauth.status === "fulfilled",
        identityProviders: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            brand: provider.brand,
        })),
    };
}

function sessionFromLogin(
    baseUrl: string,
    response: LoginResponse,
    authKind: PersistedMatrixSession["authKind"],
): PersistedMatrixSession {
    return createSession({
        baseUrl,
        userId: response.user_id,
        deviceId: response.device_id,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        expiresAt: response.expires_in_ms ? Date.now() + response.expires_in_ms : undefined,
        authKind,
    });
}

export async function loginWithPassword(
    baseUrl: string,
    user: string,
    password: string,
): Promise<PersistedMatrixSession> {
    baseUrl = assertAllowedHomeserverUrl(baseUrl);
    const { createClient } = await import("matrix-js-sdk");
    const response = await createClient({
        baseUrl,
        localTimeoutMs: 15_000,
        disableVoip: true,
    }).loginRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password,
        refresh_token: true,
        initial_device_display_name: "Sub-Etha PWA",
    });

    return sessionFromLogin(baseUrl, response, "password");
}

export async function loginWithAccessToken(
    baseUrl: string,
    accessToken: string,
): Promise<PersistedMatrixSession> {
    baseUrl = assertAllowedHomeserverUrl(baseUrl);
    const { createClient } = await import("matrix-js-sdk");
    const client = createClient({
        baseUrl,
        accessToken,
        localTimeoutMs: 15_000,
        disableVoip: true,
    });
    const identity = await client.whoami();

    if (!identity.device_id) {
        throw new Error("This access token is not attached to a Matrix device.");
    }

    return createSession({
        baseUrl,
        userId: identity.user_id,
        deviceId: identity.device_id,
        accessToken,
        authKind: "token",
    });
}

export function legacySsoRedirectUrl(origin: string, state: string): string {
    const redirect = new URL("/", origin);

    redirect.searchParams.set(LEGACY_SSO_STATE_PARAM, state);

    return redirect.toString();
}

export function validateLegacySsoCallback(
    pending: PendingSso,
    params: URLSearchParams,
    now = Date.now(),
): void {
    if (!pending.state || params.get(LEGACY_SSO_STATE_PARAM) !== pending.state) {
        throw new Error("The SSO state did not match; no credentials were accepted.");
    }

    const age = now - pending.createdAt;

    if (!Number.isFinite(age) || age < 0 || age > LEGACY_SSO_MAX_AGE_MS) {
        throw new Error("The SSO return expired. Please begin again.");
    }
}

export async function beginSso(baseUrl: string, providerId?: string): Promise<void> {
    baseUrl = assertAllowedHomeserverUrl(baseUrl);
    const { createClient } = await import("matrix-js-sdk");
    const state = randomBase64Url(24);
    const redirectUrl = legacySsoRedirectUrl(window.location.origin, state);
    const client = createClient({ baseUrl, disableVoip: true });
    const pending: PendingSso = { kind: "sso", baseUrl, state, createdAt: Date.now() };

    sessionStorage.setItem(PENDING_AUTH_KEY, JSON.stringify(pending));
    window.location.assign(
        assertSafeSsoNavigationUrl(client.getSsoLoginUrl(redirectUrl, "sso", providerId), baseUrl),
    );
}

export async function beginOAuth(baseUrl: string): Promise<void> {
    baseUrl = assertAllowedHomeserverUrl(baseUrl);

    if (window.location.protocol !== "https:") {
        throw new Error(
            "OAuth login requires the deployed HTTPS version. Legacy SSO and password login still work locally.",
        );
    }

    const [{ createClient }, { OAuth2 }] = await Promise.all([
        import("matrix-js-sdk"),
        import("matrix-js-sdk/lib/oauth"),
    ]);
    const redirectUri = `${window.location.origin}/`;
    const client = createClient({ baseUrl, disableVoip: true });
    const metadata = assertSafeOAuthMetadata(await client.getAuthMetadata());
    const storageKey = `${OAUTH_CLIENT_PREFIX}${baseUrl}`;
    let clientId = localStorage.getItem(storageKey);

    if (!clientId) {
        clientId = await OAuth2.registerClient(metadata, {
            application_type: "web",
            client_name: "Sub-Etha",
            client_uri: `${window.location.origin}/`,
            logo_uri: `${window.location.origin}/icon-192.png`,
            redirect_uris: [redirectUri],
        });
        localStorage.setItem(storageKey, clientId);
    }

    const state = randomBase64Url(24);
    const deviceId = `SUBETHA_${randomBase64Url(9).toUpperCase()}`;
    const oauth = new OAuth2(metadata, { clientId, deviceId, redirectUri });
    const authorizationUrl = assertSafeOAuthNavigationUrl(
        await oauth.generateAuthorizationCodeGrantUrl(state, "fragment"),
    );
    const pending: PendingOAuth = {
        kind: "oauth",
        baseUrl,
        state,
        metadata,
        context: oauth.context,
    };

    sessionStorage.setItem(PENDING_AUTH_KEY, JSON.stringify(pending));
    window.location.assign(authorizationUrl);
}

function readCallbackParameters(): URLSearchParams {
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(
        window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "",
    );

    for (const [key, value] of fragment) {
        if (!query.has(key)) {
            query.set(key, value);
        }
    }

    return query;
}

export function sanitizedCallbackPath(pathname: string, hash: string): string {
    return `${pathname}${hash.startsWith("#/room/") ? hash : ""}`;
}

export async function completeRedirectLogin(): Promise<PersistedMatrixSession | null> {
    const params = readCallbackParameters();
    const loginToken = params.get("loginToken") ?? params.get("login_token");
    const code = params.get("code");

    if (!loginToken && !code && !params.get("error")) {
        return null;
    }

    const rawPending = sessionStorage.getItem(PENDING_AUTH_KEY);

    sessionStorage.removeItem(PENDING_AUTH_KEY);
    window.history.replaceState(
        {},
        "",
        sanitizedCallbackPath(window.location.pathname, window.location.hash),
    );

    if (!rawPending) {
        throw new Error(
            "The login return arrived without its departure paperwork. Please begin again.",
        );
    }

    const pending = JSON.parse(rawPending) as PendingAuth;

    if (
        !pending ||
        typeof pending !== "object" ||
        (pending.kind !== "sso" && pending.kind !== "oauth")
    ) {
        throw new Error("The login return had invalid departure paperwork. Please begin again.");
    }

    pending.baseUrl = assertAllowedHomeserverUrl(pending.baseUrl);

    if (pending.kind === "sso") {
        validateLegacySsoCallback(pending, params);

        if (params.get("error")) {
            throw new Error(
                params.get("error_description") ?? params.get("error") ?? "Login was cancelled.",
            );
        }

        if (!loginToken) {
            throw new Error("The homeserver returned an unexpected SSO response.");
        }

        const { createClient } = await import("matrix-js-sdk");
        const response = await createClient({
            baseUrl: pending.baseUrl,
            disableVoip: true,
        }).loginRequest({
            type: "m.login.token",
            token: loginToken,
            refresh_token: true,
            initial_device_display_name: "Sub-Etha PWA",
        });

        return sessionFromLogin(pending.baseUrl, response, "sso");
    }

    if (params.get("state") !== pending.state) {
        throw new Error("The OAuth state did not match; no credentials were accepted.");
    }

    if (params.get("error")) {
        throw new Error(
            params.get("error_description") ?? params.get("error") ?? "Login was cancelled.",
        );
    }

    if (code) {
        pending.metadata = assertSafeOAuthMetadata(pending.metadata);
        const [{ createClient }, { OAuth2 }] = await Promise.all([
            import("matrix-js-sdk"),
            import("matrix-js-sdk/lib/oauth"),
        ]);
        const oauth = new OAuth2(pending.metadata, pending.context);
        const tokens = await oauth.completeAuthorizationCodeGrant(code);
        const client = createClient({
            baseUrl: pending.baseUrl,
            accessToken: tokens.access_token,
            disableVoip: true,
        });
        const identity = await client.whoami();

        return createSession({
            baseUrl: pending.baseUrl,
            userId: identity.user_id,
            deviceId: identity.device_id ?? pending.context.deviceId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
            authKind: "oauth",
            oauth: {
                clientId: pending.context.clientId,
                deviceId: pending.context.deviceId,
                redirectUri: pending.context.redirectUri,
                metadata: pending.metadata,
            },
        });
    }

    throw new Error("The homeserver returned an unexpected login response.");
}
