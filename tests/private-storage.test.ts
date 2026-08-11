import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { MatrixEvent, User, type ISyncResponse } from "matrix-js-sdk";
import {
    EncryptedMatrixStore,
    MemoryDraftRepository,
    accountDatabaseName,
} from "../lib/matrix/encrypted-store";
import {
    CLEANUP_STORE,
    LEGACY_SESSION_STORE,
    SESSION_DATABASE,
    SESSION_STORE,
    decryptJson,
    encryptJson,
    getDeviceKeys,
    opaqueRecordKey,
    openSessionDatabase,
    readStoredValue,
    requestValue,
    transactionDone,
    writeStoredValue,
} from "../lib/matrix/private-storage";
import {
    PUSH_CONFIG_KEY,
    PUSH_DATABASE,
    PUSH_STORE,
    readPushConfiguration,
    savePushConfiguration,
} from "../lib/matrix/push-store";
import {
    StoredSessionError,
    createSession,
    randomBase64Url,
    readSession,
    saveSession,
} from "../lib/matrix/session-store";
import {
    clearCurrentAccountData,
    deleteDatabaseBounded,
    retryPendingCleanup,
    eraseAllSubEthaData,
} from "../lib/matrix/storage-cleanup";
import type { LocalStoreId } from "../lib/matrix/types";

class MemoryStorage implements Storage {
    private values = new Map<string, string>();

    get length(): number {
        return this.values.size;
    }

    clear(): void {
        this.values.clear();
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }

    setItem(key: string, value: string): void {
        this.values.set(key, String(value));
    }
}

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory(),
        writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: new MemoryStorage(),
    });
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: new MemoryStorage(),
    });
    Object.defineProperty(globalThis, "BroadcastChannel", {
        configurable: true,
        value: undefined,
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            addEventListener() {},
            clearTimeout: nativeClearTimeout,
            removeEventListener() {},
            setTimeout(callback: TimerHandler, milliseconds?: number) {
                return nativeSetTimeout(
                    callback as (...args: unknown[]) => void,
                    Math.min(milliseconds ?? 0, 10),
                );
            },
        },
    });
});

function sessionWithCanaries(storageMode: "remembered" | "private" = "remembered") {
    return createSession(
        {
            accessToken: "ACCESS_TOKEN_CANARY_82ac",
            authKind: "password",
            baseUrl: "https://matrix.example",
            deviceId: "DEVICE_CANARY_44",
            refreshToken: "REFRESH_TOKEN_CANARY_29",
            userId: "@USER_CANARY:matrix.example",
        },
        storageMode,
    );
}

async function databaseNames(): Promise<string[]> {
    return (await indexedDB.databases())
        .map((database) => database.name)
        .filter((name): name is string => Boolean(name));
}

async function createDatabase(name: string, storeName = "records"): Promise<IDBDatabase> {
    const request = indexedDB.open(name, 1);

    request.onupgradeneeded = () => {
        request.result.createObjectStore(storeName);
    };

    return requestValue(request);
}

async function rawStore(databaseName: string, storeName: string) {
    const request = indexedDB.open(databaseName);
    const database = await requestValue(request);

    try {
        const transaction = database.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const [keys, values] = await Promise.all([
            requestValue(store.getAllKeys()),
            requestValue(store.getAll()),
        ]);

        await transactionDone(transaction);

        return { keys, values };
    } finally {
        database.close();
    }
}

function rawText(value: unknown): string {
    return JSON.stringify(value, (_key, candidate) => {
        if (candidate instanceof ArrayBuffer) {
            return Buffer.from(candidate).toString("base64");
        }

        if (typeof CryptoKey !== "undefined" && candidate instanceof CryptoKey) {
            return "[non-extractable CryptoKey]";
        }

        return candidate;
    });
}

function assertNoCanaries(raw: string, canaries: string[]): void {
    for (const canary of canaries) {
        assert.equal(raw.includes(canary), false, "plaintext canary found: " + canary);
    }
}

