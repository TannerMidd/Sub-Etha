import type { MatrixService } from "./client";
import { randomBase64Url } from "./session-store";
import type { PushState } from "./types";

const PUSH_KEY_STORAGE = "sub-etha-push-key";
const PUSH_APP_ID = "chat.subetha.pwa";
const LEGACY_PUSH_HOST_SUFFIX = ".chatgpt.site";

export function decodeApplicationServerKey(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function applicationServerKey(value: string): ArrayBuffer {
  const bytes = decodeApplicationServerKey(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function readPushState(): PushState {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return {
    supported,
    enabled: false,
    permission: supported ? Notification.permission : "unsupported",
    checking: supported,
  };
}

export function totalUnreadCount(rooms: ReadonlyArray<{ unread: number }>): number {
  return rooms.reduce((total, room) => total + (Number.isFinite(room.unread) ? Math.max(0, Math.trunc(room.unread)) : 0), 0);
}

export async function syncAppBadge(unread: number): Promise<void> {
  const count = Number.isFinite(unread) ? Math.max(0, Math.trunc(unread)) : 0;
  if (count > 0) {
    if ("setAppBadge" in navigator) {
      await navigator.setAppBadge(count).catch(() => undefined);
    }
    return;
  }
  if ("clearAppBadge" in navigator) {
    await navigator.clearAppBadge().catch(() => undefined);
  }
}

export async function dismissRoomNotification(roomId: string): Promise<void> {
  if (!("serviceWorker" in navigator) || !roomId) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const worker = registration?.active ?? navigator.serviceWorker.controller;
  worker?.postMessage({ type: "DISMISS_ROOM_NOTIFICATION", roomId });
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

async function gatewayRequest(
  method: "POST" | "DELETE",
  body: Record<string, unknown>,
  path = "/api/push/subscriptions",
): Promise<void> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    const message = payload?.error;
    throw new Error(message || `Push gateway returned ${response.status}.`);
  }
}

async function publicVapidKey(): Promise<string> {
  const response = await fetch("/api/push/vapid-key", { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error("Closed-app notifications are not configured on this deployment yet.");
  const { publicKey } = await response.json() as { publicKey?: unknown };
  if (typeof publicKey !== "string" || !publicKey) throw new Error("The push gateway returned an invalid application key.");
  return publicKey;
}

export function pushSubscriptionNeedsRepair(
  subscription: Pick<PushSubscription, "options"> | null,
  publicKey: string,
): boolean {
  if (!subscription) return true;
  const current = subscription.options.applicationServerKey;
  if (!current) return true;
  const currentBytes = new Uint8Array(current);
  const expectedBytes = decodeApplicationServerKey(publicKey);
  return currentBytes.length !== expectedBytes.length || currentBytes.some((value, index) => value !== expectedBytes[index]);
}

function configureServiceWorker(registration: ServiceWorkerRegistration, pushKey: string, publicKey: string): void {
  registration.active?.postMessage({ type: "SET_PUSH_CONFIG", pushKey, publicKey });
}

function clearServiceWorkerPushConfig(registration: ServiceWorkerRegistration | null): void {
  registration?.active?.postMessage({ type: "CLEAR_PUSH_CONFIG" });
}

async function currentSubscription(registration: ServiceWorkerRegistration, publicKey: string, repair: boolean): Promise<PushSubscription | null> {
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && pushSubscriptionNeedsRepair(subscription, publicKey)) {
    await subscription.unsubscribe().catch(() => undefined);
    subscription = null;
  }
  if (!subscription && repair) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });
  }
  return subscription;
}

export function isLegacySitesPusher(pusher: { app_id?: string; data?: { url?: string } }): boolean {
  if (pusher.app_id !== PUSH_APP_ID || typeof pusher.data?.url !== "string") return false;
  try {
    return new URL(pusher.data.url).hostname.endsWith(LEGACY_PUSH_HOST_SUFFIX);
  } catch {
    return false;
  }
}

async function removeLegacySitesPushers(service: MatrixService): Promise<void> {
  const { pushers } = await service.getClient().getPushers();
  await Promise.allSettled(pushers.filter(isLegacySitesPusher).map((pusher) => service.removePusher(pusher.pushkey)));
}

function currentPusherUrl(): string {
  return `${window.location.origin}/_matrix/push/v1/notify`;
}

async function registerMatrixPusher(service: MatrixService, pushKey: string): Promise<void> {
  await service.getClient().setPusher({
    app_display_name: "Sub-Etha",
    app_id: PUSH_APP_ID,
    append: false,
    data: {
      format: "event_id_only",
      url: currentPusherUrl(),
    },
    device_display_name: "Sub-Etha PWA",
    kind: "http",
    lang: navigator.language || "en",
    pushkey: pushKey,
  });
}

