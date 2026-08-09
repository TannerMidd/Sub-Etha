import webpush from "web-push";
import { genericNotificationPayload, validPushEndpoint, validPushKey } from "./push-gateway";
import { neonPushRepository, type PushRepository, type StoredPushSubscription } from "./push-repository";

const APP_ID = "chat.subetha.pwa";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DEVICES_PER_REQUEST = 50;
const DELIVERY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const PENDING_DELIVERY_TIMEOUT_SECONDS = 120;
const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT = 120;
const DELIVERY_CONCURRENCY = 8;
const PUSH_TTL_SECONDS = 60 * 60;

interface PushDevice {
  app_id?: unknown;
  pushkey?: unknown;
}

interface MatrixNotifyRequest {
  notification?: {
    event_id?: string;
    room_id?: string;
    counts?: { unread?: number; missed_calls?: number };
    devices?: PushDevice[];
  };
}

interface PushConfiguration {
  publicKey: string;
  privateKey: string;
  subject: string;
}

type PushSender = (
  subscription: StoredPushSubscription,
  payload: string,
  configuration: PushConfiguration,
) => Promise<void>;

interface PushServerDependencies {
  repository?: PushRepository;
  sendNotification?: PushSender;
  now?: () => number;
  configuration?: () => PushConfiguration | null;
  log?: (entry: Record<string, unknown>) => void;
}

type DeviceDeliveryResult = "sent" | "suppressed" | "rejected" | "transient";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function environmentConfiguration(): PushConfiguration | null {
  if (process.env.VERCEL_ENV === "preview") return null;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

async function defaultPushSender(
  subscription: StoredPushSubscription,
  payload: string,
  configuration: PushConfiguration,
): Promise<void> {
  webpush.setVapidDetails(configuration.subject, configuration.publicKey, configuration.privateKey);
  await webpush.sendNotification(
    { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
    payload,
    { TTL: PUSH_TTL_SECONDS, urgency: "high" },
  );
}

function defaultLog(entry: Record<string, unknown>): void {
  console.info(JSON.stringify({ event: "push_gateway", ...entry }));
}

async function readJson<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
    throw new Response("Request body is too large.", { status: 413 });
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Response("Request body is too large.", { status: 413 });
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Response("Request body must be valid JSON.", { status: 400 });
  }
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new Response("Cross-origin push changes are not allowed.", { status: 403 });
  }
}

function statusCode(error: unknown): number {
  return typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
}

