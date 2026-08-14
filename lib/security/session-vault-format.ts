import type { ValidatedAuthMetadata } from "matrix-js-sdk/lib/oauth";
import type { AuthKind, PersistedMatrixSession } from "../matrix/types";
import { assertAllowedHomeserverUrl, isLoopbackHostname } from "../matrix/url-policy";

export const SESSION_DATABASE = "sub-etha-session";
export const SESSION_DATABASE_VERSION = 2;
export const SESSION_STORE = "private";
export const SESSION_KEY = "matrix-session";

export const VAULT_SCHEMA_VERSION = 1;
export const RECOVERY_ITERATIONS = 500_000;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_RECOVERY_INPUT_BYTES = 1024;
export const MAX_UNLOCK_SLOTS = 8;

const RECORD_ID_BYTES = 16;
const SLOT_ID_BYTES = 16;
const IV_BYTES = 12;
const SALT_BYTES = 32;
const WRAPPED_DEK_BYTES = 48;
const CRYPTO_DATABASE_PREFIX = /^sub-etha-crypto-[A-Za-z0-9_-]{1,160}$/;
const LEGACY_SYNC_DATABASE = /^matrix-js-sdk:sub-etha-sync-[A-Za-z0-9_-]{1,120}$/;
const AUTH_KINDS = new Set<AuthKind>(["password", "sso", "token", "oauth"]);
const AUTHENTICATOR_TRANSPORTS = new Set<AuthenticatorTransport>([
    "ble",
    "hybrid",
    "internal",
    "nfc",
    "usb",
]);

export type SessionVaultErrorCode =
    "authentication" | "conflict" | "corrupt" | "disposed" | "invalid-input" | "unavailable";

export class SessionVaultError extends Error {
    constructor(
        readonly code: SessionVaultErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "SessionVaultError";
    }
}

export interface AesGcmBox {
    algorithm: "AES-256-GCM";
    iv: string;
    ciphertext: string;
}

export interface RecoveryKeySlotV1 {
    kind: "recovery-key-pbkdf2";
    slotId: string;
    salt: string;
    iterations: typeof RECOVERY_ITERATIONS;
    wrappedDek: AesGcmBox;
}

export interface WebAuthnPrfSlotV1 {
    kind: "webauthn-prf";
    slotId: string;
    credentialId: string;
    transports: AuthenticatorTransport[];
    rpId: string;
    prfInput: string;
    hkdfSalt: string;
    wrappedDek: AesGcmBox;
}

export type UnlockSlotV1 = RecoveryKeySlotV1 | WebAuthnPrfSlotV1;

export interface VaultStorageMetadata {
    cryptoDatabasePrefix: string;
    legacySyncDatabase?: string;
}

export interface LockedMatrixSessionRecordV1 {
    kind: "locked-matrix-session";
    schemaVersion: typeof VAULT_SCHEMA_VERSION;
    recordId: string;
    revision: number;
    storage: VaultStorageMetadata;
    payload: AesGcmBox;
    unlockSlots: UnlockSlotV1[];
}

export interface MatrixSessionTombstoneV1 {
    kind: "matrix-session-tombstone";
    schemaVersion: typeof VAULT_SCHEMA_VERSION;
    recordId: string;
    revision: number;
    pendingCleanup?: { scope: "exact"; storage: VaultStorageMetadata } | { scope: "all-owned" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDenseArray(value: unknown[]): boolean {
    const keys = Object.keys(value);

    return keys.length === value.length && keys.every((key, index) => key === String(index));
}

function exactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): void {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);

    if (
        required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
        keys.some((key) => !allowed.has(key))
    ) {
        throw new SessionVaultError("corrupt", "A stored session-vault object has invalid fields.");
    }
}

function requiredString(value: unknown, field: string, maximumLength: number): string {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
        throw new SessionVaultError("corrupt", `The stored ${field} is invalid.`);
    }

    return value;
}

