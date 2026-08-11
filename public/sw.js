const CACHE_NAME = "sub-etha-shell-v6";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
const PUSH_DB = "sub-etha-push";
const PUSH_DB_VERSION = 2;
const PUSH_STORE = "settings";
const PUSH_CONFIG_KEY = "config-v2";
const SESSION_DB = "sub-etha-session";
const DEVICE_KEY_STORE = "keys";
const DEVICE_AES_KEY = "device-aead-v1";
const GENERIC_NOTIFICATION_TAG = "sub-etha-generic";
const TEST_NOTIFICATION_TAG = "sub-etha-test";
const PUSH_AAD =
    "sub-etha\u001fenvelope-v1\u001fsub-etha-push\u001fsettings\u001fpush-capabilities\u001fconfig-v2";

function notificationTag() {
    return GENERIC_NOTIFICATION_TAG;
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

async function dismissRoomNotification() {
    const notifications = await self.registration.getNotifications({
        tag: GENERIC_NOTIFICATION_TAG,
    });

    for (const notification of notifications) {
        notification.close();
    }
}

async function hasVisibleWindow() {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    return windows.some((client) => client.visibilityState === "visible");
}

function openDatabase(name, version, upgrade) {
    return new Promise((resolve, reject) => {
        const request =
            version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);

        request.onupgradeneeded = () => upgrade?.(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function requestValue(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function readPushConfig() {
    const [sessionDatabase, pushDatabase] = await Promise.all([
        openDatabase(SESSION_DB),
        openDatabase(PUSH_DB, PUSH_DB_VERSION, (database) => {
            if (!database.objectStoreNames.contains(PUSH_STORE)) {
                database.createObjectStore(PUSH_STORE);
            }
        }),
    ]);

    try {
        if (
            !sessionDatabase.objectStoreNames.contains(DEVICE_KEY_STORE) ||
            !pushDatabase.objectStoreNames.contains(PUSH_STORE)
        ) {
            return null;
        }

        const [aesKey, envelope] = await Promise.all([
            requestValue(
                sessionDatabase
                    .transaction(DEVICE_KEY_STORE)
                    .objectStore(DEVICE_KEY_STORE)
                    .get(DEVICE_AES_KEY),
            ),
            requestValue(
                pushDatabase.transaction(PUSH_STORE).objectStore(PUSH_STORE).get(PUSH_CONFIG_KEY),
            ),
        ]);

        if (
            !(aesKey instanceof CryptoKey) ||
            !envelope ||
            envelope.version !== 1 ||
            envelope.algorithm !== "AES-256-GCM" ||
            !(envelope.iv instanceof ArrayBuffer) ||
            envelope.iv.byteLength !== 12 ||
            !(envelope.ciphertext instanceof ArrayBuffer) ||
            envelope.ciphertext.byteLength > 16 * 1024 + 16
        ) {
            return null;
        }

        const plaintext = await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: new Uint8Array(envelope.iv),
                additionalData: new TextEncoder().encode(PUSH_AAD),
                tagLength: 128,
            },
            aesKey,
            envelope.ciphertext,
        );

        if (plaintext.byteLength > 16 * 1024) {
            return null;
        }

        const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));

        if (
            !config ||
            typeof config.deliveryKey !== "string" ||
            typeof config.managementKey !== "string" ||
            typeof config.publicKey !== "string"
        ) {
            return null;
        }

        return config;
    } catch {
        return null;
    } finally {
        sessionDatabase.close();
        pushDatabase.close();
    }
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

    if (event.data?.type === "DISMISS_ROOM_NOTIFICATION") {
        event.waitUntil(dismissRoomNotification());
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
                if (response.ok && url.pathname.match(/\.(?:js|css|png|ico|webmanifest)$/)) {
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
                        tag: test ? TEST_NOTIFICATION_TAG : notificationTag(),
                        renotify: test,
                        data: { kind },
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
    const target = new URL("#/", self.location.origin).href;

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
