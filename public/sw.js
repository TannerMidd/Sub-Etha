const CACHE_PREFIX = "sub-etha-";
const OFFLINE_CSP =
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const PUSH_DB = "sub-etha-push";
const PUSH_STORE = "settings";
const ROOM_NOTIFICATION_PREFIX = "sub-etha-room:";
const GENERIC_NOTIFICATION_TAG = "sub-etha-generic";
const TEST_NOTIFICATION_TAG = "sub-etha-test";
// Push configuration, badges, and stale-push compensation all share one queue.
// A badge API call cannot be cancelled once it has started, so configuration
// changes must wait for an in-flight call and then reconcile the badge before a
// newer generation can proceed.
let pushConfigMutation = Promise.resolve();

function notificationTag(roomId) {
    return roomId ? `${ROOM_NOTIFICATION_PREFIX}${roomId}` : GENERIC_NOTIFICATION_TAG;
}

async function syncBadge(unread) {
    const count = Number.isFinite(unread) ? Math.max(0, Math.trunc(unread)) : 0;

    try {
        if (count > 0) {
            if ("setAppBadge" in self.navigator) {
                await self.navigator.setAppBadge(count);
            }

            return;
        }

        if ("clearAppBadge" in self.navigator) {
            await self.navigator.clearAppBadge();
        }
    } catch {
        // Badging is best effort and must never prevent a notification.
    }
}

async function dismissRoomNotification(roomId) {
    if (!roomId) {
        return;
    }

    const notifications = await self.registration.getNotifications({
        tag: notificationTag(roomId),
    });

    for (const notification of notifications) {
        notification.close();
    }
}

async function dismissNotificationTag(tag, generation) {
    const notifications = await self.registration.getNotifications({ tag });

    for (const notification of notifications) {
        if (notification.data?.generation === generation) {
            notification.close();
        }
    }
}

async function hasVisibleWindow() {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    return windows.some((client) => client.visibilityState === "visible");
}

function openPushDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(PUSH_DB, 1);

        request.onupgradeneeded = () => request.result.createObjectStore(PUSH_STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function writePushConfig(value) {
    const database = await openPushDatabase();

    await new Promise((resolve, reject) => {
        const transaction = database.transaction(PUSH_STORE, "readwrite");
        const store = transaction.objectStore(PUSH_STORE);

        if (value) {
            store.put(value, "config");
        } else {
            store.delete("config");
        }

        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

async function readPushConfig() {
    const database = await openPushDatabase();
    const value = await new Promise((resolve, reject) => {
        const request = database.transaction(PUSH_STORE).objectStore(PUSH_STORE).get("config");

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });

    database.close();

    return value;
}

async function clearPushConfig(expectedGeneration, expectedDeliveryKey) {
    const database = await openPushDatabase();
    const cleared = await new Promise((resolve, reject) => {
        const transaction = database.transaction(PUSH_STORE, "readwrite");
        const store = transaction.objectStore(PUSH_STORE);
        const request = store.get("config");
        let matched = false;

        request.onsuccess = () => {
            const current = request.result;
            const generationMatches =
                typeof expectedGeneration === "string" &&
                current?.generation === expectedGeneration;
            const legacyDeliveryMatches =
                !current?.generation &&
                typeof expectedDeliveryKey === "string" &&
                current?.deliveryKey === expectedDeliveryKey;

            matched = !current || generationMatches || legacyDeliveryMatches;

            if (matched && current) {
                store.delete("config");
            }
        };

        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve(matched);
        transaction.onerror = () => reject(transaction.error);
    });

    database.close();

    return cleared;
}

function decodeApplicationServerKey(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function samePushConfig(left, right) {
    return Boolean(
        left &&
        right &&
        left.generation === right.generation &&
        left.deliveryKey === right.deliveryKey &&
        left.managementKey === right.managementKey,
    );
}

function queuePushConfigMutation(operation) {
    const queued = pushConfigMutation.catch(() => undefined).then(operation);

    pushConfigMutation = queued;

    return queued;
}

function setPushConfig(config) {
    return queuePushConfigMutation(async () => {
        const previous = await readPushConfig();

        await writePushConfig(config);

        // A replacement generation must never inherit the preceding account's
        // unread count. The next push for this generation will set its own value.
        if (previous && !samePushConfig(previous, config)) {
            await syncBadge(0);
        }
    });
}

function clearPushConfigForGeneration(expectedGeneration, expectedDeliveryKey) {
    return queuePushConfigMutation(async () => {
        const cleared = await clearPushConfig(expectedGeneration, expectedDeliveryKey);

        if (cleared) {
            // This is ordered after every badge write owned by the cleared
            // generation, and before a later generation can set its badge.
            await syncBadge(0);
        }

        return cleared;
    });
}

function syncBadgeForGeneration(config, unread) {
    return queuePushConfigMutation(async () => {
        const current = await readPushConfig();

        if (!samePushConfig(config, current)) {
            return;
        }

        await syncBadge(unread);

        // The queue prevents this worker's configuration mutations from
        // interleaving with the badge call. Recheck nevertheless so an
        // externally-observed config removal is compensated safely.
        const finalConfig = await readPushConfig();

        if (!samePushConfig(config, finalConfig) && !finalConfig) {
            await syncBadge(0);
        }
    });
}

function dismissStaleNotification(config, tag) {
    return queuePushConfigMutation(async () => {
        const current = await readPushConfig();

        if (!samePushConfig(config, current)) {
            await dismissNotificationTag(tag, config.generation);
        }
    });
}

function offlineNavigationResponse() {
    return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Offline</title></head><body><p>Sub-Etha is unavailable while offline.</p></body></html>',
        {
            status: 503,
            headers: {
                "Cache-Control": "no-store",
                "Content-Security-Policy": OFFLINE_CSP,
                "Content-Type": "text/html; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
            },
        },
    );
}

self.addEventListener("install", (event) => {
    // Installation is deliberately cache-free so an update cannot be blocked by optional assets.
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") {
        self.skipWaiting();
    }

    if (event.data?.type === "SET_PUSH_CONFIG") {
        event.waitUntil(
            setPushConfig({
                deliveryKey: event.data.deliveryKey,
                managementKey: event.data.managementKey,
                publicKey: event.data.publicKey,
                generation: event.data.generation,
            })
                .then(() => event.ports?.[0]?.postMessage({ ok: true }))
                .catch(() => event.ports?.[0]?.postMessage({ ok: false })),
        );
    }

    if (event.data?.type === "READ_PUSH_CONFIG") {
        event.waitUntil(
            readPushConfig()
                .then((config) =>
                    event.ports?.[0]?.postMessage({
                        ok: true,
                        config: config
                            ? {
                                  deliveryKey: config.deliveryKey,
                                  managementKey: config.managementKey,
                                  generation: config.generation ?? null,
                              }
                            : null,
                    }),
                )
                .catch(() => event.ports?.[0]?.postMessage({ ok: false })),
        );
    }

    if (event.data?.type === "CLEAR_PUSH_CONFIG") {
        event.waitUntil(
            clearPushConfigForGeneration(event.data.generation, event.data.deliveryKey)
                .then((cleared) => event.ports?.[0]?.postMessage({ ok: true, cleared }))
                .catch(() => event.ports?.[0]?.postMessage({ ok: false })),
        );
    }

    if (event.data?.type === "DISMISS_ROOM_NOTIFICATION") {
        event.waitUntil(dismissRoomNotification(event.data.roomId));
    }
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.allSettled(
                    keys
                        .filter((key) => key.startsWith(CACHE_PREFIX))
                        .map((key) => caches.delete(key)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (url.origin !== self.location.origin) {
        return;
    }

    if (event.request.mode === "navigate" || event.request.destination === "document") {
        event.respondWith(fetch(event.request).catch(() => offlineNavigationResponse()));

        return;
    }

    // Static assets use the browser's HTTP cache; the worker never stores or replays them.
});

self.addEventListener("push", (event) => {
    let payload = {};

    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }

    event.waitUntil(
        (async () => {
            if (
                payload.kind === "subscription-challenge" &&
                typeof payload.challenge === "string" &&
                typeof payload.generation === "string"
            ) {
                const config = await readPushConfig();

                if (config?.generation !== payload.generation) {
                    return;
                }

                const response = await fetch("/api/push/subscriptions", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ challenge: payload.challenge }),
                });

                if (!response.ok) {
                    throw new Error("Push subscription confirmation failed.");
                }

                const clients = await self.clients.matchAll({
                    type: "window",
                    includeUncontrolled: true,
                });

                for (const client of clients) {
                    client.postMessage({ type: "PUSH_SUBSCRIPTION_CONFIRMED" });
                }

                return;
            }

            const config = await readPushConfig();

            if (!config?.deliveryKey || !config?.managementKey || !config?.generation) {
                return;
            }

            const kind = payload.kind === "test" ? "test" : "matrix";
            const roomId = typeof payload.roomId === "string" ? payload.roomId : null;
            const eventId = typeof payload.eventId === "string" ? payload.eventId : null;
            const unread = Number(payload.unread || 0);
            const test = kind === "test";
            const visible = test ? false : await hasVisibleWindow();
            const current = await readPushConfig();

            if (!samePushConfig(config, current)) {
                return;
            }

            const operations = [];

            if (!visible) {
                operations.push(
                    self.registration.showNotification("Sub-Etha", {
                        body: test
                            ? "The test transmission arrived successfully."
                            : "A new transmission has arrived.",
                        icon: "/icon-192.png",
                        badge: "/icon-192.png",
                        tag: test ? TEST_NOTIFICATION_TAG : notificationTag(roomId),
                        renotify: test,
                        data: { kind, roomId, eventId, generation: config.generation },
                    }),
                );
            }

            if (!test) {
                operations.push(syncBadgeForGeneration(config, unread));
            }

            await Promise.all(operations);
            const finalConfig = await readPushConfig();

            if (!samePushConfig(config, finalConfig)) {
                const tag = test ? TEST_NOTIFICATION_TAG : notificationTag(roomId);

                await dismissStaleNotification(config, tag);
            }
        })(),
    );
});

self.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil(
        (async () => {
            const config = await readPushConfig();

            if (!config?.deliveryKey || !config?.managementKey || !config?.publicKey) {
                return;
            }

            const subscription = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: decodeApplicationServerKey(config.publicKey),
            });
            const current = await readPushConfig();

            if (!samePushConfig(config, current)) {
                await subscription.unsubscribe();

                return;
            }

            const response = await fetch("/api/push/subscriptions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    deliveryKey: config.deliveryKey,
                    managementKey: config.managementKey,
                    generation: config.generation,
                    subscription: subscription.toJSON(),
                }),
            });

            if (!response.ok) {
                throw new Error("Push subscription renewal failed.");
            }

            const confirmed = await readPushConfig();

            if (!samePushConfig(config, confirmed)) {
                await subscription.unsubscribe();
                await fetch("/api/push/subscriptions", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ managementKey: config.managementKey }),
                });
            }
        })(),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    const hash = data.roomId
        ? `#/room/${encodeURIComponent(data.roomId)}${data.eventId ? `/event/${encodeURIComponent(data.eventId)}` : ""}`
        : "#/";
    const target = new URL(hash, self.location.origin).href;

    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
            const client = clients[0];

            if (client) {
                client.navigate(target);

                return client.focus();
            }

            return self.clients.openWindow(target);
        }),
    );
});