function optionalString(value: unknown, field: string, maximumLength: number): string | undefined {
    return value === undefined ? undefined : requiredString(value, field, maximumLength);
}

export function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeCanonicalBase64Url(
    value: unknown,
    field: string,
    options: { exactBytes?: number; minimumBytes?: number; maximumBytes: number },
): Uint8Array<ArrayBuffer> {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > Math.ceil((options.maximumBytes * 4) / 3) + 2 ||
        !/^[A-Za-z0-9_-]+$/.test(value) ||
        value.length % 4 === 1
    ) {
        throw new SessionVaultError("corrupt", `The stored ${field} is not canonical Base64URL.`);
    }

    const padded =
        value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    let binary: string;

    try {
        binary = atob(padded);
    } catch (error) {
        throw new SessionVaultError("corrupt", `The stored ${field} is not canonical Base64URL.`, {
            cause: error,
        });
    }

    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const minimum = options.exactBytes ?? options.minimumBytes ?? 0;
    const maximum = options.exactBytes ?? options.maximumBytes;

    if (
        bytes.byteLength < minimum ||
        bytes.byteLength > maximum ||
        encodeBase64Url(bytes) !== value
    ) {
        bytes.fill(0);

        throw new SessionVaultError("corrupt", `The stored ${field} is invalid.`);
    }

    return bytes;
}

function validateIdentifier(value: unknown, field: string, bytes: number): string {
    const decoded = decodeCanonicalBase64Url(value, field, {
        exactBytes: bytes,
        maximumBytes: bytes,
    });

    decoded.fill(0);

    return value as string;
}

function validateAesBox(
    value: unknown,
    field: string,
    ciphertextMaximum: number,
    ciphertextExact?: number,
): AesGcmBox {
    if (!isRecord(value)) {
        throw new SessionVaultError("corrupt", `The stored ${field} is malformed.`);
    }

    exactKeys(value, ["algorithm", "iv", "ciphertext"]);

    if (value.algorithm !== "AES-256-GCM") {
        throw new SessionVaultError("corrupt", `The stored ${field} algorithm is invalid.`);
    }

    const iv = decodeCanonicalBase64Url(value.iv, `${field} IV`, {
        exactBytes: IV_BYTES,
        maximumBytes: IV_BYTES,
    });
    const ciphertext = decodeCanonicalBase64Url(value.ciphertext, `${field} ciphertext`, {
        exactBytes: ciphertextExact,
        minimumBytes: ciphertextExact ?? 16,
        maximumBytes: ciphertextMaximum,
    });

    iv.fill(0);
    ciphertext.fill(0);

    return {
        algorithm: "AES-256-GCM",
        iv: value.iv as string,
        ciphertext: value.ciphertext as string,
    };
}

export function validateVaultStorageMetadata(value: unknown): VaultStorageMetadata {
    if (!isRecord(value)) {
        throw new SessionVaultError("corrupt", "The stored vault metadata is malformed.");
    }

    exactKeys(value, ["cryptoDatabasePrefix"], ["legacySyncDatabase"]);
    const cryptoDatabasePrefix = requiredString(
        value.cryptoDatabasePrefix,
        "Rust crypto database prefix",
        192,
    );

    if (!CRYPTO_DATABASE_PREFIX.test(cryptoDatabasePrefix)) {
        throw new SessionVaultError(
            "corrupt",
            "The stored Rust crypto database prefix is invalid.",
        );
    }

    const legacySyncDatabase = optionalString(
        value.legacySyncDatabase,
        "legacy sync database name",
        180,
    );

    if (legacySyncDatabase && !LEGACY_SYNC_DATABASE.test(legacySyncDatabase)) {
        throw new SessionVaultError("corrupt", "The stored legacy sync database name is invalid.");
    }

    return legacySyncDatabase
        ? { cryptoDatabasePrefix, legacySyncDatabase }
        : { cryptoDatabasePrefix };
}

