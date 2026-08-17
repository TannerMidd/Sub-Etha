import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
    ABANDONED_MATRIX_PUSHER_WARNING,
    clearAbandonedMatrixPusherWarning,
    enablePush,
    forgetLocalPushState,
    hasBrowserPushArtifacts,
    hasLocalPushStateForCleanup,
    readAbandonedMatrixPusherWarning,
    refreshPushState,
} from "../lib/matrix/notifications";

const DELIVERY = "delivery-old";
const MANAGEMENT = "management-old";
const GENERATION = "generation-old";
const ENDPOINT = "https://push.example/old";
const ORPHAN_DELIVERY = "d".repeat(43);
const ORPHAN_MANAGEMENT = "m".repeat(43);
const ORPHAN_GENERATION = "g".repeat(22);

function memoryStorage(): Storage {
    const values = new Map<string, string>();

    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    };
}

interface CleanupFixture {
    indexedDB: IDBFactory;
    storage: Storage;
    service: Parameters<typeof enablePush>[0];
    subscription: PushSubscription;
    gatewayDeletes: string[];
    removedPushers: string[];
    setGetSubscription: (operation: () => Promise<PushSubscription | null>) => void;
    setGetRegistration: (operation: () => Promise<ServiceWorkerRegistration | undefined>) => void;
    setActiveWorker: (worker: ServiceWorker | null) => void;
    setGetNotifications: (operation: () => Promise<Notification[]>) => void;
    setIndexedDB: (factory: IDBFactory) => void;
    setGateway: (operation: (signal?: AbortSignal) => Promise<Response>) => void;
    setWorkerReply: (
        operation: (message: Record<string, unknown>, port?: MessagePort) => void,
    ) => void;
    unsubscribeCalls: () => number;
    closedNotifications: () => number;
}

function installFixture(): CleanupFixture {
    const storage = memoryStorage();
    let unsubscribeCalls = 0;
    let closedNotifications = 0;
    let lockTail: Promise<unknown> = Promise.resolve();
    let getSubscription = async (): Promise<PushSubscription | null> => subscription;
    let getRegistration = async (): Promise<ServiceWorkerRegistration | undefined> => registration;

    let replyToWorker = (message: Record<string, unknown>, port?: MessagePort) => {
        if (message.type === "READ_PUSH_CONFIG") {
            port?.postMessage({ ok: true, protocolVersion: 2, config: null });

            return;
        }

        port?.postMessage({ ok: true, protocolVersion: 2, cleared: true });
    };

    let activeWorker: ServiceWorker | null;
    let getNotifications = async () =>
        [
            {
                close: () => {
                    closedNotifications += 1;
                },
            },
        ] as unknown as Notification[];
    const gatewayDeletes: string[] = [];
    const removedPushers: string[] = [];
    let gateway: (signal?: AbortSignal) => Promise<Response> = async () =>
        new Response(JSON.stringify({ removed: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    const subscription = {
        endpoint: ENDPOINT,
        unsubscribe: async () => {
            unsubscribeCalls += 1;

            return true;
        },
    } as PushSubscription;
    const worker = {
        postMessage(message: unknown, transfer?: Transferable[]) {
            const port = transfer?.[0] as MessagePort | undefined;

            replyToWorker(message as Record<string, unknown>, port);
        },
    } as ServiceWorker;

    activeWorker = worker;
    const registration = {
        get active() {
            return activeWorker;
        },
        pushManager: {
            getSubscription: () => getSubscription(),
        },
        getNotifications: () => getNotifications(),
    } as unknown as ServiceWorkerRegistration;
    const browserWindow = {
        // Keep deliberately hung operations bounded without turning ordinary fake-IndexedDB
        // callbacks into scheduler-race failures when the complete test suite runs in parallel.
        setTimeout: (callback: TimerHandler) => globalThis.setTimeout(callback, 100),
        clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
        indexedDB: new IDBFactory(),
    } as unknown as Window & typeof globalThis;
    const browserNavigator = {
        locks: {
            request: async (
                _name: string,
                _options: LockOptions,
                callback: (lock: Lock | null) => Promise<unknown>,
            ) => {
                const result = lockTail.then(() => callback(null));

                lockTail = result.then(
                    () => undefined,
                    () => undefined,
                );

                return result;
            },
        },
        serviceWorker: {
            getRegistration: () => getRegistration(),
        },
        clearAppBadge: async () => undefined,
    } as unknown as Navigator;

    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: browserNavigator,
    });
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: browserWindow.indexedDB,
    });
    clearAbandonedMatrixPusherWarning();
    globalThis.fetch = ((input, init) => {
        if (init?.method === "DELETE") {
            const body = JSON.parse(String(init.body)) as { managementKey?: string };

            if (body.managementKey) {
                gatewayDeletes.push(body.managementKey);
            }
        }

        return gateway(init?.signal ?? undefined);
    }) as typeof fetch;

    storage.setItem("sub-etha-push-delivery-key", DELIVERY);
    storage.setItem("sub-etha-push-management-key", MANAGEMENT);
    storage.setItem("sub-etha-push-generation", GENERATION);
    storage.setItem("sub-etha-push-endpoint", ENDPOINT);

    return {
        indexedDB: browserWindow.indexedDB,
        storage,
        service: {
            removePusher: async (pushKey: string) => {
                removedPushers.push(pushKey);
            },
        } as unknown as Parameters<typeof enablePush>[0],
        subscription,
        gatewayDeletes,
        removedPushers,
        setGetSubscription: (operation) => {
            getSubscription = operation;
        },
        setGetRegistration: (operation) => {
            getRegistration = operation;
        },
        setActiveWorker: (nextWorker) => {
            activeWorker = nextWorker;
        },
        setGetNotifications: (operation) => {
            getNotifications = operation;
        },
        setIndexedDB: (factory) => {
            Object.defineProperty(browserWindow, "indexedDB", {
                configurable: true,
                value: factory,
            });
            Object.defineProperty(globalThis, "indexedDB", {
                configurable: true,
                value: factory,
            });
        },
        setGateway: (operation) => {
            gateway = operation;
        },
        setWorkerReply: (operation) => {
            replyToWorker = operation;
        },
        unsubscribeCalls: () => unsubscribeCalls,
        closedNotifications: () => closedNotifications,
    };
}

