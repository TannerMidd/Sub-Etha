import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";

interface ShownNotification {
    title: string;
    options: {
        data?: {
            eventId?: string | null;
            generation?: string;
            kind?: string;
            roomId?: string | null;
        };
        renotify?: boolean;
        tag?: string;
    };
}

function createWorker(visible = false) {
    const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const shown: ShownNotification[] = [];
    const active = new Map<
        string,
        { close: () => void; data?: ShownNotification["options"]["data"] }
    >();
    const badgeSets: number[] = [];
    const clientMessages: unknown[] = [];
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const indexedDB = new IDBFactory();
    let badgeClears = 0;
    let badgeValue: number | null = null;
    let badgeWriteBarrier: Promise<void> | null = null;
    let badgeWriteStarted: (() => void) | null = null;
    let configured = false;
    let notificationBarrier: Promise<void> | null = null;
    let notificationStarted: (() => void) | null = null;
    let firstNotificationBarrier: Promise<void> | null = null;
    let firstNotificationStarted: (() => void) | null = null;
    let firstNotificationPending = false;
    let notificationLookupBarrier: Promise<void> | null = null;
    let notificationLookupStarted: (() => void) | null = null;
    let renewalInterleave: (() => Promise<void>) | null = null;

    const registration = {
        async getNotifications({ tag }: { tag?: string }) {
            notificationLookupStarted?.();

            if (notificationLookupBarrier) {
                await notificationLookupBarrier;
            }

            if (tag) {
                return active.has(tag) ? [active.get(tag)!] : [];
            }

            return [...active.values()];
        },
        pushManager: {
            async subscribe() {
                return {
                    endpoint: "https://push.example/renewed",
                    toJSON: () => ({
                        endpoint: "https://push.example/renewed",
                        keys: { auth: "auth", p256dh: "p256dh" },
                    }),
                };
            },
        },
        async showNotification(title: string, options: ShownNotification["options"]) {
            notificationStarted?.();

            if (notificationBarrier) {
                await notificationBarrier;
            }

            if (firstNotificationBarrier && firstNotificationPending) {
                firstNotificationPending = false;
                firstNotificationStarted?.();
                await firstNotificationBarrier;
            }

            shown.push({ title, options });
            const tag = options.tag ?? "";
            const notification = {
                data: options.data,
                close: () => {
                    if (active.get(tag) === notification) {
                        active.delete(tag);
                    }
                },
            };

            active.set(tag, notification);
        },
    };
    const worker = {
        addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
            handlers.set(type, handler);
        },
        clients: {
            async matchAll() {
                return [
                    {
                        visibilityState: visible ? "visible" : "hidden",
                        postMessage(message: unknown) {
                            clientMessages.push(message);
                        },
                    },
                ];
            },
        },
        crypto: globalThis.crypto,
        navigator: {
            async clearAppBadge() {
                badgeWriteStarted?.();

                if (badgeWriteBarrier) {
                    await badgeWriteBarrier;
                }

                badgeClears += 1;
                badgeValue = null;
            },
            async setAppBadge(count: number) {
                badgeWriteStarted?.();

                if (badgeWriteBarrier) {
                    await badgeWriteBarrier;
                }

                badgeSets.push(count);
                badgeValue = count;
            },
        },
        registration,
    };

    const workerFetch = async (input: string, init?: RequestInit) => {
        requests.push({ input, init });

        if (input === "/api/push/subscriptions" && init?.method === "POST") {
            const interleave = renewalInterleave;

            renewalInterleave = null;
            await interleave?.();
        }

        return new Response(null, { status: 200 });
    };

    vm.runInNewContext(source, {
        self: worker,
        console,
        Promise,
        URL,
        atob,
        caches: {},
        crypto: globalThis.crypto,
        fetch: workerFetch,
        indexedDB,
        TextEncoder,
    });

    const settle = async (type: string, event: Record<string, unknown>) => {
        const waits: Promise<unknown>[] = [];

        handlers.get(type)?.({
            ...event,
            waitUntil(value: Promise<unknown>) {
                waits.push(value);
            },
        });
        await Promise.all(waits);
    };

    const configure = async (generation = "generation-current", includeGeneration = true) => {
        let response: { ok?: boolean; protocolVersion?: number; cleared?: boolean } | undefined;

        await settle("message", {
            data: {
                type: "SET_PUSH_CONFIG",
                deliveryKey: "delivery-current",
                managementKey: "management-current",
                publicKey: "AQID",
                ...(includeGeneration ? { generation } : {}),
            },
            ports: [{ postMessage: (value: typeof response) => (response = value) }],
        });
        assert.equal(response?.ok, true);
        assert.equal(response?.protocolVersion, 2);
        configured = true;
    };

    const clearConfig = async (generation: string, deliveryKey = "delivery-current") => {
        let response: { ok?: boolean; protocolVersion?: number; cleared?: boolean } | undefined;

        await settle("message", {
            data: { type: "CLEAR_PUSH_CONFIG", generation, deliveryKey },
            ports: [{ postMessage: (value: typeof response) => (response = value) }],
        });

        return response;
    };

    const readConfig = async () => {
        let response:
            | {
                  ok?: boolean;
                  protocolVersion?: number;
                  config?: {
                      deliveryKey: string;
                      managementKey: string;
                      generation: string | null;
                      legacyGeneration?: boolean;
                  } | null;
              }
            | undefined;

        await settle("message", {
            data: { type: "READ_PUSH_CONFIG" },
            ports: [{ postMessage: (value: typeof response) => (response = value) }],
        });

        return response;
    };

    const migrateConfig = async (generation: string) => {
        let response: { ok?: boolean; protocolVersion?: number; config?: unknown } | undefined;

        await settle("message", {
            data: {
                type: "MIGRATE_PUSH_CONFIG",
                managementKey: "management-current",
                generation,
            },
            ports: [{ postMessage: (value: typeof response) => (response = value) }],
        });

        return response;
    };

    const seedRawLegacyConfig = async () => {
        await configure("generation-current", false);

        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("sub-etha-push");

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction("settings", "readwrite");

                transaction.objectStore("settings").put(
                    {
                        deliveryKey: "delivery-current",
                        managementKey: "management-current",
                        publicKey: "AQID",
                    },
                    "config",
                );

                transaction.oncomplete = () => {
                    database.close();
                    resolve();
                };

                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            };
        });
    };

    const rawPush = (payload: Record<string, unknown>) =>
        settle("push", { data: { json: () => payload } });

    const renew = () => settle("pushsubscriptionchange", {});

    const interleaveRenewalWithChallenge = () => {
        renewalInterleave = () =>
            rawPush({ kind: "subscription-challenge", challenge: "renewal-challenge" });
    };

    return {
        active,
        badgeClears: () => badgeClears,
        badgeSets,
        badgeValue: () => badgeValue,
        clientMessages,
        clearConfig,
        configure,
        dismiss: (roomId: string) =>
            settle("message", { data: { type: "DISMISS_ROOM_NOTIFICATION", roomId } }),
        interleaveRenewalWithChallenge,
        push: async (payload: Record<string, unknown>) => {
            if (payload.kind !== "subscription-challenge" && !configured) {
                await configure();
            }

            await rawPush(payload);
        },
        pauseNotificationDisplay: () => {
            let release: () => void = () => undefined;
            const started = new Promise<void>((resolve) => {
                notificationStarted = resolve;
            });

            notificationBarrier = new Promise<void>((resolve) => {
                release = resolve;
            });

            return {
                started,
                release: () => {
                    notificationBarrier = null;
                    notificationStarted = null;
                    release();
                },
            };
        },
        pauseFirstNotificationDisplay: () => {
            let release: () => void = () => undefined;
            const started = new Promise<void>((resolve) => {
                firstNotificationStarted = resolve;
            });

            firstNotificationBarrier = new Promise<void>((resolve) => {
                release = resolve;
            });
            firstNotificationPending = true;

            return {
                started,
                release: () => {
                    firstNotificationBarrier = null;
                    firstNotificationStarted = null;
                    firstNotificationPending = false;
                    release();
                },
            };
        },
        pauseBadgeWrite: () => {
            let release: () => void = () => undefined;
            const started = new Promise<void>((resolve) => {
                badgeWriteStarted = resolve;
            });

            badgeWriteBarrier = new Promise<void>((resolve) => {
                release = resolve;
            });

            return {
                started,
                release: () => {
                    badgeWriteBarrier = null;
                    badgeWriteStarted = null;
                    release();
                },
            };
        },
        pauseNotificationLookup: () => {
            let release: () => void = () => undefined;
            const started = new Promise<void>((resolve) => {
                notificationLookupStarted = resolve;
            });

            notificationLookupBarrier = new Promise<void>((resolve) => {
                release = resolve;
            });

            return {
                started,
                release: () => {
                    notificationLookupBarrier = null;
                    notificationLookupStarted = null;
                    release();
                },
            };
        },
        rawPush,
        readConfig,
        migrateConfig,
        renew,
        seedRawLegacyConfig,
        requests,
        shown,
    };
}

