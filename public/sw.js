const CACHE_NAME = "sub-etha-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
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
  ) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match("/")) || Response.error()));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => {
    if (cached) return cached;
    return fetch(event.request).then((response) => {
      if (response.ok && url.pathname.match(/\.(?:js|css|png|ico|webmanifest)$/)) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    });
  }));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const unread = Number(payload.unread || 0);
  const options = {
    body: "A new transmission has arrived.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.eventId || "sub-etha-counts",
    renotify: Boolean(payload.eventId),
    data: { roomId: payload.roomId || null, eventId: payload.eventId || null },
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification("Sub-Etha", options),
    "setAppBadge" in self.navigator && unread > 0 ? self.navigator.setAppBadge(unread) : Promise.resolve(),
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const hash = data.roomId
    ? `#/room/${encodeURIComponent(data.roomId)}${data.eventId ? `/event/${encodeURIComponent(data.eventId)}` : ""}`
    : "#/";
  const target = new URL(hash, self.location.origin).href;

  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const client = clients[0];
    if (client) {
      client.navigate(target);
      return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