function pendingCleanup(storage: Storage) {
    const stored = storage.getItem("sub-etha-push-cleanup-v1");

    assert.ok(stored);

    return JSON.parse(stored) as { managementKey?: string; subscriptionDone?: boolean };
}

async function writeOrphanedPushConfig(
    factory: IDBFactory,
    config: Record<string, unknown>,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = factory.open("sub-etha-push", 1);

        request.onupgradeneeded = () => {
            request.result.createObjectStore("settings");
        };

        request.onerror = () =>
            reject(request.error ?? new Error("Could not create push database."));

        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction("settings", "readwrite");

            transaction.objectStore("settings").put(config, "config");

            transaction.oncomplete = () => {
                database.close();
                resolve();
            };

            transaction.onabort = () =>
                reject(transaction.error ?? new Error("Could not write push configuration."));
            transaction.onerror = () =>
                reject(transaction.error ?? new Error("Could not write push configuration."));
        };
    });
}

async function orphanedPushDatabaseExists(factory: IDBFactory): Promise<boolean> {
    return (await factory.databases()).some((database) => database.name === "sub-etha-push");
}

test("rejected and hung subscription lookup retain a durable retry capability", async () => {
    for (const operation of [
        () => Promise.reject(new Error("subscription rejected")),
        () => new Promise<PushSubscription | null>(() => undefined),
    ]) {
        const fixture = installFixture();

        fixture.setGetSubscription(operation);
        const result = await forgetLocalPushState();

        assert.equal(result.complete, false);
        assert.equal(result.durable, true);
        assert.equal(pendingCleanup(fixture.storage).managementKey, MANAGEMENT);
        assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), null);
    }
});

test("unsubscribe failure remains retryable and displayed notifications are closed", async () => {
    const fixture = installFixture();

    fixture.subscription.unsubscribe = async () => {
        throw new Error("unsubscribe rejected");
    };

    const result = await forgetLocalPushState(fixture.service);

    assert.equal(result.complete, false);
    assert.equal(pendingCleanup(fixture.storage).subscriptionDone, false);
    assert.equal(fixture.closedNotifications(), 1);
});

test("an unsubscribe false result is not mistaken for completed cleanup", async () => {
    const fixture = installFixture();

    fixture.subscription.unsubscribe = async () => false;
    const result = await forgetLocalPushState();

    assert.equal(result.complete, false);
    assert.equal(pendingCleanup(fixture.storage).subscriptionDone, false);
});

test("a hung gateway retains the management capability in the retry marker", async () => {
    const fixture = installFixture();

    fixture.setGateway(
        (signal) =>
            new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new Error("gateway aborted")), {
                    once: true,
                });
            }),
    );
    const result = await forgetLocalPushState();

    assert.equal(result.complete, false);
    assert.equal(result.durable, true);
    assert.equal(pendingCleanup(fixture.storage).managementKey, MANAGEMENT);
});