function syncResponse(roomId: string, userId: string, eventCanary: string): ISyncResponse {
    const events = Array.from({ length: 60 }, (_, index) => ({
        content: { body: eventCanary + "-" + index, msgtype: "m.text" },
        event_id: "$EVENT_CANARY_" + index,
        origin_server_ts: 1_800_000_000_000 + index,
        sender: userId,
        type: "m.room.message",
    }));

    return {
        next_batch: "NEXT_BATCH_CANARY",
        account_data: { events: [] },
        rooms: {
            invite: {},
            join: {
                [roomId]: {
                    account_data: { events: [] },
                    ephemeral: { events: [] },
                    state: { events: [] },
                    summary: {},
                    timeline: {
                        events,
                        limited: false,
                        prev_batch: "PREV_BATCH_CANARY",
                    },
                    unread_notifications: {},
                },
            },
            knock: {},
            leave: {},
        },
    } as unknown as ISyncResponse;
}

test("device keys are non-extractable and AES-GCM binds ciphertext to its context", async () => {
    const keys = await getDeviceKeys();

    assert.equal(keys.aesKey.extractable, false);
    assert.equal(keys.hmacKey.extractable, false);
    await assert.rejects(() => crypto.subtle.exportKey("raw", keys.aesKey));
    await assert.rejects(() => crypto.subtle.exportKey("raw", keys.hmacKey));

    const context = {
        database: "sub-etha-test",
        store: "records",
        recordType: "session",
        recordKey: "current",
    };
    const value = { token: "CRYPTO_CANARY", nested: { valid: true } };
    const envelope = await encryptJson(keys.aesKey, value, context, 64 * 1024);

    assert.deepEqual(await decryptJson(keys.aesKey, envelope, context, 64 * 1024), value);

    const changedCiphertext = envelope.ciphertext.slice(0);

    new Uint8Array(changedCiphertext)[0] ^= 1;
    await assert.rejects(() =>
        decryptJson(
            keys.aesKey,
            { ...envelope, ciphertext: changedCiphertext },
            context,
            64 * 1024,
        ),
    );

    const changedIv = envelope.iv.slice(0);

    new Uint8Array(changedIv)[0] ^= 1;
    await assert.rejects(() =>
        decryptJson(keys.aesKey, { ...envelope, iv: changedIv }, context, 64 * 1024),
    );
    await assert.rejects(() =>
        decryptJson(keys.aesKey, envelope, { ...context, recordType: "draft" }, 64 * 1024),
    );
    await assert.rejects(() =>
        decryptJson(keys.aesKey, { ...envelope, version: 2 }, context, 64 * 1024),
    );

    const first = await opaqueRecordKey(keys.hmacKey, "room\u001f!secret:example");
    const second = await opaqueRecordKey(keys.hmacKey, "room\u001f!secret:example");

    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.includes("secret"), false);
});

test("remembered session and push capabilities round-trip without plaintext records", async () => {
    const session = sessionWithCanaries();
    const push = {
        deliveryKey: "DELIVERY_KEY_CANARY_123456789",
        managementKey: "MANAGEMENT_KEY_CANARY_123456",
        publicKey: "VAPID_PUBLIC_CANARY_123456789",
    };

    await saveSession(session);
    await savePushConfiguration(push);

    assert.deepEqual(await readSession(), session);
    assert.deepEqual(await readPushConfiguration(), push);

    const sessionRaw = rawText({
        session: await rawStore(SESSION_DATABASE, SESSION_STORE),
        keys: await rawStore(SESSION_DATABASE, "keys"),
    });
    const pushRaw = rawText(await rawStore(PUSH_DATABASE, PUSH_STORE));

    assertNoCanaries(sessionRaw + pushRaw, [
        session.accessToken,
        session.refreshToken!,
        session.cryptoStorageKey,
        session.userId,
        session.deviceId,
        push.deliveryKey,
        push.managementKey,
        push.publicKey,
    ]);
    assert.equal(pushRaw.includes(PUSH_CONFIG_KEY), true);
});

