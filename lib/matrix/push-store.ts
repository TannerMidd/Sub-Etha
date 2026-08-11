import {
    decryptJson,
    encryptJson,
    readDeviceAesKey,
    requestValue,
    transactionDone,
} from "./private-storage";

export const PUSH_DATABASE = "sub-etha-push";
export const PUSH_DATABASE_VERSION = 2;
export const PUSH_STORE = "settings";
export const PUSH_CONFIG_KEY = "config-v2";
export const LEGACY_PUSH_CONFIG_KEY = "config";

const PUSH_LIMIT_BYTES = 16 * 1024;
const LEGACY_PUSH_KEY_STORAGE = "sub-etha-push-key";
const PUSH_DELIVERY_KEY_STORAGE = "sub-etha-push-delivery-key";
const PUSH_MANAGEMENT_KEY_STORAGE = "sub-etha-push-management-key";

export interface PushConfiguration {
    deliveryKey: string;
    managementKey: string;
    publicKey: string;
}

function pushContext() {
    return {
        database: PUSH_DATABASE,
        store: PUSH_STORE,
        recordType: "push-capabilities",
        recordKey: PUSH_CONFIG_KEY,
    };
}

function openPushDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(PUSH_DATABASE, PUSH_DATABASE_VERSION);

        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(PUSH_STORE)) {
                request.result.createObjectStore(PUSH_STORE);
            }
        };

        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };

        request.onerror = () =>
            reject(request.error ?? new Error("The encrypted push store could not open."));
        request.onblocked = () =>
            reject(new Error("Another tab is blocking the encrypted push-store upgrade."));
    });
}

function validatePushConfiguration(value: unknown): PushConfiguration {
    if (!value || typeof value !== "object") {
        throw new Error("The encrypted push configuration is invalid.");
    }

    const config = value as Partial<PushConfiguration>;

    for (const [name, candidate] of Object.entries({
        deliveryKey: config.deliveryKey,
        managementKey: config.managementKey,
        publicKey: config.publicKey,
    })) {
        if (
            typeof candidate !== "string" ||
            candidate.length < 16 ||
            candidate.length > 4096 ||
            !/^[A-Za-z0-9_-]+$/.test(candidate)
        ) {
            throw new Error("The stored push " + name + " is invalid.");
        }
    }

    return config as PushConfiguration;
}

async function readRaw(key: IDBValidKey): Promise<unknown> {
    const database = await openPushDatabase();

    try {
        const transaction = database.transaction(PUSH_STORE, "readonly");
        const value = await requestValue(transaction.objectStore(PUSH_STORE).get(key));

        await transactionDone(transaction);

        return value;
    } finally {
        database.close();
    }
}

async function writeEncryptedConfiguration(config: PushConfiguration): Promise<void> {
    const aesKey = await readDeviceAesKey();
    const envelope = await encryptJson(aesKey, config, pushContext(), PUSH_LIMIT_BYTES);
    const database = await openPushDatabase();

    try {
        const transaction = database.transaction(PUSH_STORE, "readwrite");
        const store = transaction.objectStore(PUSH_STORE);

        store.put(envelope, PUSH_CONFIG_KEY);
        store.delete(LEGACY_PUSH_CONFIG_KEY);
        await transactionDone(transaction);
    } finally {
        database.close();
    }

    clearLegacyPushCredentials();
}

export async function readPushConfiguration(): Promise<PushConfiguration | null> {
    const encrypted = await readRaw(PUSH_CONFIG_KEY);

    if (encrypted) {
        const aesKey = await readDeviceAesKey();
        const value = await decryptJson<unknown>(
            aesKey,
            encrypted,
            pushContext(),
            PUSH_LIMIT_BYTES,
        );

        return validatePushConfiguration(value);
    }

    const legacy = await readRaw(LEGACY_PUSH_CONFIG_KEY);

    if (legacy) {
        const config = validatePushConfiguration(legacy);

        await writeEncryptedConfiguration(config);

        return config;
    }

    return null;
}

export async function savePushConfiguration(config: PushConfiguration): Promise<void> {
    await writeEncryptedConfiguration(validatePushConfiguration(config));
}

export async function clearPushConfiguration(): Promise<void> {
    const database = await openPushDatabase();

    try {
        const transaction = database.transaction(PUSH_STORE, "readwrite");
        const store = transaction.objectStore(PUSH_STORE);

        store.delete(PUSH_CONFIG_KEY);
        store.delete(LEGACY_PUSH_CONFIG_KEY);
        await transactionDone(transaction);
    } finally {
        database.close();
    }

    clearLegacyPushCredentials();
}

export function readLegacyPushCredentials(): {
    deliveryKey: string;
    managementKey: string;
} | null {
    const deliveryKey =
        localStorage.getItem(PUSH_DELIVERY_KEY_STORAGE) ??
        localStorage.getItem(LEGACY_PUSH_KEY_STORAGE);
    const managementKey = localStorage.getItem(PUSH_MANAGEMENT_KEY_STORAGE);

    if (!deliveryKey || !managementKey) {
        return null;
    }

    return { deliveryKey, managementKey };
}

export async function migrateLegacyPushConfiguration(): Promise<void> {
    if (await readPushConfiguration()) {
        return;
    }

    const legacy = readLegacyPushCredentials();

    if (!legacy) {
        return;
    }

    const response = await fetch("/api/push/vapid-key", {
        headers: { Accept: "application/json" },
        cache: "no-store",
    });

    if (!response.ok) {
        throw new Error("Legacy push credentials could not be migrated.");
    }

    const payload = (await response.json()) as { publicKey?: unknown };

    if (typeof payload.publicKey !== "string" || !payload.publicKey) {
        throw new Error("The push application key is invalid.");
    }

    await savePushConfiguration({
        ...legacy,
        publicKey: payload.publicKey,
    });
}

export function clearLegacyPushCredentials(): void {
    localStorage.removeItem(PUSH_DELIVERY_KEY_STORAGE);
    localStorage.removeItem(PUSH_MANAGEMENT_KEY_STORAGE);
    localStorage.removeItem(LEGACY_PUSH_KEY_STORAGE);
}
