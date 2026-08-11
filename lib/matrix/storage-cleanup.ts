import { accountDatabaseName } from "./encrypted-store";
import {
    CLEANUP_STORE,
    decryptJson,
    deleteStoredValue,
    encryptJson,
    getDeviceKeys,
    readStoredValue,
    SESSION_DATABASE,
    writeStoredValue,
} from "./private-storage";
import { clearSession } from "./session-store";
import type { CleanupOutcome, CleanupScopeResult, PersistedMatrixSession } from "./types";

const PUSH_DATABASE = "sub-etha-push";
const CLEANUP_MANIFEST_KEY = "account-cleanup-v1";
const CLEANUP_LIMIT_BYTES = 64 * 1024;
const STORAGE_CHANNEL = "sub-etha-storage";
const STORAGE_SIGNAL_KEY = "sub-etha-storage-reset";

interface CleanupManifest {
    version: 1;
    accountDatabases: string[];
    rustDatabases: string[];
    createdAt: number;
}

function cleanupContext() {
    return {
        database: SESSION_DATABASE,
        store: CLEANUP_STORE,
        recordType: "cleanup-manifest",
        recordKey: CLEANUP_MANIFEST_KEY,
    };
}

function manifestFor(session: PersistedMatrixSession): CleanupManifest {
    return {
        version: 1,
        accountDatabases: [accountDatabaseName(session.localStoreId)],
        rustDatabases:
            session.storageMode === "remembered"
                ? [
                      session.cryptoDatabasePrefix + "::matrix-sdk-crypto",
                      session.cryptoDatabasePrefix + "::matrix-sdk-crypto-meta",
                  ]
                : [],
        createdAt: Date.now(),
    };
}

function validManifest(value: unknown): value is CleanupManifest {
    if (!value || typeof value !== "object") {
        return false;
    }

    const manifest = value as Partial<CleanupManifest>;
    const validNames = (names: unknown) =>
        Array.isArray(names) &&
        names.every(
            (name) =>
                typeof name === "string" && name.startsWith("sub-etha-") && name.length <= 256,
        );

    return (
        manifest.version === 1 &&
        Number.isFinite(manifest.createdAt) &&
        validNames(manifest.accountDatabases) &&
        validNames(manifest.rustDatabases)
    );
}

async function saveCleanupManifest(manifest: CleanupManifest): Promise<void> {
    const { aesKey } = await getDeviceKeys();
    const envelope = await encryptJson(aesKey, manifest, cleanupContext(), CLEANUP_LIMIT_BYTES);

    await writeStoredValue(CLEANUP_STORE, CLEANUP_MANIFEST_KEY, envelope);
}

async function readCleanupManifest(): Promise<CleanupManifest | null> {
    const envelope = await readStoredValue<unknown>(CLEANUP_STORE, CLEANUP_MANIFEST_KEY);

    if (!envelope) {
        return null;
    }

    const { aesKey } = await getDeviceKeys();
    const value = await decryptJson<unknown>(
        aesKey,
        envelope,
        cleanupContext(),
        CLEANUP_LIMIT_BYTES,
    );

    if (!validManifest(value)) {
        throw new Error("The encrypted cleanup manifest is invalid.");
    }

    return value;
}

export function deleteDatabaseBounded(
    name: string,
    timeoutMs = 5_000,
): Promise<CleanupScopeResult> {
    return new Promise((resolve) => {
        let settled = false;
        let blocked = false;

        const finish = (result: CleanupScopeResult) => {
            if (settled) {
                return;
            }

            settled = true;
            window.clearTimeout(timer);
            resolve(result);
        };

        const request = indexedDB.deleteDatabase(name);
        const timer = window.setTimeout(() => {
            finish({
                scope: "database:" + name,
                status: blocked ? "blocked" : "failed",
                detail: blocked
                    ? "Another tab still has this database open."
                    : "Database deletion did not finish within five seconds.",
            });
        }, timeoutMs);

        request.onsuccess = () => finish({ scope: "database:" + name, status: "cleared" });
        request.onerror = () =>
            finish({
                scope: "database:" + name,
                status: "failed",
                detail: request.error?.message ?? "Database deletion failed.",
            });

        request.onblocked = () => {
            blocked = true;
        };
    });
}

async function deleteManifestDatabases(manifest: CleanupManifest): Promise<CleanupScopeResult[]> {
    const names = [...new Set([...manifest.accountDatabases, ...manifest.rustDatabases])];

    return Promise.all(names.map((name) => deleteDatabaseBounded(name)));
}

function outcome(
    results: CleanupScopeResult[],
    localCredentialsRemoved: boolean,
    remoteRevocationConfirmed: boolean,
    warning?: string,
): CleanupOutcome {
    const complete =
        localCredentialsRemoved && results.every((result) => result.status === "cleared");

    return {
        complete,
        localCredentialsRemoved,
        remoteRevocationConfirmed,
        results,
        warning,
    };
}

export async function prepareAccountCleanup(session: PersistedMatrixSession): Promise<void> {
    if (session.storageMode === "remembered") {
        await saveCleanupManifest(manifestFor(session));
    }
}