test("session ciphertext corruption fails closed with a typed authentication error", async () => {
    const session = sessionWithCanaries();

    await saveSession(session);
    const envelope = await readStoredValue<{
        version: 1;
        algorithm: "AES-256-GCM";
        iv: ArrayBuffer;
        ciphertext: ArrayBuffer;
    }>(SESSION_STORE, "matrix-session-v2");

    assert.ok(envelope);
    const ciphertext = envelope.ciphertext.slice(0);

    new Uint8Array(ciphertext)[ciphertext.byteLength - 1] ^= 1;
    await writeStoredValue(SESSION_STORE, "matrix-session-v2", { ...envelope, ciphertext });

    await assert.rejects(
        () => readSession(),
        (error: unknown) =>
            error instanceof StoredSessionError && error.code === "authentication-failed",
    );
});

test("encrypted Matrix data, drafts, queues, profiles, presence, and options survive reopening", async () => {
    const keys = await getDeviceKeys();
    const localStoreId = "BBBBBBBBBBBBBBBBBBBBBB" as LocalStoreId;
    const roomId = "!ROOM_CANARY:matrix.example";
    const userId = "@PROFILE_CANARY:matrix.example";
    const eventCanary = "EVENT_CONTENT_CANARY";
    const draftCanary = "DRAFT_CANARY_private_words";
    const store = new EncryptedMatrixStore(localStoreId, keys);

    store.setUserCreator((id) => new User(id));
    await store.startup();
    await store.setSyncData(syncResponse(roomId, userId, eventCanary));
    await store.storeClientOptions({ initialSyncLimit: 17 });
    await store.setOutOfBandMembers(roomId, [
        {
            content: { displayname: "OOB_CANARY" },
            event_id: "$OOB_CANARY",
            origin_server_ts: 1_800_000_000_000,
            room_id: roomId,
            sender: userId,
            state_key: userId,
            type: "m.room.member",
        },
    ]);
    await store.storeUserProfiles(
        new Map([
            [
                userId,
                {
                    avatar_url: "mxc://matrix.example/PROFILE_CANARY",
                    displayname: "PROFILE_CANARY",
                },
            ],
        ]),
    );
    await store.saveToDeviceBatches([
        {
            batch: [{ deviceId: "DEVICE_CANARY", payload: { body: "QUEUE_CANARY" }, userId }],
            eventType: "m.test.queue",
            txnId: "TXN_CANARY",
        },
    ]);

    const user = new User(userId);

    user.setPresenceEvent(
        new MatrixEvent({
            content: { presence: "online", status_msg: "PRESENCE_CANARY" },
            sender: userId,
            type: "m.presence",
        }),
    );
    store.storeUser(user);
    await store.drafts.write(roomId, draftCanary);
    await store.drafts.flush();
    await store.save(true);
    await store.destroy();

    const raw = rawText(await rawStore(accountDatabaseName(localStoreId), "records"));

    assertNoCanaries(raw, [
        roomId,
        userId,
        eventCanary,
        draftCanary,
        "OOB_CANARY",
        "PROFILE_CANARY",
        "QUEUE_CANARY",
        "PRESENCE_CANARY",
        "NEXT_BATCH_CANARY",
    ]);

    for (const key of (await rawStore(accountDatabaseName(localStoreId), "records")).keys) {
        assert.match(String(key), /^[A-Za-z0-9_-]{43}$/);
    }

    const reopened = new EncryptedMatrixStore(localStoreId, keys);

    reopened.setUserCreator((id) => new User(id));
    await reopened.startup();

    const saved = await reopened.getSavedSync();

    assert.ok(saved);
    assert.equal(saved.nextBatch, "NEXT_BATCH_CANARY");
    assert.equal(saved.roomsData.join[roomId].timeline.events.length, 50);
    assert.equal((await reopened.getClientOptions())?.initialSyncLimit, 17);
    assert.equal((await reopened.getOutOfBandMembers(roomId))?.[0].state_key, userId);
    assert.equal((await reopened.getUserProfile(userId))?.displayname, "PROFILE_CANARY");
    assert.equal((await reopened.getOldestToDeviceBatch())?.txnId, "TXN_CANARY");
    assert.equal(
        reopened.getUser(userId)?.events.presence?.getContent().status_msg,
        "PRESENCE_CANARY",
    );
    assert.equal(await reopened.drafts.read(roomId), draftCanary);
    await reopened.destroy();
});

