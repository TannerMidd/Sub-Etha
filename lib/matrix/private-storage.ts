import type { EncryptedEnvelopeV1 } from "./types";

export const SESSION_DATABASE = "sub-etha-session";
export const SESSION_DATABASE_VERSION = 2;
export const LEGACY_SESSION_STORE = "private";
export const DEVICE_KEY_STORE = "keys";
export const SESSION_STORE = "sessions";
export const CLEANUP_STORE = "cleanup";
export const DEVICE_AES_KEY = "device-aead-v1";
export const DEVICE_HMAC_KEY = "device-hmac-v1";

const APPLICATION = "sub-etha";

export type StoredSessionErrorCode =
    "unavailable-storage" | "invalid-data" | "missing-key" | "authentication-failed";

export class StoredSessionError extends Error {
    constructor(
        public readonly code: StoredSessionErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "StoredSessionError";
    }
}

export interface DeviceKeys {
    aesKey: CryptoKey;
    hmacKey: CryptoKey;
}

export interface EncryptionContext {
    database: string;
    store: string;
    recordType: string;
    recordKey: string;
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
            reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
        transaction.onerror = () =>
            reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });
}

export function openSessionDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(
                new StoredSessionError(
                    "unavailable-storage",
                    "Private browser storage is unavailable.",
                ),
            );

            return;
        }

        const request = indexedDB.open(SESSION_DATABASE, SESSION_DATABASE_VERSION);

        request.onupgradeneeded = () => {
            const database = request.result;

            for (const store of [
                LEGACY_SESSION_STORE,
                DEVICE_KEY_STORE,
                SESSION_STORE,
                CLEANUP_STORE,
            ]) {
                if (!database.objectStoreNames.contains(store)) {
                    database.createObjectStore(store);
                }
            }
        };

        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };

        request.onerror = () =>
            reject(
                new StoredSessionError(
                    "unavailable-storage",
                    "Private browser storage could not be opened.",
                    { cause: request.error },
                ),
            );
        request.onblocked = () =>
            reject(
                new StoredSessionError(
                    "unavailable-storage",
                    "Another tab is blocking the private-storage upgrade.",
                ),
            );
    });
}

export async function readStoredValue<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(storeName, "readonly");
        const result = await requestValue(transaction.objectStore(storeName).get(key));

        await transactionDone(transaction);

        return (result as T | undefined) ?? null;
    } finally {
        database.close();
    }
}

export async function writeStoredValue<T>(
    storeName: string,
    key: IDBValidKey,
    value: T,
): Promise<void> {
    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(storeName, "readwrite");

        transaction.objectStore(storeName).put(value, key);
        await transactionDone(transaction);
    } finally {
        database.close();
    }
}

export async function deleteStoredValue(storeName: string, key: IDBValidKey): Promise<void> {
    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(storeName, "readwrite");

        transaction.objectStore(storeName).delete(key);
        await transactionDone(transaction);
    } finally {
        database.close();
    }
}

function isCryptoKey(value: unknown, algorithm: "AES-GCM" | "HMAC"): value is CryptoKey {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as CryptoKey;

    return (
        candidate.extractable === false &&
        candidate.algorithm?.name === algorithm &&
        Array.isArray(candidate.usages)
    );
}

async function readDeviceKeys(): Promise<DeviceKeys | null> {
    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(DEVICE_KEY_STORE, "readonly");
        const store = transaction.objectStore(DEVICE_KEY_STORE);
        const [aesKey, hmacKey] = await Promise.all([
            requestValue(store.get(DEVICE_AES_KEY)),
            requestValue(store.get(DEVICE_HMAC_KEY)),
        ]);

        await transactionDone(transaction);

        if (aesKey === undefined && hmacKey === undefined) {
            return null;
        }

        if (!isCryptoKey(aesKey, "AES-GCM") || !isCryptoKey(hmacKey, "HMAC")) {
            throw new StoredSessionError(
                "missing-key",
                "The device encryption keys are incomplete or invalid.",
            );
        }

        return { aesKey, hmacKey };
    } finally {
        database.close();
    }
}