async function reconcileMatrixPusher(service: MatrixService, pushKey: string): Promise<void> {
  const expectedUrl = currentPusherUrl();
  const { pushers } = await service.getClient().getPushers();
  const current = pushers.some((pusher) => (
    pusher.app_id === PUSH_APP_ID &&
    pusher.pushkey === pushKey &&
    pusher.kind === "http" &&
    pusher.data?.format === "event_id_only" &&
    pusher.data?.url === expectedUrl
  ));
  if (!current) await registerMatrixPusher(service, pushKey);
}

export async function refreshPushState(service: MatrixService): Promise<PushState> {
  const initial = readPushState();
  if (!initial.supported) return { ...initial, checking: false };
  const pushKey = localStorage.getItem(PUSH_KEY_STORAGE);
  if (!pushKey || Notification.permission !== "granted") {
    if (pushKey) await service.removePusher(pushKey).catch(() => undefined);
    if (pushKey) await gatewayRequest("DELETE", { pushKey }).catch(() => undefined);
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe().catch(() => undefined);
    clearServiceWorkerPushConfig(registration);
    localStorage.removeItem(PUSH_KEY_STORAGE);
    return { supported: true, enabled: false, permission: Notification.permission, checking: false };
  }

  try {
    const registration = await registerServiceWorker();
    if (!registration) return { ...initial, checking: false, error: "The service worker could not be registered." };
    const publicKey = await publicVapidKey();
    const subscription = await currentSubscription(registration, publicKey, true);
    if (!subscription) return { ...initial, checking: false, error: "The browser push subscription is unavailable." };
    await gatewayRequest("POST", { pushKey, subscription: subscription.toJSON() });
    await reconcileMatrixPusher(service, pushKey);
    configureServiceWorker(registration, pushKey, publicKey);
    await removeLegacySitesPushers(service).catch(() => undefined);
    return { supported: true, enabled: true, permission: "granted", checking: false };
  } catch (error) {
    return {
      supported: true,
      enabled: false,
      permission: Notification.permission,
      checking: false,
      error: error instanceof Error ? error.message : "Closed-app notifications could not be verified.",
    };
  }
}

export async function enablePush(service: MatrixService): Promise<PushState> {
  const initial = readPushState();
  if (!initial.supported) return { ...initial, checking: false, error: "This browser does not support Web Push." };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ...initial, permission, checking: false, error: "Notification permission was not granted." };

  const registration = await registerServiceWorker();
  if (!registration) return { ...initial, checking: false, error: "The service worker could not be registered." };
  const publicKey = await publicVapidKey();
  const subscription = await currentSubscription(registration, publicKey, true);
  if (!subscription) throw new Error("The browser push subscription is unavailable.");
  const pushKey = localStorage.getItem(PUSH_KEY_STORAGE) || randomBase64Url(32);
  await gatewayRequest("POST", { pushKey, subscription: subscription.toJSON() });

  try {
    await registerMatrixPusher(service, pushKey);
  } catch (error) {
    await gatewayRequest("DELETE", { pushKey }).catch(() => undefined);
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }

  localStorage.setItem(PUSH_KEY_STORAGE, pushKey);
  configureServiceWorker(registration, pushKey, publicKey);
  await removeLegacySitesPushers(service).catch(() => undefined);
  return { supported: true, enabled: true, permission: "granted", checking: false };
}

export async function disablePush(service: MatrixService): Promise<PushState> {
  const pushKey = localStorage.getItem(PUSH_KEY_STORAGE);
  if (pushKey) {
    await service.removePusher(pushKey).catch(() => undefined);
    await gatewayRequest("DELETE", { pushKey }).catch(() => undefined);
  }
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.ready.catch(() => null) : null;
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe().catch(() => undefined);
  clearServiceWorkerPushConfig(registration);
  localStorage.removeItem(PUSH_KEY_STORAGE);
  await syncAppBadge(0);
  return { supported: true, enabled: false, permission: Notification.permission, checking: false };
}

export async function sendTestPush(): Promise<void> {
  const pushKey = localStorage.getItem(PUSH_KEY_STORAGE);
  if (!pushKey) throw new Error("Enable closed-app notifications before sending a test.");
  await gatewayRequest("POST", { pushKey }, "/api/push/test");
}

export function getPushKey(): string | null {
  return localStorage.getItem(PUSH_KEY_STORAGE);
}
