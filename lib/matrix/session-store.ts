import {
    decryptJson,
    encryptJson,
    getDeviceKeys,
    LEGACY_SESSION_STORE,
    openSessionDatabase,
    readStoredValue,
    SESSION_DATABASE,
    SESSION_STORE,
    StoredSessionError,
    transactionDone,
    type DeviceKeys,
} from "./private-storage";
import { migrateLegacyDrafts } from "./encrypted-store";
import { migrateLegacyPushConfiguration } from "./push-store";
import type { AuthKind, LocalStoreId, PersistedMatrixSession, StorageMode } from "./types";
import { assertAllowedHomeserverUrl } from "./url-policy";

const LEGACY_SESSION_KEY = "matrix-session";
const SESSION_KEY = "matrix-session-v2";
const SESSION_LIMIT_BYTES = 64 * 1024;
const LOCAL_STORE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const AUTH_KINDS = new Set<AuthKind>(["password", "sso", "token", "oauth"]);
const OAUTH_URL_FIELDS = [
    "account_management_uri",
    "authorization_endpoint",
    "device_authorization_endpoint",
    "issuer",
    "registration_endpoint",
    "revocation_endpoint",
    "token_endpoint",
] as const;

export { StoredSessionError };
export type { StoredSessionErrorCode } from "./private-storage";

function sessionContext() {
    return {
        database: SESSION_DATABASE,
        store: SESSION_STORE,
        recordType: "remembered-matrix-session",
        recordKey: SESSION_KEY,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
    value: unknown,
    name: string,
    maximumLength: number,
): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
        throw new StoredSessionError("invalid-data", "The stored " + name + " is invalid.");
    }
}

function validateOAuthMetadata(value: unknown): void {
    if (!isRecord(value)) {
        throw new StoredSessionError("invalid-data", "The stored OAuth metadata is invalid.");
    }

    for (const field of OAUTH_URL_FIELDS) {
        const candidate = value[field];

        if (candidate === undefined) {
            continue;
        }

        requiredString(candidate, "OAuth " + field, 4096);

        let url: URL;

        try {
            url = new URL(candidate);
        } catch (error) {
            throw new StoredSessionError("invalid-data", "A stored OAuth URL is invalid.", {
                cause: error,
            });
        }

        if (url.protocol !== "https:" || url.username || url.password || url.hash) {
            throw new StoredSessionError("invalid-data", "A stored OAuth URL is unsafe.");
        }
    }
}

function asLocalStoreId(value: unknown): LocalStoreId {
    if (typeof value !== "string" || !LOCAL_STORE_ID_PATTERN.test(value)) {
        throw new StoredSessionError(
            "invalid-data",
            "The local account-store identifier is invalid.",
        );
    }

    return value as LocalStoreId;
}

export function validateStoredSession(value: unknown): PersistedMatrixSession {
    if (!isRecord(value)) {
        throw new StoredSessionError("invalid-data", "The stored Matrix session is invalid.");
    }

    requiredString(value.baseUrl, "homeserver URL", 4096);
    requiredString(value.userId, "Matrix user ID", 1024);
    requiredString(value.deviceId, "Matrix device ID", 1024);
    requiredString(value.accessToken, "access token", 16 * 1024);
    requiredString(value.cryptoStorageKey, "crypto storage key", 256);

    if (value.refreshToken !== undefined) {
        requiredString(value.refreshToken, "refresh token", 16 * 1024);
    }

    if (!AUTH_KINDS.has(value.authKind as AuthKind)) {
        throw new StoredSessionError("invalid-data", "The stored authentication kind is invalid.");
    }

    if (value.storageMode !== "remembered") {
        throw new StoredSessionError(
            "invalid-data",
            "A persisted Matrix session must use remembered storage.",
        );
    }

    if (
        typeof value.cryptoDatabasePrefix !== "string" ||
        !/^sub-etha-crypto-[A-Za-z0-9_-]{1,160}$/.test(value.cryptoDatabasePrefix)
    ) {
        throw new StoredSessionError("invalid-data", "The crypto database prefix is invalid.");
    }

    if (
        value.expiresAt !== undefined &&
        (!Number.isFinite(value.expiresAt) || Number(value.expiresAt) <= 0)
    ) {
        throw new StoredSessionError("invalid-data", "The stored token expiry is invalid.");
    }

    if (base64UrlToBytes(value.cryptoStorageKey).byteLength !== 32) {
        throw new StoredSessionError(
            "invalid-data",
            "The Rust crypto storage key must be exactly 32 bytes.",
        );
    }

    value.baseUrl = assertAllowedHomeserverUrl(value.baseUrl);
    value.localStoreId = asLocalStoreId(value.localStoreId);

    if (value.oauth !== undefined) {
        if (!isRecord(value.oauth)) {
            throw new StoredSessionError("invalid-data", "The stored OAuth context is invalid.");
        }

        requiredString(value.oauth.clientId, "OAuth client ID", 4096);
        requiredString(value.oauth.deviceId, "OAuth device ID", 1024);
        requiredString(value.oauth.redirectUri, "OAuth redirect URI", 4096);
        validateOAuthMetadata(value.oauth.metadata);

        const redirect = new URL(value.oauth.redirectUri);

        if (
            !["https:", "http:"].includes(redirect.protocol) ||
            redirect.username ||
            redirect.password
        ) {
            throw new StoredSessionError(
                "invalid-data",
                "The stored OAuth redirect URI is unsafe.",
            );
        }
    } else if (value.authKind === "oauth") {
        throw new StoredSessionError("invalid-data", "The OAuth session is missing its context.");
    }

    return value as unknown as PersistedMatrixSession;
}