test("background Matrix pushes collapse to one notification per room", async () => {
    const worker = createWorker();

    await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$1", unread: 1 });
    await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$2", unread: 2 });
    assert.equal(worker.shown.length, 2);
    assert.equal(worker.shown[0].options.tag, worker.shown[1].options.tag);
    assert.equal(worker.shown[1].options.renotify, false);
    assert.equal(worker.active.size, 1);
    assert.deepEqual(worker.badgeSets, [1, 2]);

    await worker.push({ kind: "matrix", roomId: "!two:example", eventId: "$3", unread: 3 });
    assert.notEqual(worker.shown[1].options.tag, worker.shown[2].options.tag);
    assert.equal(worker.active.size, 2);
});

test("visible clients suppress Matrix notifications while badges remain accurate", async () => {
    const worker = createWorker(true);

    await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$1", unread: 4 });
    assert.equal(worker.shown.length, 0);
    assert.deepEqual(worker.badgeSets, [4]);

    await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$2", unread: 0 });
    assert.equal(worker.badgeClears(), 1);
});

test("test pushes always alert without changing the unread badge", async () => {
    const worker = createWorker(true);

    await worker.push({ kind: "test", roomId: null, eventId: "test-1", unread: 0 });
    assert.equal(worker.shown.length, 1);
    assert.equal(worker.shown[0].options.tag, "sub-etha-test");
    assert.equal(worker.shown[0].options.renotify, true);
    assert.deepEqual(worker.badgeSets, []);
    assert.equal(worker.badgeClears(), 0);
});

