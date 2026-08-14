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
    let notificationLookupBarrier: Promise<void> | null = null;
    let notificationLookupStarted: (() => void) | null = null;

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
        pushManager: {},
        async showNotification(title: string, options: ShownNotification["options"]) {
            notificationStarted?.();

            if (notificationBarrier) {
                await notificationBarrier;
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

        return new Response(null, { status: 200 });
    };

    vm.runInNewContext(source, {
        self: worker,
        console,
        Promise,
        URL,
        atob,
        caches: {},
        fetch: workerFetch,
        indexedDB,
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

    const configure = async (generation = "generation-current") => {
        let response: { ok?: boolean; cleared?: boolean } | undefined;

        await settle("message", {
            data: {
                type: "SET_PUSH_CONFIG",
                deliveryKey: "delivery-current",
                managementKey: "management-current",
                publicKey: "AQID",
                generation,
            },
            ports: [{ postMessage: (value: typeof response) => (response = value) }],
        });
        assert.equal(response?.ok, true);
        configured = true;
    };

    const clearConfig = async (generation: string, deliveryKey = "delivery-current") => {
        let response: { ok?: boolean; cleared?: boolean } | undefined;

        await settle("message", {
            data: { type: "CLEAR_PUSH_CONFIG", generation, deliveryKey },
            ports: [{ postMessage: (value: typeof response) => (response = value) }],
        });

        return response;
    };

    const rawPush = (payload: Record<string, unknown>) =>
        settle("push", { data: { json: () => payload } });

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
    assert.equal((await worker.clearConfig("generation-current"))?.cleared, true);
    paused.release();
    await push;
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
    await worker.configure("generation-new");
    const lookupPaused = worker.pauseNotificationLookup();

    displayPaused.release();
    await lookupPaused.started;

    const newPush = worker.rawPush({
        kind: "matrix",
        roomId: "!same:example",
        eventId: "$new",
        unread: 9,
    });

    lookupPaused.release();
    await newPush;
    await oldPush;

    assert.equal(worker.active.size, 1);
    assert.equal(worker.shown.length, 2);
    assert.equal(worker.shown[0].options.data?.generation, "generation-old");
    assert.equal(worker.shown[1].options.data?.generation, "generation-new");
    assert.equal([...worker.active.values()][0]?.data?.generation, "generation-new");
    assert.deepEqual(worker.badgeSets, [2, 9]);
    assert.equal(worker.badgeClears(), 1);
    assert.equal(worker.badgeValue(), 9);
});