function validateTransports(value: unknown): AuthenticatorTransport[] {
    if (
        !Array.isArray(value) ||
        !isDenseArray(value) ||
        value.length > AUTHENTICATOR_TRANSPORTS.size ||
        value.some(
            (entry) =>
                typeof entry !== "string" ||
                !AUTHENTICATOR_TRANSPORTS.has(entry as AuthenticatorTransport),
        ) ||
        new Set(value).size !== value.length
    ) {
        throw new SessionVaultError("corrupt", "The stored authenticator transports are invalid.");
    }

    return [...value] as AuthenticatorTransport[];
}

function validateRpId(value: unknown): string {
    const rpId = requiredString(value, "WebAuthn RP ID", 253);

    if (
        rpId !== rpId.toLowerCase() ||
        rpId.startsWith(".") ||
        rpId.endsWith(".") ||
        !/^[a-z0-9.-]+$/.test(rpId)
    ) {
        throw new SessionVaultError("corrupt", "The stored WebAuthn RP ID is invalid.");
    }

    return rpId;
}

function validateUnlockSlot(value: unknown): UnlockSlotV1 {
    if (!isRecord(value)) {
        throw new SessionVaultError("corrupt", "A stored unlock slot is malformed.");
    }

    if (value.kind === "recovery-key-pbkdf2") {
        exactKeys(value, ["kind", "slotId", "salt", "iterations", "wrappedDek"]);

        if (value.iterations !== RECOVERY_ITERATIONS) {
            throw new SessionVaultError("corrupt", "The recovery-key work factor is invalid.");
        }

        const salt = decodeCanonicalBase64Url(value.salt, "recovery-key salt", {
            exactBytes: SALT_BYTES,
            maximumBytes: SALT_BYTES,
        });

        salt.fill(0);

        return {
            kind: "recovery-key-pbkdf2",
            slotId: validateIdentifier(value.slotId, "recovery slot ID", SLOT_ID_BYTES),
            salt: value.salt as string,
            iterations: RECOVERY_ITERATIONS,
            wrappedDek: validateAesBox(
                value.wrappedDek,
                "wrapped payload key",
                WRAPPED_DEK_BYTES,
                WRAPPED_DEK_BYTES,
            ),
        };
    }

    if (value.kind === "webauthn-prf") {
        exactKeys(value, [
            "kind",
            "slotId",
            "credentialId",
            "transports",
            "rpId",
            "prfInput",
            "hkdfSalt",
            "wrappedDek",
        ]);
        const credentialId = decodeCanonicalBase64Url(value.credentialId, "credential ID", {
            minimumBytes: 1,
            maximumBytes: 1024,
        });
        const prfInput = decodeCanonicalBase64Url(value.prfInput, "WebAuthn PRF input", {
            exactBytes: SALT_BYTES,
            maximumBytes: SALT_BYTES,
        });
        const hkdfSalt = decodeCanonicalBase64Url(value.hkdfSalt, "WebAuthn HKDF salt", {
            exactBytes: SALT_BYTES,
            maximumBytes: SALT_BYTES,
        });

        credentialId.fill(0);
        prfInput.fill(0);
        hkdfSalt.fill(0);

        return {
            kind: "webauthn-prf",
            slotId: validateIdentifier(value.slotId, "WebAuthn slot ID", SLOT_ID_BYTES),
            credentialId: value.credentialId as string,
            transports: validateTransports(value.transports),
            rpId: validateRpId(value.rpId),
            prfInput: value.prfInput as string,
            hkdfSalt: value.hkdfSalt as string,
            wrappedDek: validateAesBox(
                value.wrappedDek,
                "wrapped payload key",
                WRAPPED_DEK_BYTES,
                WRAPPED_DEK_BYTES,
            ),
        };
    }

    throw new SessionVaultError("corrupt", "The stored unlock-slot kind is invalid.");
}