export async function getDeviceKeys(): Promise<DeviceKeys> {
    const existing = await readDeviceKeys();

    if (existing) {
        return existing;
    }

    const [aesKey, hmacKey] = await Promise.all([
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, [
            "sign",
            "verify",
        ]),
    ]);
    const database = await openSessionDatabase();

    try {
        const transaction = database.transaction(DEVICE_KEY_STORE, "readwrite");
        const store = transaction.objectStore(DEVICE_KEY_STORE);

        store.add(aesKey, DEVICE_AES_KEY);
        store.add(hmacKey, DEVICE_HMAC_KEY);
        await transactionDone(transaction);

        return { aesKey, hmacKey };
    } catch (error) {
        const winner = await readDeviceKeys().catch(() => null);

        if (winner) {
            return winner;
        }

        throw new StoredSessionError(
            "unavailable-storage",
            "The device encryption keys could not be saved.",
            { cause: error },
        );
    } finally {
        database.close();
    }
}

export async function readDeviceAesKey(): Promise<CryptoKey> {
    const value = await readStoredValue<unknown>(DEVICE_KEY_STORE, DEVICE_AES_KEY);

    if (!isCryptoKey(value, "AES-GCM")) {
        throw new StoredSessionError("missing-key", "The device encryption key is unavailable.");
    }

    return value;
}

function additionalData(context: EncryptionContext): ArrayBuffer {
    return toArrayBuffer(
        new TextEncoder().encode(
            [
                APPLICATION,
                "envelope-v1",
                context.database,
                context.store,
                context.recordType,
                context.recordKey,
            ].join("\u001f"),
        ),
    );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function isEncryptedEnvelopeV1(value: unknown): value is EncryptedEnvelopeV1 {
    if (!value || typeof value !== "object") {
        return false;
    }

    const envelope = value as Partial<EncryptedEnvelopeV1>;

    return (
        envelope.version === 1 &&
        envelope.algorithm === "AES-256-GCM" &&
        envelope.iv instanceof ArrayBuffer &&
        envelope.iv.byteLength === 12 &&
        envelope.ciphertext instanceof ArrayBuffer
    );
}

export async function encryptJson(
    aesKey: CryptoKey,
    value: unknown,
    context: EncryptionContext,
    maximumPlaintextBytes: number,
): Promise<EncryptedEnvelopeV1> {
    const plaintext = new TextEncoder().encode(JSON.stringify(value));

    if (plaintext.byteLength > maximumPlaintextBytes) {
        throw new RangeError(
            "The " +
                context.recordType +
                " record exceeds its " +
                maximumPlaintextBytes +
                "-byte limit.",
        );
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(context), tagLength: 128 },
        aesKey,
        plaintext,
    );

    return {
        version: 1,
        algorithm: "AES-256-GCM",
        iv: toArrayBuffer(iv),
        ciphertext,
    };
}

export async function decryptJson<T>(
    aesKey: CryptoKey,
    envelope: unknown,
    context: EncryptionContext,
    maximumPlaintextBytes: number,
): Promise<T> {
    if (!isEncryptedEnvelopeV1(envelope)) {
        throw new StoredSessionError("invalid-data", "The encrypted record is malformed.");
    }

    if (envelope.ciphertext.byteLength > maximumPlaintextBytes + 16) {
        throw new StoredSessionError("invalid-data", "The encrypted record exceeds its limit.");
    }

    try {
        const plaintext = await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: envelope.iv,
                additionalData: additionalData(context),
                tagLength: 128,
            },
            aesKey,
            envelope.ciphertext,
        );

        if (plaintext.byteLength > maximumPlaintextBytes) {
            throw new StoredSessionError("invalid-data", "The decrypted record exceeds its limit.");
        }

        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as T;
    } catch (error) {
        if (error instanceof StoredSessionError) {
            throw error;
        }

        throw new StoredSessionError(
            "authentication-failed",
            "The encrypted record could not be authenticated.",
            { cause: error },
        );
    }
}

export async function opaqueRecordKey(hmacKey: CryptoKey, logicalId: string): Promise<string> {
    const signature = await crypto.subtle.sign(
        "HMAC",
        hmacKey,
        new TextEncoder().encode(logicalId),
    );
    const bytes = new Uint8Array(signature);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