test("a rejected gateway and missing service-worker acknowledgement remain retryable", async () => {
    const gatewayFixture = installFixture();

    gatewayFixture.setGateway(async () => {
        throw new Error("gateway rejected");
    });
    assert.equal((await forgetLocalPushState()).complete, false);
    assert.equal(pendingCleanup(gatewayFixture.storage).managementKey, MANAGEMENT);

    const workerFixture = installFixture();

    workerFixture.setWorkerReply(() => undefined);
    const workerResult = await forgetLocalPushState();

    assert.equal(workerResult.complete, false);
    assert.equal(workerResult.durable, true);
    assert.equal(workerFixture.unsubscribeCalls(), 0);
    assert.equal(workerFixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
    assert.ok(workerFixture.storage.getItem("sub-etha-push-cleanup-intent-v1"));
});

test("a failed cleanup-intent write does not overclaim durability on worker probe failure", async () => {
    const fixture = installFixture();
    const write = fixture.storage.setItem.bind(fixture.storage);

    fixture.storage.setItem = (key, value) => {
        if (key === "sub-etha-push-cleanup-intent-v1") {
            throw new Error("cleanup intent write rejected");
        }

        write(key, value);
    };

    fixture.setWorkerReply(() => undefined);

    const result = await forgetLocalPushState();

    assert.equal(result.complete, false);
    assert.equal(result.durable, false);
    assert.equal(fixture.unsubscribeCalls(), 0);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
});

test("an absent service-worker registration removes orphaned push storage", async () => {
    const fixture = installFixture();

    fixture.setGetRegistration(async () => undefined);
    const result = await forgetLocalPushState(fixture.service);

    assert.equal(result.complete, true);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
});

test("an inactive registration is inspected without worker messaging", async () => {
    const fixture = installFixture();
    let workerMessages = 0;

    fixture.storage.clear();
    fixture.setActiveWorker(null);
    fixture.setGetSubscription(async () => null);
    fixture.setGetNotifications(async () => []);
    fixture.setWorkerReply(() => {
        workerMessages += 1;
    });

    assert.equal(await hasBrowserPushArtifacts(), false);
    assert.equal(workerMessages, 0);
});

test("an inactive registration with an orphaned push database remains fail-closed", async () => {
    const fixture = installFixture();

    fixture.storage.clear();
    fixture.setActiveWorker(null);
    fixture.setGetSubscription(async () => null);
    fixture.setGetNotifications(async () => []);
    await writeOrphanedPushConfig(fixture.indexedDB, {
        deliveryKey: ORPHAN_DELIVERY,
        generation: ORPHAN_GENERATION,
        managementKey: ORPHAN_MANAGEMENT,
        publicKey: "AQID",
    });

    assert.equal(await hasBrowserPushArtifacts(), true);
});

test("orphaned IndexedDB-only credentials are journaled, revoked, and deleted", async () => {
    const fixture = installFixture();

    fixture.storage.clear();
    fixture.setGetRegistration(async () => undefined);
    await writeOrphanedPushConfig(fixture.indexedDB, {
        deliveryKey: ORPHAN_DELIVERY,
        generation: ORPHAN_GENERATION,
        managementKey: ORPHAN_MANAGEMENT,
        publicKey: "AQID",
    });
    fixture.setGateway(async () => {
        const journal = JSON.parse(
            fixture.storage.getItem("sub-etha-push-cleanup-v1") ?? "{}",
        ) as Record<string, unknown>;

        assert.equal(journal.deliveryKey, ORPHAN_DELIVERY);
        assert.equal(journal.managementKey, ORPHAN_MANAGEMENT);
        assert.equal(journal.generation, ORPHAN_GENERATION);
        assert.equal(await orphanedPushDatabaseExists(fixture.indexedDB), true);

        return new Response(JSON.stringify({ removed: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    });

    const result = await forgetLocalPushState(fixture.service);

    assert.equal(result.complete, true);
    assert.deepEqual(fixture.gatewayDeletes, [ORPHAN_MANAGEMENT]);
    assert.deepEqual(fixture.removedPushers, [ORPHAN_DELIVERY]);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
    assert.equal(await orphanedPushDatabaseExists(fixture.indexedDB), false);
});

test("malformed or unreadable orphaned IndexedDB stays durably retryable without deletion", async () => {
    const malformed = installFixture();

    malformed.storage.clear();
    malformed.setGetRegistration(async () => undefined);
    await writeOrphanedPushConfig(malformed.indexedDB, {
        deliveryKey: ORPHAN_DELIVERY,
        managementKey: ORPHAN_MANAGEMENT,
        publicKey: "AQID",
        unexpected: true,
    });
    const malformedResult = await forgetLocalPushState(malformed.service);

    assert.equal(malformedResult.complete, false);
    assert.equal(malformedResult.durable, true);
    assert.equal(malformed.gatewayDeletes.length, 0);
    assert.equal(malformed.removedPushers.length, 0);
    assert.equal(await orphanedPushDatabaseExists(malformed.indexedDB), true);
    assert.ok(malformed.storage.getItem("sub-etha-push-cleanup-v1"));

    const unreadable = installFixture();
    const unreadableFactory = Object.create(unreadable.indexedDB) as IDBFactory;

    unreadable.storage.clear();
    unreadable.setGetRegistration(async () => undefined);
    await writeOrphanedPushConfig(unreadable.indexedDB, {
        deliveryKey: ORPHAN_DELIVERY,
        generation: ORPHAN_GENERATION,
        managementKey: ORPHAN_MANAGEMENT,
        publicKey: "AQID",
    });
    Object.defineProperties(unreadableFactory, {
        databases: {
            configurable: true,
            value: async () => [{ name: "sub-etha-push", version: 1 }],
        },
        open: {
            configurable: true,
            value: () => {
                throw new Error("orphaned database cannot be opened");
            },
        },
    });
    unreadable.setIndexedDB(unreadableFactory);
    const unreadableResult = await forgetLocalPushState(unreadable.service);

    assert.equal(unreadableResult.complete, false);
    assert.equal(unreadableResult.durable, true);
    assert.equal(unreadable.gatewayDeletes.length, 0);
    assert.equal(unreadable.removedPushers.length, 0);
    assert.equal(await orphanedPushDatabaseExists(unreadable.indexedDB), true);
    assert.ok(unreadable.storage.getItem("sub-etha-push-cleanup-v1"));
});

test("string-valued malformed orphan capabilities never reach remote cleanup", async () => {
    const fixture = installFixture();

    fixture.storage.clear();
    fixture.setGetRegistration(async () => undefined);
    await writeOrphanedPushConfig(fixture.indexedDB, {
        deliveryKey: "x",
        generation: "z",
        managementKey: "y",
        publicKey: "AQID",
    });

    const result = await forgetLocalPushState(fixture.service);
    const journal = fixture.storage.getItem("sub-etha-push-cleanup-v1") ?? "";

    assert.equal(result.complete, false);
    assert.equal(result.durable, true);
    assert.doesNotMatch(journal, /"(?:deliveryKey|managementKey|generation)":"[xyz]"/);
    assert.deepEqual(fixture.gatewayDeletes, []);
    assert.deepEqual(fixture.removedPushers, []);
    assert.equal(await orphanedPushDatabaseExists(fixture.indexedDB), true);
});

test("orphaned credentials are not revoked before their recovery journal persists", async () => {
    const fixture = installFixture();
    const write = fixture.storage.setItem.bind(fixture.storage);
    let cleanupJournalWrites = 0;

    fixture.storage.clear();
    fixture.setGetRegistration(async () => undefined);
    await writeOrphanedPushConfig(fixture.indexedDB, {
        deliveryKey: ORPHAN_DELIVERY,
        generation: ORPHAN_GENERATION,
        managementKey: ORPHAN_MANAGEMENT,
        publicKey: "AQID",
    });

    fixture.storage.setItem = (key, value) => {
        if (key === "sub-etha-push-cleanup-v1") {
            cleanupJournalWrites += 1;

            if (cleanupJournalWrites === 2) {
                throw new Error("recovered cleanup journal rejected");
            }
        }

        write(key, value);
    };

    const result = await forgetLocalPushState(fixture.service);

    assert.equal(result.complete, false);
    assert.equal(result.durable, true);
    assert.equal(fixture.gatewayDeletes.length, 0);
    assert.equal(fixture.removedPushers.length, 0);
    assert.equal(await orphanedPushDatabaseExists(fixture.indexedDB), true);
    assert.doesNotMatch(
        fixture.storage.getItem("sub-etha-push-cleanup-v1") ?? "",
        new RegExp(ORPHAN_MANAGEMENT),
    );
});

test("missing IndexedDB enumeration support fails closed without deleting orphaned state", async () => {
    const fixture = installFixture();
    const nonEnumeratingFactory = Object.create(fixture.indexedDB) as IDBFactory;

    fixture.storage.clear();
    fixture.setGetRegistration(async () => undefined);
    await writeOrphanedPushConfig(fixture.indexedDB, {
        deliveryKey: ORPHAN_DELIVERY,
        generation: ORPHAN_GENERATION,
        managementKey: ORPHAN_MANAGEMENT,
        publicKey: "AQID",
    });
    Object.defineProperty(nonEnumeratingFactory, "databases", {
        configurable: true,
        value: undefined,
    });
    fixture.setIndexedDB(nonEnumeratingFactory);
    const result = await forgetLocalPushState(fixture.service);

    assert.equal(result.complete, false);
    assert.equal(result.durable, true);
    assert.equal(fixture.gatewayDeletes.length, 0);
    assert.equal(fixture.removedPushers.length, 0);
    assert.equal(await orphanedPushDatabaseExists(fixture.indexedDB), true);
    assert.ok(fixture.storage.getItem("sub-etha-push-cleanup-v1"));
});

test("locked cleanup retains the Matrix pusher key until authenticated retry", async () => {
    const fixture = installFixture();

    fixture.setGetRegistration(async () => undefined);
    const lockedCleanup = await forgetLocalPushState();
    const marker = fixture.storage.getItem("sub-etha-push-cleanup-v1");

    assert.equal(lockedCleanup.complete, false);
    assert.match(marker ?? "", new RegExp(DELIVERY));
    assert.equal((JSON.parse(marker ?? "{}") as { pusherDone?: boolean }).pusherDone, false);
    assert.equal(hasLocalPushStateForCleanup(), true);
    assert.equal((await forgetLocalPushState(fixture.service)).complete, true);
});

test("explicit locked Forget completes after relay revocation with a pusher warning", async () => {
    const fixture = installFixture();

    fixture.setGetRegistration(async () => undefined);
    const cleanup = await forgetLocalPushState(undefined, {
        abandonMatrixPusherAfterGatewayCleanup: true,
    });

    assert.equal(cleanup.complete, true);
    assert.equal(cleanup.matrixPusherAbandoned, true);
    assert.equal(fixture.storage.getItem("sub-etha-matrix-pusher-abandoned-warning-v1"), "1");
    assert.equal(readAbandonedMatrixPusherWarning(), ABANDONED_MATRIX_PUSHER_WARNING);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);

    const laterDrain = await forgetLocalPushState(fixture.service);

    assert.equal(laterDrain.complete, true);
    assert.equal(laterDrain.matrixPusherAbandoned, true);

    clearAbandonedMatrixPusherWarning();
    assert.equal(readAbandonedMatrixPusherWarning(), null);
});

test("active logout confirms pusher removal without recording abandonment", async () => {
    const fixture = installFixture();

    fixture.setGetRegistration(async () => undefined);
    const cleanup = await forgetLocalPushState(fixture.service, {
        abandonMatrixPusherAfterGatewayCleanup: true,
    });

    assert.equal(cleanup.complete, true);
    assert.equal(cleanup.matrixPusherAbandoned, undefined);
    assert.equal(fixture.storage.getItem("sub-etha-matrix-pusher-abandoned-warning-v1"), null);
});

test("a blocked warning write preserves the cleanup journal until durable retry", async () => {
    const fixture = installFixture();
    const write = fixture.storage.setItem.bind(fixture.storage);

    fixture.setGetRegistration(async () => undefined);

    fixture.storage.setItem = (key, value) => {
        if (key === "sub-etha-matrix-pusher-abandoned-warning-v1") {
            throw new Error("warning storage blocked");
        }

        write(key, value);
    };

    const blocked = await forgetLocalPushState(undefined, {
        abandonMatrixPusherAfterGatewayCleanup: true,
    });
    const marker = fixture.storage.getItem("sub-etha-push-cleanup-v1");

    assert.equal(blocked.complete, false);
    assert.equal(blocked.matrixPusherAbandoned, true);
    assert.equal((JSON.parse(marker ?? "{}") as { pusherDone?: boolean }).pusherDone, false);
    assert.equal(readAbandonedMatrixPusherWarning(), ABANDONED_MATRIX_PUSHER_WARNING);

    fixture.storage.setItem = write;
    const retried = await forgetLocalPushState();

    assert.equal(retried.complete, true);
    assert.equal(retried.matrixPusherAbandoned, true);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
    assert.equal(fixture.storage.getItem("sub-etha-matrix-pusher-abandoned-warning-v1"), "1");
});

test("pusher-abandonment policy survives a failed gateway cleanup and reload", async () => {
    const fixture = installFixture();

    fixture.setGetRegistration(async () => undefined);
    fixture.setGateway(async () => {
        throw new Error("gateway unavailable");
    });
    const first = await forgetLocalPushState(undefined, {
        abandonMatrixPusherAfterGatewayCleanup: true,
    });

    assert.equal(first.complete, false);
    assert.match(
        fixture.storage.getItem("sub-etha-push-cleanup-v1") ?? "",
        /"allowPusherAbandonment":true/,
    );

    fixture.setGateway(
        async () =>
            new Response(JSON.stringify({ removed: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
    );
    const retry = await forgetLocalPushState();

    assert.equal(retry.complete, true);
    assert.equal(retry.matrixPusherAbandoned, true);
});

test("lock timeout leaves credentials as a durable reload cleanup gate", async () => {
    const fixture = installFixture();

    Object.defineProperty(globalThis.navigator, "locks", {
        configurable: true,
        value: {
            request: (_name: string, options: LockOptions) =>
                new Promise((_resolve, reject) => {
                    options.signal?.addEventListener(
                        "abort",
                        () => reject(options.signal?.reason ?? new Error("lock aborted")),
                        { once: true },
                    );
                }),
        },
    });
    const result = await forgetLocalPushState();

    assert.equal(result.complete, false);
    assert.equal(result.durable, true);
    assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), MANAGEMENT);
    assert.equal(hasLocalPushStateForCleanup(), true);
});

test("marker write failure leaves credentials as a durable reload cleanup gate", async () => {
    const fixture = installFixture();
    const write = fixture.storage.setItem.bind(fixture.storage);

    fixture.storage.setItem = (key, value) => {
        if (key === "sub-etha-push-lifecycle-epoch" || key === "sub-etha-push-cleanup-v1") {
            throw new Error("storage write rejected");
        }

        write(key, value);
    };

    const result = await forgetLocalPushState();

    assert.equal(result.complete, false);
    assert.equal(result.durable, false);
    assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), MANAGEMENT);
    assert.equal(hasLocalPushStateForCleanup(), true);
});

test("cleanup removes an in-flight subscription without clearing newer credentials", async () => {
    const fixture = installFixture();
    let release: (subscription: PushSubscription | null) => void = () => undefined;
    let started: () => void = () => undefined;
    const subscriptionLookupStarted = new Promise<void>((resolve) => {
        started = resolve;
    });

    fixture.setGetSubscription(
        () =>
            new Promise<PushSubscription | null>((resolve) => {
                started();
                release = resolve;
            }),
    );
    const cleanup = forgetLocalPushState();

    await subscriptionLookupStarted;
    fixture.storage.setItem("sub-etha-push-delivery-key", "delivery-new");
    fixture.storage.setItem("sub-etha-push-management-key", "management-new");
    fixture.storage.setItem("sub-etha-push-generation", "generation-new");
    fixture.storage.setItem("sub-etha-push-endpoint", "https://push.example/new");
    release(fixture.subscription);
    await cleanup;

    assert.equal(fixture.unsubscribeCalls(), 1);
    assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), "management-new");
});