export function validateLockedRecord(value: unknown): LockedMatrixSessionRecordV1 {
    if (!isRecord(value)) {
        throw new SessionVaultError("corrupt", "The stored Matrix session vault is malformed.");
    }

    exactKeys(value, [
        "kind",
        "schemaVersion",
        "recordId",
        "revision",
        "storage",
        "payload",
        "unlockSlots",
    ]);

    if (value.kind !== "locked-matrix-session" || value.schemaVersion !== VAULT_SCHEMA_VERSION) {
        throw new SessionVaultError(
            "corrupt",
            "The stored Matrix session vault version is invalid.",
        );
    }

    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
        throw new SessionVaultError("corrupt", "The stored Matrix session revision is invalid.");
    }

    if (
        !Array.isArray(value.unlockSlots) ||
        !isDenseArray(value.unlockSlots) ||
        value.unlockSlots.length < 1 ||
        value.unlockSlots.length > MAX_UNLOCK_SLOTS
    ) {
        throw new SessionVaultError("corrupt", "The stored unlock-slot list is invalid.");
    }

    const unlockSlots = value.unlockSlots.map(validateUnlockSlot);
    const slotIds = unlockSlots.map((slot) => slot.slotId);

    if (
        new Set(slotIds).size !== slotIds.length ||
        unlockSlots.filter((slot) => slot.kind === "recovery-key-pbkdf2").length !== 1
    ) {
        throw new SessionVaultError("corrupt", "The stored unlock-slot set is invalid.");
    }

    return {
        kind: "locked-matrix-session",
        schemaVersion: VAULT_SCHEMA_VERSION,
        recordId: validateIdentifier(value.recordId, "record ID", RECORD_ID_BYTES),
        revision: Number(value.revision),
        storage: validateVaultStorageMetadata(value.storage),
        payload: validateAesBox(value.payload, "encrypted session payload", MAX_PAYLOAD_BYTES + 16),
        unlockSlots,
    };
}

export function validateTombstone(value: unknown): MatrixSessionTombstoneV1 {
    if (!isRecord(value)) {
        throw new SessionVaultError("corrupt", "The stored session tombstone is malformed.");
    }

    exactKeys(value, ["kind", "schemaVersion", "recordId", "revision"], ["pendingCleanup"]);

    if (
        value.kind !== "matrix-session-tombstone" ||
        value.schemaVersion !== VAULT_SCHEMA_VERSION ||
        !Number.isSafeInteger(value.revision) ||
        Number(value.revision) < 1
    ) {
        throw new SessionVaultError("corrupt", "The stored session tombstone is invalid.");
    }

    let pendingCleanup: MatrixSessionTombstoneV1["pendingCleanup"];

    if (value.pendingCleanup !== undefined) {
        if (!isRecord(value.pendingCleanup)) {
            throw new SessionVaultError("corrupt", "The stored cleanup scope is malformed.");
        }

        if (value.pendingCleanup.scope === "all-owned") {
            exactKeys(value.pendingCleanup, ["scope"]);
            pendingCleanup = { scope: "all-owned" };
        } else if (value.pendingCleanup.scope === "exact") {
            exactKeys(value.pendingCleanup, ["scope", "storage"]);
            pendingCleanup = {
                scope: "exact",
                storage: validateVaultStorageMetadata(value.pendingCleanup.storage),
            };
        } else {
            throw new SessionVaultError("corrupt", "The stored cleanup scope is invalid.");
        }
    }

    return {
        kind: "matrix-session-tombstone",
        schemaVersion: VAULT_SCHEMA_VERSION,
        recordId: validateIdentifier(value.recordId, "tombstone record ID", RECORD_ID_BYTES),
        revision: Number(value.revision),
        pendingCleanup,
    };
}

function safeHttpsUrl(value: unknown, field: string): string {
    const candidate = requiredString(value, field, 4096);
    let url: URL;

    try {
        url = new URL(candidate);
    } catch (error) {
        throw new SessionVaultError("corrupt", `The stored ${field} is invalid.`, { cause: error });
    }

    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new SessionVaultError("corrupt", `The stored ${field} is unsafe.`);
    }

    return candidate;
}