test("subscription challenges confirm silently through the service worker", async () => {
    const worker = createWorker();

    await worker.configure("generation-current");
    await worker.push({
        kind: "subscription-challenge",
        challenge: "challenge-token",
        generation: "generation-current",
    });
    assert.equal(worker.shown.length, 0);
    assert.deepEqual(worker.badgeSets, []);
    assert.equal(worker.requests.length, 1);
    assert.equal(worker.requests[0].input, "/api/push/subscriptions");
    assert.equal(worker.requests[0].init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(worker.requests[0].init?.body)), {
        challenge: "challenge-token",
    });
    assert.equal(
        JSON.stringify(worker.clientMessages),
        JSON.stringify([{ type: "PUSH_SUBSCRIPTION_CONFIRMED" }]),
    );
});

test("legacy push config migrates under the worker queue and accepts one legacy challenge", async () => {
    const worker = createWorker();
    const generation = "adebd246686c998f1a4d91b73fb811e171c4f30767b8fb28e1fa197b5f26f837";

    await worker.configure("generation-current", false);
    const legacy = await worker.readConfig();

    assert.equal(legacy?.protocolVersion, 2);
    assert.equal(legacy?.config?.generation, null);
    assert.equal(legacy?.config?.legacyGeneration, true);

    await worker.rawPush({ kind: "subscription-challenge", challenge: "legacy-challenge" });
    assert.equal(worker.requests.length, 1);

    const migrated = await worker.migrateConfig(generation);

    assert.equal(migrated?.ok, true);
    assert.equal(migrated?.protocolVersion, 2);
    const current = await worker.readConfig();

    assert.equal(current?.config?.generation, generation);
    assert.equal(current?.config?.legacyGeneration, true);

    await worker.rawPush({ kind: "matrix", roomId: "!legacy:example", eventId: "$legacy" });
    assert.equal(worker.shown.length, 1);

    await worker.renew();
    assert.equal(worker.requests.length, 2);
    assert.equal(worker.requests[1]?.init?.method, "POST");
    assert.equal(
        (JSON.parse(String(worker.requests[1]?.init?.body)) as { generation?: string }).generation,
        generation,
    );

    await worker.configure(generation);
    await worker.rawPush({ kind: "subscription-challenge", challenge: "strict-challenge" });
    assert.equal(worker.requests.length, 2);
});