function stableLegacyName(session: { userId: string; deviceId: string }): string {
    return (session.userId + "-" + session.deviceId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function deleteLegacySyncDatabase(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);

        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(
                new StoredSessionError(
                    "unavailable-storage",
                    "The legacy plaintext sync cache could not be removed.",
                    { cause: request.error },
                ),
            );
        request.onblocked = () =>
            reject(
                new StoredSessionError(
                    "unavailable-storage",
                    "Another tab is blocking removal of the legacy plaintext sync cache.",
                ),
            );
    });
}

async function migrateLegacySession(value: unknown): Promise<PersistedMatrixSession> {
    if (!isRecord(value)) {
        throw new StoredSessionError("invalid-data", "The legacy Matrix session is invalid.");
    }

    const localStoreId = randomBase64Url(16) as LocalStoreId;
    const legacyName =
        typeof value.userId === "string" && typeof value.deviceId === "string"
            ? stableLegacyName({ userId: value.userId, deviceId: value.deviceId })
            : "";
    const migrated = validateStoredSession({
        ...value,
        storageMode: "remembered",
        localStoreId,
        cryptoDatabasePrefix: "sub-etha-crypto-" + legacyName,
    });
    const keys = await getDeviceKeys();
    const envelope = await encryptJson(
        keys.aesKey,
        migrated,
        sessionContext(),
        SESSION_LIMIT_BYTES,
    );

    await migrateLegacyDrafts(localStoreId, keys);
    await migrateLegacyPushConfiguration();
    await deleteLegacySyncDatabase("sub-etha-sync-" + legacyName);

    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(
            [LEGACY_SESSION_STORE, SESSION_STORE],
            "readwrite",
        );

        transaction.objectStore(SESSION_STORE).put(envelope, SESSION_KEY);
        transaction.objectStore(LEGACY_SESSION_STORE).delete(LEGACY_SESSION_KEY);
        await transactionDone(transaction);
    } finally {
        database.close();
    }

    return migrated;
}

export async function readSession(): Promise<PersistedMatrixSession | null> {
    const encrypted = await readStoredValue<unknown>(SESSION_STORE, SESSION_KEY);

    if (encrypted) {
        const { aesKey } = await getDeviceKeys();
        const value = await decryptJson<unknown>(
            aesKey,
            encrypted,
            sessionContext(),
            SESSION_LIMIT_BYTES,
        );

        return validateStoredSession(value);
    }

    const legacy = await readStoredValue<unknown>(LEGACY_SESSION_STORE, LEGACY_SESSION_KEY);

    return legacy ? migrateLegacySession(legacy) : null;
}

export async function saveSession(session: PersistedMatrixSession): Promise<void> {
    if (session.storageMode === "private") {
        return;
    }

    const value = validateStoredSession(session);
    const { aesKey } = await getDeviceKeys();
    const envelope = await encryptJson(aesKey, value, sessionContext(), SESSION_LIMIT_BYTES);
    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(
            [SESSION_STORE, LEGACY_SESSION_STORE],
            "readwrite",
        );

        transaction.objectStore(SESSION_STORE).put(envelope, SESSION_KEY);
        transaction.objectStore(LEGACY_SESSION_STORE).delete(LEGACY_SESSION_KEY);
        await transactionDone(transaction);
    } finally {
        database.close();
    }
}

export async function clearSession(): Promise<void> {
    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(
            [SESSION_STORE, LEGACY_SESSION_STORE],
            "readwrite",
        );

        transaction.objectStore(SESSION_STORE).delete(SESSION_KEY);
        transaction.objectStore(LEGACY_SESSION_STORE).delete(LEGACY_SESSION_KEY);
        await transactionDone(transaction);
    } finally {
        database.close();
    }
}

export function randomBase64Url(byteLength = 32): string {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new StoredSessionError("invalid-data", "The stored Base64URL value is invalid.");
    }

    const padded =
        value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);

    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

type NewSessionInput = Omit<
    PersistedMatrixSession,
    "cryptoStorageKey" | "storageMode" | "localStoreId" | "cryptoDatabasePrefix"
>;

export function createSession(
    input: NewSessionInput,
    storageMode: StorageMode = "remembered",
): PersistedMatrixSession {
    const localStoreId = randomBase64Url(16) as LocalStoreId;

    return {
        ...input,
        cryptoStorageKey: randomBase64Url(32),
        storageMode,
        localStoreId,
        cryptoDatabasePrefix: "sub-etha-crypto-" + localStoreId,
    };
}

export async function getSessionDeviceKeys(): Promise<DeviceKeys> {
    return getDeviceKeys();
}