type GatewayPostMode = "registered" | "pending" | "pending-always" | "response-lost";

function installPushSetupFixture() {
    const storage = memoryStorage();
    const gatewayPosts: Array<{
        deliveryKey: string;
        managementKey: string;
        generation: string;
    }> = [];
    const gatewayDeletes: string[] = [];
    const matrixPushers: string[] = [];
    const removedPushers: string[] = [];
    const operationOrder: string[] = [];
    const pageMessageListeners = new Set<(event: MessageEvent) => void>();
    let lockTail: Promise<unknown> = Promise.resolve();
    let liveSubscription = false;
    let gatewayPostMode: GatewayPostMode = "registered";
    let pageConfirmationDelivery = true;
    let gatewayDeleteFails = false;
    let removePusherFails = false;
    let pusherOperation: (pushKey: string) => Promise<void> = async () => undefined;
    let permissionOperation: () => Promise<void> = async () => undefined;
    let pausedLookup: { started: () => void; wait: Promise<void> } | undefined;
    let workerProtocolVersion: number | undefined = 2;
    let workerConfig: {
        deliveryKey: string;
        managementKey: string;
        generation: string;
        legacyGeneration?: boolean;
    } | null = null;
    const subscription = {
        endpoint: "https://push.example/setup",
        options: { applicationServerKey: Uint8Array.of(1, 2, 3).buffer },
        toJSON: () => ({
            endpoint: "https://push.example/setup",
            keys: { auth: "auth", p256dh: "p256dh" },
        }),
        unsubscribe: async () => {
            liveSubscription = false;

            return true;
        },
    } as unknown as PushSubscription;

    const getSubscription = async () => {
        const pause = pausedLookup;

        if (pause) {
            pausedLookup = undefined;
            pause.started();
            await pause.wait;
        }

        return liveSubscription ? subscription : null;
    };

    const worker = {
        postMessage(message: Record<string, unknown>, transfer?: Transferable[]) {
            const reply = transfer?.[0] as MessagePort | undefined;

            if (message.type === "SET_PUSH_CONFIG") {
                workerConfig = {
                    deliveryKey: String(message.deliveryKey),
                    managementKey: String(message.managementKey),
                    generation: String(message.generation),
                    legacyGeneration: false,
                };
                operationOrder.push("worker-set");
                reply?.postMessage({
                    ok: true,
                    ...(workerProtocolVersion === undefined
                        ? {}
                        : { protocolVersion: workerProtocolVersion }),
                });

                return;
            }

            if (message.type === "READ_PUSH_CONFIG") {
                reply?.postMessage({
                    ok: true,
                    ...(workerProtocolVersion === undefined
                        ? {}
                        : { protocolVersion: workerProtocolVersion }),
                    config: workerConfig,
                });

                return;
            }

            if (message.type === "MIGRATE_PUSH_CONFIG") {
                if (
                    workerConfig &&
                    workerConfig.managementKey === message.managementKey &&
                    (workerConfig.generation === workerConfig.managementKey ||
                        workerConfig.legacyGeneration === true)
                ) {
                    workerConfig = {
                        ...workerConfig,
                        generation: String(message.generation),
                        legacyGeneration: true,
                    };
                    reply?.postMessage({
                        ok: true,
                        ...(workerProtocolVersion === undefined
                            ? {}
                            : { protocolVersion: workerProtocolVersion }),
                        config: workerConfig,
                    });
                } else {
                    reply?.postMessage({
                        ok: false,
                        ...(workerProtocolVersion === undefined
                            ? {}
                            : { protocolVersion: workerProtocolVersion }),
                    });
                }

                return;
            }

            if (message.type === "CLEAR_PUSH_CONFIG") {
                const cleared =
                    workerConfig === null ||
                    (workerConfig.generation === message.generation &&
                        workerConfig.deliveryKey === message.deliveryKey);

                if (cleared) {
                    workerConfig = null;
                }

                reply?.postMessage({
                    ok: true,
                    ...(workerProtocolVersion === undefined
                        ? {}
                        : { protocolVersion: workerProtocolVersion }),
                    cleared,
                });
            }
        },
    } as ServiceWorker;
    const registration = {
        active: worker,
        getNotifications: async () => [],
        pushManager: {
            getSubscription,
            subscribe: async () => {
                liveSubscription = true;

                return subscription;
            },
        },
    } as unknown as ServiceWorkerRegistration;
    const notification = {
        permission: "granted" as NotificationPermission,
        requestPermission: async () => {
            await permissionOperation();

            return "granted" as NotificationPermission;
        },
    };
    const browserWindow = {
        Notification: notification,
        PushManager: class {},
        clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
        indexedDB: new IDBFactory(),
        location: { origin: "https://sub-etha.example" },
        setTimeout: (callback: TimerHandler) => globalThis.setTimeout(callback, 10),
    } as unknown as Window & typeof globalThis;
    const browserNavigator = {
        language: "en",
        clearAppBadge: async () => undefined,
        locks: {
            request: async (
                _name: string,
                _options: LockOptions,
                callback: (lock: Lock | null) => Promise<unknown>,
            ) => {
                const result = lockTail.then(() => callback(null));

                lockTail = result.then(
                    () => undefined,
                    () => undefined,
                );

                return result;
            },
        },
        serviceWorker: {
            addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
                if (type === "message") {
                    pageMessageListeners.add(listener);
                }
            },
            controller: worker,
            getRegistration: async () => registration,
            ready: Promise.resolve(registration),
            register: async () => registration,
            removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
                if (type === "message") {
                    pageMessageListeners.delete(listener);
                }
            },
        },
    } as unknown as Navigator;
    const service = {
        getClient: () => ({
            getPushers: async () => ({ pushers: [] }),
            setPusher: async ({ pushkey }: { pushkey: string }) => {
                matrixPushers.push(pushkey);
                await pusherOperation(pushkey);
            },
        }),
        removePusher: async (pushKey: string) => {
            removedPushers.push(pushKey);

            if (removePusherFails) {
                throw new Error("Matrix pusher removal unavailable");
            }
        },
    } as unknown as Parameters<typeof enablePush>[0];

    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: browserNavigator,
    });
    Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: notification,
    });
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: browserWindow.indexedDB,
    });
    globalThis.fetch = (async (_input, init) => {
        if (!init?.method) {
            return new Response(JSON.stringify({ publicKey: "AQID" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        const body = JSON.parse(String(init.body)) as {
            deliveryKey: string;
            managementKey: string;
            generation: string;
        };

        if (init.method === "POST") {
            gatewayPosts.push(body);
            operationOrder.push("gateway-post");

            if (gatewayPostMode === "response-lost") {
                throw new Error("gateway response lost after commit");
            }

            if (
                (gatewayPostMode === "pending" && gatewayPosts.length === 1) ||
                gatewayPostMode === "pending-always"
            ) {
                assert.equal(workerConfig?.generation, body.generation);

                if (gatewayPosts.length === 1 && pageConfirmationDelivery) {
                    queueMicrotask(() => {
                        for (const listener of pageMessageListeners) {
                            listener({
                                data: { type: "PUSH_SUBSCRIPTION_CONFIRMED" },
                            } as MessageEvent);
                        }
                    });
                }

                return new Response(JSON.stringify({ pending: true }), {
                    status: 202,
                    headers: { "Content-Type": "application/json" },
                });
            }

            return new Response(JSON.stringify({ registered: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        gatewayDeletes.push(body.managementKey);

        return new Response(
            JSON.stringify(
                gatewayDeleteFails ? { error: "gateway cleanup unavailable" } : { removed: true },
            ),
            {
                status: gatewayDeleteFails ? 503 : 200,
                headers: { "Content-Type": "application/json" },
            },
        );
    }) as typeof fetch;

    return {
        gatewayDeletes,
        gatewayPosts,
        matrixPushers,
        operationOrder,
        removedPushers,
        service,
        storage,
        pauseNextSubscriptionLookup: () => {
            let started: () => void = () => undefined;
            let release: () => void = () => undefined;
            const startedPromise = new Promise<void>((resolve) => {
                started = resolve;
            });
            const wait = new Promise<void>((resolve) => {
                release = resolve;
            });

            pausedLookup = { started, wait };

            return { started: startedPromise, release };
        },
        setGatewayDeleteFails: (value: boolean) => {
            gatewayDeleteFails = value;
        },
        setGatewayPostMode: (value: GatewayPostMode) => {
            gatewayPostMode = value;
        },
        setPageConfirmationDelivery: (value: boolean) => {
            pageConfirmationDelivery = value;
        },
        setWorkerProtocolVersion: (value: number | undefined) => {
            workerProtocolVersion = value;
        },
        setWorkerConfig: (
            config: {
                deliveryKey: string;
                managementKey: string;
                generation: string;
                legacyGeneration?: boolean;
            } | null,
        ) => {
            workerConfig = config;
        },
        setPermissionOperation: (operation: () => Promise<void>) => {
            permissionOperation = operation;
        },
        setPusherOperation: (operation: (pushKey: string) => Promise<void>) => {
            pusherOperation = operation;
        },
        setRemovePusherFails: (value: boolean) => {
            removePusherFails = value;
        },
    };
}

test("fresh enrollment installs provisional generation before a pending challenge", async () => {
    const fixture = installPushSetupFixture();

    fixture.setGatewayPostMode("pending");
    const state = await enablePush(fixture.service);

    assert.equal(state.enabled, true);
    assert.equal(fixture.gatewayPosts.length, 2);
    assert.ok(
        fixture.operationOrder.indexOf("worker-set") <
            fixture.operationOrder.indexOf("gateway-post"),
    );
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
});

test("fresh enrollment probes confirmed gateway state when the page message is lost", async () => {
    const fixture = installPushSetupFixture();

    fixture.setGatewayPostMode("pending");
    fixture.setPageConfirmationDelivery(false);
    const state = await enablePush(fixture.service);

    assert.equal(state.enabled, true);
    assert.equal(fixture.gatewayPosts.length, 2);
    assert.deepEqual(fixture.gatewayPosts[1], fixture.gatewayPosts[0]);
    assert.deepEqual(fixture.gatewayDeletes, []);
    assert.equal(fixture.matrixPushers.length, 1);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
});

test("a still-pending fallback fails once and runs durable cleanup", async () => {
    const fixture = installPushSetupFixture();

    fixture.setGatewayPostMode("pending-always");
    fixture.setPageConfirmationDelivery(false);

    await assert.rejects(enablePush(fixture.service), /was not confirmed/i);
    assert.equal(fixture.gatewayPosts.length, 2);
    assert.deepEqual(fixture.gatewayPosts[1], fixture.gatewayPosts[0]);
    assert.equal(fixture.gatewayDeletes.length, 1);
    assert.equal(fixture.storage.getItem("sub-etha-push-delivery-key"), null);
    assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), null);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
});

test("a worker without protocol-v2 acknowledgement leaves push lifecycle untouched", async () => {
    const fixture = installPushSetupFixture();

    fixture.setWorkerProtocolVersion(undefined);

    await assert.rejects(enablePush(fixture.service), /service-worker update/i);
    assert.equal(fixture.gatewayPosts.length, 0);
    assert.equal(fixture.matrixPushers.length, 0);
    assert.equal(fixture.operationOrder.includes("worker-set"), false);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
    assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), null);
});

test("refresh reports update-required without clearing an existing enrollment", async () => {
    const fixture = installPushSetupFixture();

    fixture.storage.setItem("sub-etha-push-delivery-key", "delivery-existing");
    fixture.storage.setItem("sub-etha-push-management-key", "management-existing");
    fixture.storage.setItem("sub-etha-push-generation", "generation-existing");
    fixture.setWorkerProtocolVersion(undefined);

    const state = await refreshPushState(fixture.service);

    assert.equal(state.enabled, false);
    assert.match(state.error ?? "", /service-worker update/i);
    assert.equal(fixture.storage.getItem("sub-etha-push-delivery-key"), "delivery-existing");
    assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), "management-existing");
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
    assert.equal(fixture.gatewayPosts.length, 0);
});

test("refresh canonicalizes a raw management-key enrollment before setup commit", async () => {
    const fixture = installPushSetupFixture();
    const generation = "b729659b8fdc79ab10f78094c0f4663891ec515af708cbe437c9a1d843564210";

    fixture.storage.setItem("sub-etha-push-delivery-key", "delivery-existing");
    fixture.storage.setItem("sub-etha-push-management-key", "management-existing");
    fixture.storage.setItem("sub-etha-push-generation", "management-existing");
    fixture.setWorkerConfig({
        deliveryKey: "delivery-existing",
        managementKey: "management-existing",
        generation: "management-existing",
    });

    const state = await refreshPushState(fixture.service);

    assert.equal(state.enabled, true);
    assert.equal(fixture.storage.getItem("sub-etha-push-generation"), generation);
    assert.equal(fixture.gatewayPosts[0]?.generation, generation);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
});

test("cleanup uses the canonical fence for a raw management-key enrollment", async () => {
    const fixture = installPushSetupFixture();

    fixture.storage.setItem("sub-etha-push-delivery-key", "delivery-existing");
    fixture.storage.setItem("sub-etha-push-management-key", "management-existing");
    fixture.storage.setItem("sub-etha-push-generation", "management-existing");
    fixture.setWorkerConfig({
        deliveryKey: "delivery-existing",
        managementKey: "management-existing",
        generation: "management-existing",
    });

    const result = await forgetLocalPushState(fixture.service);

    assert.equal(result.complete, true);
    assert.deepEqual(fixture.gatewayDeletes, ["management-existing"]);
    assert.deepEqual(fixture.removedPushers, ["delivery-existing"]);
    assert.equal(fixture.storage.getItem("sub-etha-push-generation"), null);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-v1"), null);
});

test("setup failure journals a canonical fence when local raw generation has no worker config", async () => {
    const fixture = installPushSetupFixture();
    const generation = "b729659b8fdc79ab10f78094c0f4663891ec515af708cbe437c9a1d843564210";

    fixture.storage.setItem("sub-etha-push-delivery-key", "delivery-existing");
    fixture.storage.setItem("sub-etha-push-management-key", "management-existing");
    fixture.storage.setItem("sub-etha-push-generation", "management-existing");
    fixture.setPusherOperation(async () => {
        throw new Error("setPusher failed");
    });
    fixture.setGatewayDeleteFails(true);
    fixture.setRemovePusherFails(true);

    await assert.rejects(enablePush(fixture.service), /setPusher failed/i);

    const marker = JSON.parse(fixture.storage.getItem("sub-etha-push-cleanup-v1") ?? "{}") as {
        generation?: string;
    };

    assert.equal(marker.generation, generation);
    assert.equal(fixture.storage.getItem("sub-etha-push-generation"), null);

    fixture.setGatewayDeleteFails(false);
    fixture.setRemovePusherFails(false);
    assert.equal((await forgetLocalPushState(fixture.service)).complete, true);
});

test("ambiguous gateway registration remains durably retryable", async () => {
    const fixture = installPushSetupFixture();

    fixture.setGatewayPostMode("response-lost");
    fixture.setGatewayDeleteFails(true);
    fixture.setRemovePusherFails(true);
    await assert.rejects(enablePush(fixture.service), /response lost/i);

    const managementKey = fixture.gatewayPosts[0]?.managementKey;
    const marker = fixture.storage.getItem("sub-etha-push-cleanup-v1");

    assert.ok(managementKey);
    assert.match(marker ?? "", new RegExp(managementKey));
    assert.equal(hasLocalPushStateForCleanup(), true);

    fixture.setGatewayDeleteFails(false);
    fixture.setRemovePusherFails(false);
    assert.equal((await forgetLocalPushState(fixture.service)).complete, true);
});

test("setPusher response loss and failed rollback retain both remote capabilities", async () => {
    const fixture = installPushSetupFixture();

    fixture.setPusherOperation(async () => {
        throw new Error("setPusher response lost");
    });
    fixture.setGatewayDeleteFails(true);
    fixture.setRemovePusherFails(true);
    await assert.rejects(enablePush(fixture.service), /setPusher response lost/i);

    const registered = fixture.gatewayPosts[0];
    const marker = fixture.storage.getItem("sub-etha-push-cleanup-v1");

    assert.ok(registered);
    assert.match(marker ?? "", new RegExp(registered.managementKey));
    assert.match(marker ?? "", new RegExp(registered.deliveryKey));
    assert.ok(fixture.gatewayDeletes.includes(registered.managementKey));
    assert.ok(fixture.removedPushers.includes(registered.deliveryKey));

    fixture.setGatewayDeleteFails(false);
    fixture.setRemovePusherFails(false);
    assert.equal((await forgetLocalPushState(fixture.service)).complete, true);
});

test("partial credential commit retains full keys and clears partial local state", async () => {
    const fixture = installPushSetupFixture();
    const write = fixture.storage.setItem.bind(fixture.storage);
    let rejectGeneration = true;

    fixture.storage.setItem = (key, value) => {
        if (key === "sub-etha-push-generation" && rejectGeneration) {
            rejectGeneration = false;

            throw new Error("credential quota exceeded");
        }

        write(key, value);
    };

    fixture.setGatewayDeleteFails(true);
    fixture.setRemovePusherFails(true);
    await assert.rejects(enablePush(fixture.service), /credential quota exceeded/i);

    const registered = fixture.gatewayPosts[0];
    const marker = fixture.storage.getItem("sub-etha-push-cleanup-v1");

    assert.ok(registered);
    assert.match(marker ?? "", new RegExp(registered.managementKey));
    assert.match(marker ?? "", new RegExp(registered.deliveryKey));
    assert.equal(fixture.storage.getItem("sub-etha-push-delivery-key"), null);
    assert.equal(fixture.storage.getItem("sub-etha-push-management-key"), null);

    fixture.setGatewayDeleteFails(false);
    fixture.setRemovePusherFails(false);
    assert.equal((await forgetLocalPushState(fixture.service)).complete, true);
    assert.equal(hasLocalPushStateForCleanup(), false);
});

test("concurrent enable calls serialize to one gateway and Matrix pusher", async () => {
    const fixture = installPushSetupFixture();
    let permissionCalls = 0;
    let releasePermissions: () => void = () => undefined;
    let bothPermissions: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        releasePermissions = resolve;
    });
    const both = new Promise<void>((resolve) => {
        bothPermissions = resolve;
    });

    fixture.setPermissionOperation(async () => {
        permissionCalls += 1;

        if (permissionCalls === 2) {
            bothPermissions();
        }

        await gate;
    });
    const first = enablePush(fixture.service);
    const second = enablePush(fixture.service);

    await both;
    releasePermissions();
    const results = await Promise.allSettled([first, second]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(fixture.gatewayPosts.length, 1);
    assert.equal(fixture.matrixPushers.length, 1);
    assert.equal(fixture.gatewayDeletes.length, 0);
});