function stringArray(value: unknown, field: string): string[] {
    if (
        !Array.isArray(value) ||
        !isDenseArray(value) ||
        value.length > 64 ||
        value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 256)
    ) {
        throw new SessionVaultError("corrupt", `The stored ${field} is invalid.`);
    }

    return [...value] as string[];
}

function normalizeOAuth(value: unknown): PersistedMatrixSession["oauth"] {
    if (!isRecord(value)) {
        throw new SessionVaultError("corrupt", "The stored OAuth context is invalid.");
    }

    exactKeys(value, ["clientId", "deviceId", "redirectUri", "metadata"]);

    if (!isRecord(value.metadata)) {
        throw new SessionVaultError("corrupt", "The stored OAuth metadata is invalid.");
    }

    const metadata: Record<string, unknown> = {};

    for (const key of [
        "authorization_endpoint",
        "issuer",
        "registration_endpoint",
        "revocation_endpoint",
        "token_endpoint",
    ] as const) {
        metadata[key] = safeHttpsUrl(value.metadata[key], `OAuth ${key}`);
    }

    if (new URL(metadata.issuer as string).search) {
        throw new SessionVaultError("corrupt", "The stored OAuth issuer is unsafe.");
    }

    for (const key of ["account_management_uri", "device_authorization_endpoint"] as const) {
        if (value.metadata[key] !== undefined) {
            metadata[key] = safeHttpsUrl(value.metadata[key], `OAuth ${key}`);
        }
    }

    for (const key of [
        "code_challenge_methods_supported",
        "grant_types_supported",
        "response_modes_supported",
        "response_types_supported",
    ] as const) {
        metadata[key] = stringArray(value.metadata[key], `OAuth ${key}`);
    }

    for (const key of [
        "account_management_actions_supported",
        "prompt_values_supported",
    ] as const) {
        if (value.metadata[key] !== undefined) {
            metadata[key] = stringArray(value.metadata[key], `OAuth ${key}`);
        }
    }

    if (
        !(metadata.code_challenge_methods_supported as string[]).includes("S256") ||
        !(metadata.grant_types_supported as string[]).includes("authorization_code") ||
        !(metadata.grant_types_supported as string[]).includes("refresh_token") ||
        !(metadata.response_modes_supported as string[]).includes("query") ||
        !(metadata.response_modes_supported as string[]).includes("fragment") ||
        !(metadata.response_types_supported as string[]).includes("code")
    ) {
        throw new SessionVaultError("corrupt", "The stored OAuth metadata is incomplete.");
    }

    const redirectUri = requiredString(value.redirectUri, "OAuth redirect URI", 4096);
    let redirect: URL;

    try {
        redirect = new URL(redirectUri);
    } catch (error) {
        throw new SessionVaultError("corrupt", "The stored OAuth redirect URI is invalid.", {
            cause: error,
        });
    }

    if (
        !["https:", "http:"].includes(redirect.protocol) ||
        (redirect.protocol === "http:" && !isLoopbackHostname(redirect.hostname)) ||
        redirect.username ||
        redirect.password ||
        redirect.hash
    ) {
        throw new SessionVaultError("corrupt", "The stored OAuth redirect URI is unsafe.");
    }

    return {
        clientId: requiredString(value.clientId, "OAuth client ID", 4096),
        deviceId: requiredString(value.deviceId, "OAuth device ID", 1024),
        redirectUri,
        metadata: metadata as unknown as ValidatedAuthMetadata,
    };
}