async function hashPushKey(pushKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pushKey));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createPushServer(dependencies: PushServerDependencies = {}) {
  const repository = dependencies.repository ?? neonPushRepository;
  const sendNotification = dependencies.sendNotification ?? defaultPushSender;
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const configuration = dependencies.configuration ?? environmentConfiguration;
  const log = dependencies.log ?? defaultLog;

  const configured = (): PushConfiguration | Response => configuration() ?? json({ error: "Web Push is not configured." }, 503);

  const guarded = async (
    route: string,
    operation: () => Promise<Response>,
    startedAt = Date.now(),
  ): Promise<Response> => {
    try {
      const response = await operation();
      log({ route, status: response.status, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      if (error instanceof Response) {
        log({ route, status: error.status, durationMs: Date.now() - startedAt });
        return error;
      }
      log({ route, status: 502, result: "failed", durationMs: Date.now() - startedAt });
      return json({ error: "Push gateway operation failed." }, 502);
    }
  };

  const deliver = async (
    device: PushDevice,
    notification: NonNullable<MatrixNotifyRequest["notification"]>,
    pushConfiguration: PushConfiguration,
  ): Promise<DeviceDeliveryResult> => {
    if (device.app_id !== APP_ID || !validPushKey(device.pushkey)) return "rejected";
    const keyHash = await hashPushKey(device.pushkey);
    const subscription = await repository.getSubscription(keyHash);
    if (!subscription) return "rejected";
    const timestamp = now();
    if (!(await repository.consumeRateLimit(keyHash, timestamp, RATE_WINDOW_SECONDS, RATE_LIMIT))) return "suppressed";
    const eventId = typeof notification.event_id === "string" ? notification.event_id : null;
    if (eventId && !(await repository.claimDelivery(keyHash, eventId, timestamp, PENDING_DELIVERY_TIMEOUT_SECONDS))) {
      return "suppressed";
    }

    try {
      await sendNotification(subscription, genericNotificationPayload(notification), pushConfiguration);
      await repository.markDelivered(keyHash, eventId, timestamp);
      return "sent";
    } catch (error) {
      const pushStatus = statusCode(error);
      if (pushStatus === 404 || pushStatus === 410) {
        await repository.deleteSubscription(keyHash);
        return "rejected";
      }
      if (eventId) await repository.releaseDelivery(keyHash, eventId);
      return "transient";
    }
  };

  return {
    getVapidKey(): Promise<Response> {
      return guarded("vapid-key", async () => {
        const pushConfiguration = configured();
        if (pushConfiguration instanceof Response) return pushConfiguration;
        return json({ publicKey: pushConfiguration.publicKey });
      });
    },

    changeSubscription(request: Request): Promise<Response> {
      return guarded("subscriptions", async () => {
        const pushConfiguration = configured();
        if (pushConfiguration instanceof Response) return pushConfiguration;
        assertSameOrigin(request);
        if (request.method === "DELETE") {
          const body = await readJson<{ pushKey?: unknown }>(request);
          if (!validPushKey(body.pushKey)) return json({ error: "Invalid push key." }, 400);
          await repository.deleteSubscription(await hashPushKey(body.pushKey));
          return json({ removed: true });
        }

        const body = await readJson<{
          pushKey?: unknown;
          subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
        }>(request);
        const endpoint = body.subscription?.endpoint;
        const p256dh = body.subscription?.keys?.p256dh;
        const auth = body.subscription?.keys?.auth;
        if (!validPushKey(body.pushKey) || !validPushEndpoint(endpoint) || typeof p256dh !== "string" || typeof auth !== "string") {
          return json({ error: "Invalid push subscription." }, 400);
        }
        if (p256dh.length > 256 || auth.length > 128) return json({ error: "Invalid push subscription keys." }, 400);
        await repository.upsertSubscription(await hashPushKey(body.pushKey), { endpoint, p256dh, auth }, now());
        return json({ registered: true });
      });
    },

    testNotification(request: Request): Promise<Response> {
      return guarded("test", async () => {
        const pushConfiguration = configured();
        if (pushConfiguration instanceof Response) return pushConfiguration;
        assertSameOrigin(request);
        const body = await readJson<{ pushKey?: unknown }>(request);
        if (!validPushKey(body.pushKey)) return json({ error: "Invalid push key." }, 400);
        const keyHash = await hashPushKey(body.pushKey);
        const subscription = await repository.getSubscription(keyHash);
        if (!subscription) return json({ error: "Push subscription was not found." }, 404);
        const timestamp = now();
        if (!(await repository.consumeRateLimit(keyHash, timestamp, RATE_WINDOW_SECONDS, RATE_LIMIT))) {
          return json({ error: "Push rate limit exceeded." }, 429);
        }
        try {
          const payload = genericNotificationPayload({ event_id: `test-${timestamp}`, counts: { unread: 0 } }, "test");
          await sendNotification(subscription, payload, pushConfiguration);
          await repository.markDelivered(keyHash, null, timestamp);
          return json({ sent: true });
        } catch (error) {
          const pushStatus = statusCode(error);
          if (pushStatus === 404 || pushStatus === 410) {
            await repository.deleteSubscription(keyHash);
            return json({ error: "Push subscription expired." }, 410);
          }
          return json({ error: "The test notification could not be sent." }, 502);
        }
      });
    },

    notify(request: Request): Promise<Response> {
      return guarded("matrix-notify", async () => {
        const pushConfiguration = configured();
        if (pushConfiguration instanceof Response) return pushConfiguration;
        const body = await readJson<MatrixNotifyRequest>(request);
        const notification = body.notification;
        const devices = notification?.devices;
        if (!notification || !Array.isArray(devices) || devices.length > MAX_DEVICES_PER_REQUEST) {
          return json({ errcode: "M_BAD_JSON", error: "Invalid Matrix notification." }, 400);
        }

        const results = await mapWithConcurrency(devices, DELIVERY_CONCURRENCY, (device) => (
          deliver(device, notification, pushConfiguration)
        ));
        const rejected = devices.flatMap((device, index) => (
          results[index] === "rejected" && typeof device.pushkey === "string" ? [device.pushkey] : []
        ));
        const counts = results.reduce<Record<DeviceDeliveryResult, number>>((summary, result) => {
          summary[result] += 1;
          return summary;
        }, { sent: 0, suppressed: 0, rejected: 0, transient: 0 });
        await repository.cleanupDeliveries(now() - DELIVERY_RETENTION_SECONDS).catch(() => undefined);
        log({ route: "matrix-notify-summary", ...counts, deviceCount: devices.length });
        if (counts.transient > 0) {
          return json({ errcode: "M_UNKNOWN", error: "Some push deliveries failed temporarily." }, 502);
        }
        return json({ rejected });
      });
    },
  };
}

export const pushServer = createPushServer();