test("a raw management-key generation is migrated before challenge and renewal", async () => {
    const worker = createWorker();
    const generation = "adebd246686c998f1a4d91b73fb811e171c4f30767b8fb28e1fa197b5f26f837";

    await worker.configure("management-current");
    const raw = await worker.readConfig();

    assert.equal(raw?.config?.generation, "management-current");
    assert.equal(raw?.config?.legacyGeneration, false);

    await worker.rawPush({ kind: "subscription-challenge", challenge: "raw-challenge" });
    assert.equal(worker.requests.length, 0);

    await worker.migrateConfig(generation);
    const migrated = await worker.readConfig();

    assert.equal(migrated?.config?.generation, generation);
    assert.equal(migrated?.config?.legacyGeneration, true);

    await worker.rawPush({ kind: "subscription-challenge", challenge: "migrated-challenge" });
    await worker.renew();
    assert.equal(worker.requests.length, 2);
    assert.equal(worker.requests[1]?.init?.method, "POST");
    assert.equal(
        (JSON.parse(String(worker.requests[1]?.init?.body)) as { generation?: string }).generation,
        generation,
    );
});

test("renewal serializes raw legacy migration before an interleaved omitted-generation challenge", async () => {
    const worker = createWorker();
    const generation = "adebd246686c998f1a4d91b73fb811e171c4f30767b8fb28e1fa197b5f26f837";

    await worker.seedRawLegacyConfig();
    worker.interleaveRenewalWithChallenge();
    await worker.renew();

    const config = await worker.readConfig();

    assert.equal(config?.config?.generation, generation);
    assert.equal(config?.config?.legacyGeneration, true);
    assert.equal(worker.requests[0]?.init?.method, "POST");
    assert.equal(worker.requests[1]?.init?.method, "PATCH");
    assert.equal(
        JSON.stringify(worker.clientMessages),
        JSON.stringify([{ type: "PUSH_SUBSCRIPTION_CONFIRMED" }]),
    );
});

test("a cleared generation cannot confirm a late subscription challenge", async () => {
    const worker = createWorker();

    await worker.configure("generation-current");
    assert.equal((await worker.clearConfig("generation-current"))?.cleared, true);
    await worker.rawPush({
        kind: "subscription-challenge",
        challenge: "challenge-token",
        generation: "generation-current",
    });

    assert.equal(worker.requests.length, 0);
    assert.equal(worker.clientMessages.length, 0);
});

test("opening a room dismisses its grouped notification", async () => {
    const worker = createWorker();

    await worker.push({ roomId: "!one:example", eventId: "$1", unread: 1 });
    assert.equal(worker.active.size, 1);
    await worker.dismiss("!one:example");
    assert.equal(worker.active.size, 0);
});

test("an older cleanup generation cannot clear a newer push configuration", async () => {
    const worker = createWorker();

    await worker.configure("generation-new");
    assert.equal((await worker.clearConfig("generation-old"))?.ok, true);
    assert.equal((await worker.clearConfig("generation-old"))?.cleared, false);
    await worker.rawPush({ kind: "matrix", roomId: "!safe:example", eventId: "$safe" });
    assert.equal(worker.shown.length, 1);

    const cleared = await worker.clearConfig("generation-new");

    assert.equal(cleared?.ok, true);
    assert.equal(cleared?.cleared, true);
    await worker.rawPush({ kind: "matrix", roomId: "!late:example", eventId: "$late" });
    assert.equal(worker.shown.length, 1);
});

test("a push display paused across cleanup cannot recreate a notification", async () => {
    const worker = createWorker();

    await worker.configure("generation-current");
    const paused = worker.pauseNotificationDisplay();
    const push = worker.rawPush({
        kind: "matrix",
        roomId: "!paused:example",
        eventId: "$paused",
    });

    await paused.started;
    worker.active.set("foreign-generation", {
        data: { generation: "foreign-generation" },
        close: () => worker.active.delete("foreign-generation"),
    });

    const cleanup = worker.clearConfig("generation-current");

    paused.release();
    assert.equal((await cleanup)?.cleared, true);
    await push;
    assert.equal(worker.active.size, 0);
});

test("a room dismissal waits for a generation-owned display", async () => {
    const worker = createWorker();

    await worker.configure("generation-current");
    const displayPaused = worker.pauseNotificationDisplay();
    const push = worker.rawPush({
        kind: "matrix",
        roomId: "!dismiss:example",
        eventId: "$dismiss",
    });

    await displayPaused.started;
    const dismissal = worker.dismiss("!dismiss:example");

    displayPaused.release();
    await Promise.all([push, dismissal]);
    assert.equal(worker.active.size, 0);
});