test("corrupt and oversized account cache records degrade to memory", async () => {
    const keys = await getDeviceKeys();
    const localStoreId = "CCCCCCCCCCCCCCCCCCCCCC" as LocalStoreId;
    const roomId = "!oversized:matrix.example";
    const store = new EncryptedMatrixStore(localStoreId, keys);
    let degraded = 0;

    store.on("degraded", () => {
        degraded += 1;
    });
    await store.startup();
    const oversized = "x".repeat(256 * 1024 + 1);

    await store.drafts.write(roomId, oversized);
    assert.equal(await store.drafts.read(roomId), oversized);
    assert.equal(degraded, 1);
    await store.destroy();

    const corruptId = "DDDDDDDDDDDDDDDDDDDDDD" as LocalStoreId;
    const initial = new EncryptedMatrixStore(corruptId, keys);

    await initial.startup();
    await initial.setSyncData(syncResponse("!corrupt:example", "@user:example", "CORRUPT_CANARY"));
    await initial.save(true);
    await initial.destroy();

    const recordKey = await opaqueRecordKey(keys.hmacKey, "sync-snapshot\u001fcurrent");
    const database = await createDatabase(accountDatabaseName(corruptId)).catch(async () => {
        const request = indexedDB.open(accountDatabaseName(corruptId));

        return requestValue(request);
    });
    const transaction = database.transaction("records", "readwrite");

    transaction.objectStore("records").put({ invalid: true }, recordKey);
    await transactionDone(transaction);
    database.close();

    const reopened = new EncryptedMatrixStore(corruptId, keys);
    let corruptionDegraded = false;

    reopened.on("degraded", () => {
        corruptionDegraded = true;
    });
    await reopened.startup();
    assert.equal(corruptionDegraded, true);
    assert.equal(await reopened.getSavedSync(), null);
    await reopened.setSyncData(syncResponse("!memory:example", "@memory:example", "MEMORY_ONLY"));
    await reopened.destroy();
});

test("private sessions and drafts create no durable storage records", async () => {
    const session = sessionWithCanaries("private");
    const drafts = new MemoryDraftRepository();

    await saveSession(session);
    await drafts.write("!private:example", "PRIVATE_DRAFT_CANARY");

    assert.equal(await drafts.read("!private:example"), "PRIVATE_DRAFT_CANARY");
    assert.deepEqual(await databaseNames(), []);
});

test("legacy session and draft migration preserves Rust identity and removes plaintext", async () => {
    const userId = "@legacy:matrix.example";
    const deviceId = "LEGACY_DEVICE";
    const cryptoStorageKey = randomBase64Url(32);
    const accessToken = "LEGACY_ACCESS_CANARY";
    const roomId = "!LEGACY_ROOM_CANARY:matrix.example";
    const draft = "LEGACY_DRAFT_CANARY";
    const legacyPrefix = "sub-etha-crypto-_legacy_matrix_example-LEGACY_DEVICE";
    const legacySession = {
        accessToken,
        authKind: "token",
        baseUrl: "https://matrix.example",
        cryptoStorageKey,
        deviceId,
        userId,
    };
    const database = await openSessionDatabase();
    const transaction = database.transaction(LEGACY_SESSION_STORE, "readwrite");

    transaction.objectStore(LEGACY_SESSION_STORE).put(legacySession, "matrix-session");
    await transactionDone(transaction);
    database.close();

    localStorage.setItem("sub-etha-draft:" + roomId, draft);
    const legacySync = await createDatabase("sub-etha-sync-_legacy_matrix_example-LEGACY_DEVICE");
    const syncTransaction = legacySync.transaction("records", "readwrite");

    syncTransaction.objectStore("records").put({ token: accessToken, roomId }, "plaintext");
    await transactionDone(syncTransaction);
    legacySync.close();

    const migrated = await readSession();

    assert.ok(migrated);
    assert.equal(migrated.cryptoStorageKey, cryptoStorageKey);
    assert.equal(migrated.cryptoDatabasePrefix, legacyPrefix);
    assert.equal(localStorage.getItem("sub-etha-draft:" + roomId), null);
    assert.equal(
        (await databaseNames()).includes("sub-etha-sync-_legacy_matrix_example-LEGACY_DEVICE"),
        false,
    );
    assert.equal(await readStoredValue(LEGACY_SESSION_STORE, "matrix-session"), null);

    const account = new EncryptedMatrixStore(migrated.localStoreId, await getDeviceKeys());

    await account.startup();
    assert.equal(await account.drafts.read(roomId), draft);
    await account.destroy();

    const raw = rawText({
        account: await rawStore(accountDatabaseName(migrated.localStoreId), "records"),
        session: await rawStore(SESSION_DATABASE, SESSION_STORE),
    });

    assertNoCanaries(raw, [accessToken, cryptoStorageKey, userId, deviceId, roomId, draft]);
});