export function normalizePersistedSession(
    value: unknown,
    options: { requireCryptoDatabasePrefix: boolean; derivedCryptoDatabasePrefix?: string },
): PersistedMatrixSession {
    if (!isRecord(value)) {
        throw new SessionVaultError("corrupt", "The stored Matrix session is invalid.");
    }

    exactKeys(
        value,
        ["baseUrl", "userId", "deviceId", "accessToken", "authKind", "cryptoStorageKey"],
        ["refreshToken", "expiresAt", "oauth", "cryptoDatabasePrefix"],
    );

    const authKind = value.authKind;

    if (typeof authKind !== "string" || !AUTH_KINDS.has(authKind as AuthKind)) {
        throw new SessionVaultError("corrupt", "The stored authentication kind is invalid.");
    }

    const cryptoStorageKey = requiredString(value.cryptoStorageKey, "Rust crypto storage key", 128);
    const cryptoKeyBytes = decodeCanonicalBase64Url(cryptoStorageKey, "Rust crypto storage key", {
        exactBytes: 32,
        maximumBytes: 32,
    });

    cryptoKeyBytes.fill(0);

    let cryptoDatabasePrefix = options.derivedCryptoDatabasePrefix;

    if (value.cryptoDatabasePrefix !== undefined) {
        const storedPrefix = requiredString(
            value.cryptoDatabasePrefix,
            "Rust crypto database prefix",
            192,
        );

        if (!CRYPTO_DATABASE_PREFIX.test(storedPrefix)) {
            throw new SessionVaultError(
                "corrupt",
                "The stored Rust crypto database prefix is invalid.",
            );
        }

        if (cryptoDatabasePrefix && storedPrefix !== cryptoDatabasePrefix) {
            throw new SessionVaultError(
                "corrupt",
                "The stored Rust crypto database identity changed.",
            );
        }

        cryptoDatabasePrefix = storedPrefix;
    }

    if (options.requireCryptoDatabasePrefix && !cryptoDatabasePrefix) {
        throw new SessionVaultError(
            "corrupt",
            "The stored Rust crypto database prefix is missing.",
        );
    }

    if (!cryptoDatabasePrefix || !CRYPTO_DATABASE_PREFIX.test(cryptoDatabasePrefix)) {
        throw new SessionVaultError("corrupt", "The Rust crypto database prefix is invalid.");
    }

    const expiresAt = value.expiresAt;

    if (
        expiresAt !== undefined &&
        (!Number.isFinite(expiresAt) || Number(expiresAt) <= 0 || !Number.isSafeInteger(expiresAt))
    ) {
        throw new SessionVaultError("corrupt", "The stored token expiry is invalid.");
    }

    const oauth = value.oauth === undefined ? undefined : normalizeOAuth(value.oauth);

    if ((authKind === "oauth") !== Boolean(oauth)) {
        throw new SessionVaultError("corrupt", "The stored OAuth session context is inconsistent.");
    }

    let baseUrl: string;

    try {
        baseUrl = assertAllowedHomeserverUrl(requiredString(value.baseUrl, "homeserver URL", 4096));
    } catch (error) {
        throw new SessionVaultError("corrupt", "The stored homeserver URL is unsafe.", {
            cause: error,
        });
    }

    return {
        baseUrl,
        userId: requiredString(value.userId, "Matrix user ID", 1024),
        deviceId: requiredString(value.deviceId, "Matrix device ID", 1024),
        accessToken: requiredString(value.accessToken, "access token", 16 * 1024),
        refreshToken: optionalString(value.refreshToken, "refresh token", 16 * 1024),
        expiresAt: expiresAt === undefined ? undefined : Number(expiresAt),
        authKind: authKind as AuthKind,
        cryptoStorageKey,
        cryptoDatabasePrefix,
        oauth,
    };
}