test("cleanup intent aborts setup paused before subscription creation", async () => {
    const fixture = installPushSetupFixture();
    const pause = fixture.pauseNextSubscriptionLookup();
    const enabling = enablePush(fixture.service);

    await pause.started;
    const cleanup = forgetLocalPushState(fixture.service);

    pause.release();

    await assert.rejects(enabling, /cleanup started/i);
    assert.equal((await cleanup).complete, true);
    assert.equal(fixture.gatewayPosts.length, 0);
});

test("append-only cleanup intent survives the final synchronous setup commit", async () => {
    const fixture = installPushSetupFixture();
    const write = fixture.storage.setItem.bind(fixture.storage);
    let injectIntent = true;

    fixture.storage.setItem = (key, value) => {
        if (key === "sub-etha-push-delivery-key" && injectIntent) {
            injectIntent = false;
            write("sub-etha-push-cleanup-intent-v1", "other-tab-cleanup");
        }

        write(key, value);
    };

    const state = await enablePush(fixture.service);

    assert.equal(state.enabled, true);
    assert.equal(fixture.storage.getItem("sub-etha-push-cleanup-intent-v1"), "other-tab-cleanup");
    assert.equal(hasLocalPushStateForCleanup(), true);
    assert.equal((await forgetLocalPushState(fixture.service)).complete, true);
});