test("interrupted legacy migration retains the valid plaintext session for retry", async () => {
    const userId = "@blocked:matrix.example";
    const deviceId = "BLOCKED_DEVICE";
    const legacyName = "_blocked_matrix_example-BLOCKED_DEVICE";
    const database = await openSessionDatabase();
    const transaction = database.transaction(LEGACY_SESSION_STORE, "readwrite");

    transaction.objectStore(LEGACY_SESSION_STORE).put(
        {
            accessToken: "BLOCKED_ACCESS_CANARY",
            authKind: "token",
            baseUrl: "https://matrix.example",
            cryptoStorageKey: randomBase64Url(32),
            deviceId,
            userId,
        },
        "matrix-session",
    );
    await transactionDone(transaction);
    database.close();

    const blocker = await createDatabase("sub-etha-sync-" + legacyName);

    await assert.rejects(() => readSession(), /blocking removal/i);
    assert.ok(await readStoredValue(LEGACY_SESSION_STORE, "matrix-session"));
    assert.equal(await readStoredValue(SESSION_STORE, "matrix-session-v2"), null);

    blocker.close();
    const migrated = await readSession();

    assert.ok(migrated);
    assert.equal(migrated.userId, userId);
    assert.equal(await readStoredValue(LEGACY_SESSION_STORE, "matrix-session"), null);
});

test("full reset clears managed storage, caches, push, and the service worker", async () => {
    const session = sessionWithCanaries();

    await saveSession(session);
    await savePushConfiguration({
        deliveryKey: "RESET_DELIVERY_KEY_123456789",
        managementKey: "RESET_MANAGEMENT_KEY_123456",
        publicKey: "RESET_VAPID_KEY_123456789",
    });

    const account = new EncryptedMatrixStore(session.localStoreId, await getDeviceKeys());

    await account.startup();
    await account.drafts.write("!reset:example", "RESET_DRAFT_CANARY");
    await account.drafts.flush();
    await account.destroy();
    (await createDatabase("sub-etha-sync-legacy-reset")).close();
    (await createDatabase("sub-etha-crypto-legacy-reset")).close();

    localStorage.setItem("sub-etha-theme", "dark");
    localStorage.setItem("unrelated-key", "preserved");
    sessionStorage.setItem("sub-etha-oauth-pending", "pending");

    let unsubscribed = false;
    let unregistered = false;
    const deletedCaches: string[] = [];
    const cacheApi = {
        async delete(name: string) {
            deletedCaches.push(name);

            return true;
        },
        async keys() {
            return ["sub-etha-shell-v5", "unrelated-cache"];
        },
    };

    Object.defineProperty(globalThis, "caches", { configurable: true, value: cacheApi });
    Object.defineProperty(window, "caches", { configurable: true, value: cacheApi });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            serviceWorker: {
                async getRegistrations() {
                    return [
                        {
                            pushManager: {
                                async getSubscription() {
                                    return {
                                        async unsubscribe() {
                                            unsubscribed = true;

                                            return true;
                                        },
                                    };
                                },
                            },
                            scope: "https://app.example/",
                            async unregister() {
                                unregistered = true;

                                return true;
                            },
                        },
                    ];
                },
            },
        },
    });

    const result = await eraseAllSubEthaData(async () => true);

    assert.equal(result.complete, true);
    assert.equal(unsubscribed, true);
    assert.equal(unregistered, true);
    assert.deepEqual(deletedCaches, ["sub-etha-shell-v5"]);
    assert.equal(localStorage.getItem("sub-etha-theme"), null);
    assert.equal(sessionStorage.getItem("sub-etha-oauth-pending"), null);
    assert.equal(localStorage.getItem("unrelated-key"), "preserved");
    assert.equal(
        (await databaseNames()).some((name) => name.startsWith("sub-etha-")),
        false,
    );
});

