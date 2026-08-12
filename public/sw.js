const CACHE_NAME = "sub-etha-shell-v7";
const SHELL = [
    "/",
    "/manifest.webmanifest",
    "/icon-192.png",
    "/icon-512.png",
    "/fonts/commissioner-variable.ttf",
    "/fonts/literata-variable.ttf",
    "/fonts/literata-variable-italic.ttf",
];
const PUSH_DB = "sub-etha-push";
const PUSH_STORE = "settings";
const ROOM_NOTIFICATION_PREFIX = "sub-etha-room:";
const GENERIC_NOTIFICATION_TAG = "sub-etha-generic";
const TEST_NOTIFICATION_TAG = "sub-etha-test";

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

function decodeApplicationServerKey(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") {
        self.skipWaiting();
    }

    if (event.data?.type === "SET_PUSH_CONFIG") {
        event.waitUntil(
            writePushConfig({
                deliveryKey: event.data.deliveryKey,
                managementKey: event.data.managementKey,
                publicKey: event.data.publicKey,
            }),
        );
    }

    if (event.data?.type === "CLEAR_PUSH_CONFIG") {
        event.waitUntil(writePushConfig(null));
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
                Promise.all(
                    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (
        event.request.method !== "GET" ||
        url.origin !== self.location.origin ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/_matrix/") ||
        url.pathname.startsWith("/_vinext/")
    ) {
        return;
    }

    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request).catch(async () => (await caches.match("/")) || Response.error()),
        );

        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                return cached;
            }

            return fetch(event.request).then((response) => {
                if (
                    response.ok &&
                    url.pathname.match(/\.(?:js|css|png|ico|webmanifest|woff2?|ttf)$/)
                ) {
                    const copy = response.clone();

                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }

                return response;
            });
        }),
    );
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
                typeof payload.challenge === "string"
            ) {
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

            const kind = payload.kind === "test" ? "test" : "matrix";
            const roomId = typeof payload.roomId === "string" ? payload.roomId : null;
            const eventId = typeof payload.eventId === "string" ? payload.eventId : null;
            const unread = Number(payload.unread || 0);
            const test = kind === "test";
            const visible = test ? false : await hasVisibleWindow();
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
                        data: { kind, roomId, eventId },
                    }),
                );
            }

            if (!test) {
                operations.push(syncBadge(unread));
            }

            await Promise.all(operations);
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
            const response = await fetch("/api/push/subscriptions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    deliveryKey: config.deliveryKey,
                    managementKey: config.managementKey,
                    subscription: subscription.toJSON(),
                }),
            });

            if (!response.ok) {
                throw new Error("Push subscription renewal failed.");
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