export function stableStoreName(session: { userId: string; deviceId: string }): string {
    return `${session.userId}-${session.deviceId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

export function legacyStorageMetadata(session: {
    userId: string;
    deviceId: string;
}): Required<VaultStorageMetadata> {
    const stableName = stableStoreName(session);

    return {
        cryptoDatabasePrefix: `sub-etha-crypto-${stableName}`,
        legacySyncDatabase: `matrix-js-sdk:sub-etha-sync-${stableName}`,
    };
}

function canonicalBox(box: AesGcmBox): readonly string[] {
    return [box.algorithm, box.iv, box.ciphertext];
}

export function canonicalSlotMetadata(slot: UnlockSlotV1): readonly unknown[] {
    if (slot.kind === "recovery-key-pbkdf2") {
        return [slot.kind, slot.slotId, slot.salt, slot.iterations, canonicalBox(slot.wrappedDek)];
    }

    return [
        slot.kind,
        slot.slotId,
        slot.credentialId,
        slot.transports,
        slot.rpId,
        slot.prfInput,
        slot.hkdfSalt,
        canonicalBox(slot.wrappedDek),
    ];
}

function canonicalJson(value: unknown): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify(value));
}

export function slotAdditionalData(
    recordId: string,
    slot: Omit<RecoveryKeySlotV1, "wrappedDek"> | Omit<WebAuthnPrfSlotV1, "wrappedDek">,
): Uint8Array<ArrayBuffer> {
    const metadata =
        slot.kind === "recovery-key-pbkdf2"
            ? [slot.kind, slot.slotId, slot.salt, slot.iterations]
            : [
                  slot.kind,
                  slot.slotId,
                  slot.credentialId,
                  slot.transports,
                  slot.rpId,
                  slot.prfInput,
                  slot.hkdfSalt,
              ];

    return canonicalJson([
        "sub-etha/session-vault/slot/v1",
        VAULT_SCHEMA_VERSION,
        recordId,
        metadata,
    ]);
}

export function payloadAdditionalData(
    recordId: string,
    revision: number,
    storage: VaultStorageMetadata,
    slots: UnlockSlotV1[],
): Uint8Array<ArrayBuffer> {
    return canonicalJson([
        "sub-etha/session-vault/payload/v1",
        VAULT_SCHEMA_VERSION,
        recordId,
        revision,
        [storage.cryptoDatabasePrefix, storage.legacySyncDatabase ?? null],
        slots.map(canonicalSlotMetadata),
    ]);
}

export function webAuthnHkdfInfo(recordId: string, slotId: string): Uint8Array<ArrayBuffer> {
    return canonicalJson([
        "sub-etha/session-vault/webauthn-prf-kek/v1",
        VAULT_SCHEMA_VERSION,
        recordId,
        slotId,
    ]);
}

export function exactStoredValueEqual(first: unknown, second: unknown): boolean {
    if (Object.is(first, second)) {
        return true;
    }

    if (first instanceof ArrayBuffer && second instanceof ArrayBuffer) {
        const left = new Uint8Array(first);
        const right = new Uint8Array(second);

        return (
            left.byteLength === right.byteLength &&
            left.every((byte, index) => byte === right[index])
        );
    }

    if (Array.isArray(first) && Array.isArray(second)) {
        return (
            isDenseArray(first) &&
            isDenseArray(second) &&
            first.length === second.length &&
            first.every((entry, index) => exactStoredValueEqual(entry, second[index]))
        );
    }

    if (isRecord(first) && isRecord(second)) {
        const firstKeys = Object.keys(first).sort();
        const secondKeys = Object.keys(second).sort();

        return (
            firstKeys.length === secondKeys.length &&
            firstKeys.every(
                (key, index) =>
                    key === secondKeys[index] && exactStoredValueEqual(first[key], second[key]),
            )
        );
    }

    return false;
}

export function immutableSessionFieldsEqual(
    first: PersistedMatrixSession,
    second: PersistedMatrixSession,
): boolean {
    return (
        first.baseUrl === second.baseUrl &&
        first.userId === second.userId &&
        first.deviceId === second.deviceId &&
        first.authKind === second.authKind &&
        first.cryptoStorageKey === second.cryptoStorageKey &&
        first.cryptoDatabasePrefix === second.cryptoDatabasePrefix &&
        exactStoredValueEqual(first.oauth, second.oauth)
    );
}

export function deepFreezeSession(
    session: PersistedMatrixSession,
): Readonly<PersistedMatrixSession> {
    const clone = structuredClone(session);

    const freeze = (value: unknown): void => {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) {
            return;
        }

        for (const child of Object.values(value)) {
            freeze(child);
        }

        Object.freeze(value);
    };

    freeze(clone);

    return clone;
}