test("account cleanup removes credentials and exact databases while preserving device preferences", async () => {
    const session = sessionWithCanaries();

    await saveSession(session);
    localStorage.setItem("sub-etha-theme", "night");
    localStorage.setItem("sub-etha-oauth-client:https://matrix.example", "registration");

    const account = new EncryptedMatrixStore(session.localStoreId, await getDeviceKeys());

    await account.startup();
    await account.drafts.write("!cleanup:example", "CLEANUP_DRAFT_CANARY");
    await account.drafts.flush();
    await account.destroy();

    for (const name of [
        session.cryptoDatabasePrefix + "::matrix-sdk-crypto",
        session.cryptoDatabasePrefix + "::matrix-sdk-crypto-meta",
    ]) {
        (await createDatabase(name)).close();
    }

    const result = await clearCurrentAccountData(session, false);

    assert.equal(result.localCredentialsRemoved, true);
    assert.equal(result.complete, true);
    assert.equal(result.remoteRevocationConfirmed, false);
    assert.equal(await readSession(), null);
    assert.equal(
        (await databaseNames()).includes(accountDatabaseName(session.localStoreId)),
        false,
    );
    assert.equal(
        (await databaseNames()).some((name) => name.startsWith(session.cryptoDatabasePrefix)),
        false,
    );
    assert.equal(localStorage.getItem("sub-etha-theme"), "night");
    assert.equal(
        localStorage.getItem("sub-etha-oauth-client:https://matrix.example"),
        "registration",
    );
    assert.ok((await getDeviceKeys()).aesKey);
    assert.equal(await readStoredValue(CLEANUP_STORE, "account-cleanup-v1"), null);
});

test("blocked deletion reports partial cleanup and retry succeeds after the connection closes", async () => {
    const session = sessionWithCanaries();

    await saveSession(session);
    const blocker = await createDatabase(accountDatabaseName(session.localStoreId));

    const partial = await clearCurrentAccountData(session, true);

    assert.equal(partial.complete, false);
    assert.equal(
        partial.results.some((result) => result.status === "blocked"),
        true,
    );
    assert.ok(await readStoredValue(CLEANUP_STORE, "account-cleanup-v1"));

    blocker.close();
    const retry = await retryPendingCleanup();

    assert.ok(retry);
    assert.equal(retry.complete, true);
    assert.equal(await readStoredValue(CLEANUP_STORE, "account-cleanup-v1"), null);
});

test("bounded deletion distinguishes a blocked database from a cleared database", async () => {
    const blocker = await createDatabase("sub-etha-account-EEEEEEEEEEEEEEEEEEEEEE");
    const blocked = await deleteDatabaseBounded("sub-etha-account-EEEEEEEEEEEEEEEEEEEEEE", 5);

    assert.equal(blocked.status, "blocked");
    blocker.close();

    const cleared = await deleteDatabaseBounded("sub-etha-account-EEEEEEEEEEEEEEEEEEEEEE", 50);

    assert.equal(cleared.status, "cleared");
});
