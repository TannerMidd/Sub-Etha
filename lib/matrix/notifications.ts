import type { MatrixService } from "./client";
import { randomBase64Url } from "./session-store";
import type { PushState } from "./types";

const PUSH_KEY_STORAGE = "sub-etha-push-key";

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
    enabled: supported && Boolean(localStorage.getItem(PUSH_KEY_STORAGE)),
    permission: supported ? Notification.permission : "unsupported",
  };
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

async function gatewayRequest(method: "POST" | "DELETE", body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/push/subscriptions", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Push gateway returned ${response.status}.`);
  }
}

export async function enablePush(service: MatrixService): Promise<PushState> {
  const initial = readPushState();
  if (!initial.supported) return { ...initial, error: "This browser does not support Web Push." };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ...initial, permission, error: "Notification permission was not granted." };

  const registration = await registerServiceWorker();
  if (!registration) return { ...initial, error: "The service worker could not be registered." };
  const keyResponse = await fetch("/api/push/vapid-key", { headers: { Accept: "application/json" } });
  if (!keyResponse.ok) throw new Error("Closed-app notifications are not configured on this deployment yet.");
  const { publicKey } = await keyResponse.json() as { publicKey: string };
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
  const pushKey = localStorage.getItem(PUSH_KEY_STORAGE) || randomBase64Url(32);
  await gatewayRequest("POST", { pushKey, subscription: subscription.toJSON() });

  try {
    await service.getClient().setPusher({
      app_display_name: "Sub-Etha",
      app_id: "chat.subetha.pwa",
      append: false,
      data: {
        format: "event_id_only",
        url: `${window.location.origin}/_matrix/push/v1/notify`,
      },
      device_display_name: "Sub-Etha PWA",
      kind: "http",
      lang: navigator.language || "en",
      pushkey: pushKey,
    });
  } catch (error) {
    await gatewayRequest("DELETE", { pushKey }).catch(() => undefined);
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }

  localStorage.setItem(PUSH_KEY_STORAGE, pushKey);
  return { supported: true, enabled: true, permission: "granted" };
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
  localStorage.removeItem(PUSH_KEY_STORAGE);
  if ("clearAppBadge" in navigator) await navigator.clearAppBadge().catch(() => undefined);
  return readPushState();
}

export function getPushKey(): string | null {
  return localStorage.getItem(PUSH_KEY_STORAGE);
}