test("a paused old-generation badge cannot survive cleanup or erase the next generation", async () => {
    const worker = createWorker();

    await worker.configure("generation-old");
    const badgePaused = worker.pauseBadgeWrite();
    const oldPush = worker.rawPush({
        kind: "matrix",
        roomId: "!old:example",
        eventId: "$old",
        unread: 2,
    });

    await badgePaused.started;
    const cleanup = worker.clearConfig("generation-old");
    const configureNew = worker.configure("generation-new");

    badgePaused.release();
    await Promise.all([oldPush, cleanup, configureNew]);

    // The queued cleanup runs after the unavoidable old browser API call and
    // clears it before the new configuration is visible to later badge work.
    assert.equal(worker.badgeValue(), null);
    await worker.rawPush({
        kind: "matrix",
        roomId: "!new:example",
        eventId: "$new",
        unread: 9,
    });

    assert.equal(worker.badgeValue(), 9);
    assert.deepEqual(worker.badgeSets, [2, 9]);
    assert.equal(worker.badgeClears(), 1);
});

test("stale push compensation preserves a newer same-tag notification and badge", async () => {
    const worker = createWorker();

    await worker.configure("generation-old");
    const displayPaused = worker.pauseNotificationDisplay();
    const oldPush = worker.rawPush({
        kind: "matrix",
        roomId: "!same:example",
        eventId: "$old",
        unread: 2,
    });

    await displayPaused.started;
    const replacement = worker.configure("generation-new");

    displayPaused.release();
    await Promise.all([oldPush, replacement]);

    const newPush = worker.rawPush({
        kind: "matrix",
        roomId: "!same:example",
        eventId: "$new",
        unread: 9,
    });

    await newPush;

    assert.equal(worker.active.size, 1);
    assert.equal(worker.shown.length, 2);
    assert.equal(worker.shown[0].options.data?.generation, "generation-old");
    assert.equal(worker.shown[1].options.data?.generation, "generation-new");
    assert.equal([...worker.active.values()][0]?.data?.generation, "generation-new");
    assert.deepEqual(worker.badgeSets, [2, 9]);
    assert.equal(worker.badgeClears(), 1);
    assert.equal(worker.badgeValue(), 9);
});

test("replacing config drains the prior generation while push display is in flight", async () => {
    const worker = createWorker();

    await worker.configure("generation-old");
    await worker.rawPush({ kind: "matrix", roomId: "!replace:example", eventId: "$visible" });
    assert.equal(worker.active.size, 1);

    const displayPaused = worker.pauseNotificationDisplay();
    const inFlight = worker.rawPush({
        kind: "matrix",
        roomId: "!replace:example",
        eventId: "$in-flight",
    });

    await displayPaused.started;

    const replacement = worker.configure("generation-new");

    assert.equal(worker.active.size, 1);

    displayPaused.release();
    await replacement;
    assert.equal(worker.active.size, 0);

    await inFlight;
    assert.equal(worker.active.size, 0);

    await worker.rawPush({ kind: "matrix", roomId: "!replace:example", eventId: "$new" });
    assert.equal(worker.active.size, 1);
    assert.equal([...worker.active.values()][0]?.data?.generation, "generation-new");
});

test("serializes replacement behind an in-flight generation-owned display", async () => {
    const worker = createWorker();

    await worker.configure("generation-old");
    const displayPaused = worker.pauseFirstNotificationDisplay();
    const oldPush = worker.rawPush({
        kind: "matrix",
        roomId: "!same:example",
        eventId: "$old",
    });

    await displayPaused.started;

    let replacementFinished = false;
    const replacement = worker.configure("generation-new").then(() => {
        replacementFinished = true;
    });

    // A replacement must not pass the queued display. With the former
    // unqueued display, SET_PUSH_CONFIG could finish here and a new same-tag
    // notification could be displayed before this old show resumed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replacementFinished, false);

    displayPaused.release();
    await Promise.all([oldPush, replacement]);
    await worker.rawPush({
        kind: "matrix",
        roomId: "!same:example",
        eventId: "$new",
    });

    assert.equal(worker.active.size, 1);
    assert.equal([...worker.active.values()][0]?.data?.generation, "generation-new");
});