export async function clearCurrentAccountData(
    session: PersistedMatrixSession,
    remoteRevocationConfirmed: boolean,
): Promise<CleanupOutcome> {
    if (session.storageMode === "private") {
        return outcome(
            [{ scope: "private-session", status: "cleared" }],
            true,
            remoteRevocationConfirmed,
            remoteRevocationConfirmed
                ? undefined
                : "The Matrix token could not be remotely revoked.",
        );
    }

    const manifest = manifestFor(session);

    await prepareAccountCleanup(session);

    const results: CleanupScopeResult[] = [];
    let localCredentialsRemoved = false;

    try {
        await clearSession();
        localCredentialsRemoved = true;
        results.push({ scope: "session", status: "cleared" });
    } catch (error) {
        results.push({
            scope: "session",
            status: "failed",
            detail: error instanceof Error ? error.message : "Session deletion failed.",
        });
    }

    results.push(...(await deleteManifestDatabases(manifest)));
    const localComplete =
        localCredentialsRemoved && results.every((result) => result.status === "cleared");

    if (localComplete) {
        await deleteStoredValue(CLEANUP_STORE, CLEANUP_MANIFEST_KEY).catch(() => undefined);
    }

    return outcome(
        results,
        localCredentialsRemoved,
        remoteRevocationConfirmed,
        remoteRevocationConfirmed
            ? undefined
            : "Local data was handled, but remote token revocation could not be confirmed.",
    );
}

export async function retryPendingCleanup(): Promise<CleanupOutcome | null> {
    const manifest = await readCleanupManifest();

    if (!manifest) {
        return null;
    }

    const results = await deleteManifestDatabases(manifest);
    const complete = results.every((result) => result.status === "cleared");

    if (complete) {
        await deleteStoredValue(CLEANUP_STORE, CLEANUP_MANIFEST_KEY);
    }

    return outcome(results, true, true);
}

interface StorageResetMessage {
    type: "reset-request" | "reset-ack";
    requestId: string;
}

function storageChannel(): BroadcastChannel | null {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(STORAGE_CHANNEL);
}

export function listenForStorageReset(shutdown: () => Promise<void> | void): () => void {
    const channel = storageChannel();

    const handle = (message: StorageResetMessage) => {
        if (message.type !== "reset-request") {
            return;
        }

        void Promise.resolve(shutdown()).finally(() => {
            channel?.postMessage({ type: "reset-ack", requestId: message.requestId });
        });
    };

    const onChannel = (event: MessageEvent<StorageResetMessage>) => handle(event.data);

    const onStorage = (event: StorageEvent) => {
        if (event.key !== STORAGE_SIGNAL_KEY || !event.newValue) {
            return;
        }

        try {
            handle(JSON.parse(event.newValue) as StorageResetMessage);
        } catch {
            // Invalid cross-tab signals are ignored.
        }
    };

    channel?.addEventListener("message", onChannel);
    window.addEventListener("storage", onStorage);

    return () => {
        channel?.removeEventListener("message", onChannel);
        channel?.close();
        window.removeEventListener("storage", onStorage);
    };
}

export async function requestStorageShutdown(): Promise<void> {
    const request: StorageResetMessage = {
        type: "reset-request",
        requestId: crypto.randomUUID(),
    };
    const channel = storageChannel();

    channel?.postMessage(request);
    localStorage.setItem(STORAGE_SIGNAL_KEY, JSON.stringify(request));
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    channel?.close();
}

async function knownDatabaseNames(): Promise<{
    names: string[];
    exhaustive: boolean;
}> {
    const fixed = [PUSH_DATABASE, SESSION_DATABASE];
    const databasesMethod = (
        indexedDB as IDBFactory & {
            databases?: () => Promise<Array<{ name?: string; version?: number }>>;
        }
    ).databases;

    if (!databasesMethod) {
        return { names: fixed, exhaustive: false };
    }

    const databases = await databasesMethod.call(indexedDB);
    const managed = databases
        .map((database) => database.name)
        .filter(
            (name): name is string =>
                typeof name === "string" &&
                (name.startsWith("sub-etha-account-") ||
                    name.startsWith("sub-etha-sync-") ||
                    name.startsWith("sub-etha-crypto-")),
        );

    return { names: [...new Set([...managed, ...fixed])], exhaustive: true };
}

function clearWebStorage(storage: Storage): void {
    const keys: string[] = [];

    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);

        if (key?.startsWith("sub-etha-")) {
            keys.push(key);
        }
    }

    for (const key of keys) {
        storage.removeItem(key);
    }
}

export async function eraseAllSubEthaData(
    beforeDelete?: () => Promise<boolean>,
): Promise<CleanupOutcome> {
    await requestStorageShutdown();
    const remoteRevocationConfirmed = beforeDelete ? await beforeDelete().catch(() => false) : true;
    const results: CleanupScopeResult[] = [];

    if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();

        for (const registration of registrations) {
            const subscription = await registration.pushManager.getSubscription().catch(() => null);

            await subscription?.unsubscribe().catch(() => undefined);
            const cleared = await registration.unregister().catch(() => false);

            results.push({
                scope: "service-worker:" + registration.scope,
                status: cleared ? "cleared" : "failed",
            });
        }
    }

    const names = await knownDatabaseNames();

    for (const name of names.names.filter((candidate) => candidate !== SESSION_DATABASE)) {
        results.push(await deleteDatabaseBounded(name));
    }

    if ("caches" in window) {
        const cacheNames = await caches.keys();

        for (const name of cacheNames.filter((candidate) => candidate.startsWith("sub-etha-"))) {
            const cleared = await caches.delete(name);

            results.push({
                scope: "cache:" + name,
                status: cleared ? "cleared" : "failed",
            });
        }
    }

    clearWebStorage(localStorage);
    clearWebStorage(sessionStorage);
    results.push({ scope: "web-storage", status: "cleared" });
    results.push(await deleteDatabaseBounded(SESSION_DATABASE));

    const warning = names.exhaustive
        ? undefined
        : "This browser cannot enumerate old databases. Use Clear site data to guarantee removal of unidentified stale stores.";

    return outcome(
        results,
        results.every((result) => result.status === "cleared"),
        remoteRevocationConfirmed,
        warning,
    );
}
