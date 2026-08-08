/** Cloudflare Worker entry point for Sub-Etha and its privacy-minimal Matrix push gateway. */
import webpush from "web-push";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { genericNotificationPayload, validPushEndpoint, validPushKey } from "../lib/push-gateway";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface PushDevice {
  app_id?: string;
  pushkey?: string;
}

interface MatrixNotifyRequest {
  notification?: {
    event_id?: string;
    room_id?: string;
    counts?: { unread?: number; missed_calls?: number };
    devices?: PushDevice[];
  };
}

interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  rate_count: number;
  rate_window_start: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DEVICES_PER_REQUEST = 50;
const DELIVERY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT = 120;

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

async function readJson<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new Response("Request body is too large.", { status: 413 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Response("Request body is too large.", { status: 413 });
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Response("Request body must be valid JSON.", { status: 400 });
  }
}

function requireDatabase(env: Env): D1Database {
  if (!env.DB) throw new Response("Push storage is unavailable.", { status: 503 });
  return env.DB;
}

async function ensureSchema(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      push_key_hash TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_success_at INTEGER,
      rate_window_start INTEGER NOT NULL DEFAULT 0,
      rate_count INTEGER NOT NULL DEFAULT 0
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS idx_push_subscriptions_updated_at ON push_subscriptions(updated_at)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS push_deliveries (
      push_key_hash TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (push_key_hash, event_id)
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS idx_push_deliveries_updated_at ON push_deliveries(updated_at)"),
  ]);
}

async function hashPushKey(pushKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pushKey));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) throw new Response("Cross-origin subscription changes are not allowed.", { status: 403 });
}

async function registerSubscription(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request);
  const database = requireDatabase(env);
  await ensureSchema(database);
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
  const keyHash = await hashPushKey(body.pushKey);
  const now = Math.floor(Date.now() / 1000);
  await database.prepare(`INSERT INTO push_subscriptions
    (push_key_hash, endpoint, p256dh, auth, created_at, updated_at, rate_window_start, rate_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(push_key_hash) DO UPDATE SET
      endpoint = excluded.endpoint,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      updated_at = excluded.updated_at`)
    .bind(keyHash, endpoint, p256dh, auth, now, now, now)
    .run();
  return json({ registered: true });
}

async function deleteSubscription(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request);
  const database = requireDatabase(env);
  await ensureSchema(database);
  const body = await readJson<{ pushKey?: unknown }>(request);
  if (!validPushKey(body.pushKey)) return json({ error: "Invalid push key." }, 400);
  const keyHash = await hashPushKey(body.pushKey);
  await database.batch([
    database.prepare("DELETE FROM push_deliveries WHERE push_key_hash = ?").bind(keyHash),
    database.prepare("DELETE FROM push_subscriptions WHERE push_key_hash = ?").bind(keyHash),
  ]);
  return json({ removed: true });
}

async function consumeRateLimit(database: D1Database, keyHash: string, now: number): Promise<boolean> {
  await database.prepare(`UPDATE push_subscriptions SET
    rate_count = CASE WHEN rate_window_start <= ? THEN 1 ELSE rate_count + 1 END,
    rate_window_start = CASE WHEN rate_window_start <= ? THEN ? ELSE rate_window_start END
    WHERE push_key_hash = ?`)
    .bind(now - RATE_WINDOW_SECONDS, now - RATE_WINDOW_SECONDS, now, keyHash)
    .run();
  const row = await database.prepare("SELECT rate_count FROM push_subscriptions WHERE push_key_hash = ?")
    .bind(keyHash)
    .first<{ rate_count: number }>();
  return Boolean(row && row.rate_count <= RATE_LIMIT);
}

async function claimDelivery(database: D1Database, keyHash: string, eventId: string, now: number): Promise<boolean> {
  const inserted = await database.prepare(
    "INSERT OR IGNORE INTO push_deliveries (push_key_hash, event_id, status, updated_at) VALUES (?, ?, 'pending', ?)",
  ).bind(keyHash, eventId, now).run();
  if ((inserted.meta.changes ?? 0) > 0) return true;
  const existing = await database.prepare("SELECT status, updated_at FROM push_deliveries WHERE push_key_hash = ? AND event_id = ?")
    .bind(keyHash, eventId)
    .first<{ status: string; updated_at: number }>();
  if (!existing || existing.status === "sent" || existing.updated_at > now - 120) return false;
  await database.prepare("UPDATE push_deliveries SET updated_at = ? WHERE push_key_hash = ? AND event_id = ?")
    .bind(now, keyHash, eventId)
    .run();
  return true;
}

async function deliverToDevice(
  database: D1Database,
  device: PushDevice,
  notification: NonNullable<MatrixNotifyRequest["notification"]>,
): Promise<"sent" | "suppressed" | "rejected"> {
  if (!validPushKey(device.pushkey) || (device.app_id && device.app_id !== "chat.subetha.pwa")) return "rejected";
  const keyHash = await hashPushKey(device.pushkey);
  const subscription = await database.prepare(
    "SELECT endpoint, p256dh, auth, rate_count, rate_window_start FROM push_subscriptions WHERE push_key_hash = ?",
  ).bind(keyHash).first<StoredSubscription>();
  if (!subscription) return "rejected";
  const now = Math.floor(Date.now() / 1000);
  if (!(await consumeRateLimit(database, keyHash, now))) return "suppressed";
  if (notification.event_id && !(await claimDelivery(database, keyHash, notification.event_id, now))) return "suppressed";

  const payload = genericNotificationPayload(notification);
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload,
      { TTL: 60, urgency: "high" },
    );
    await database.batch([
      database.prepare("UPDATE push_subscriptions SET last_success_at = ?, updated_at = ? WHERE push_key_hash = ?")
        .bind(now, now, keyHash),
      ...(notification.event_id ? [database.prepare(
        "UPDATE push_deliveries SET status = 'sent', updated_at = ? WHERE push_key_hash = ? AND event_id = ?",
      ).bind(now, keyHash, notification.event_id)] : []),
    ]);
    return "sent";
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
    if (statusCode === 404 || statusCode === 410) {
      await database.batch([
        database.prepare("DELETE FROM push_deliveries WHERE push_key_hash = ?").bind(keyHash),
        database.prepare("DELETE FROM push_subscriptions WHERE push_key_hash = ?").bind(keyHash),
      ]);
      return "rejected";
    }
    if (notification.event_id) {
      await database.prepare("DELETE FROM push_deliveries WHERE push_key_hash = ? AND event_id = ? AND status = 'pending'")
        .bind(keyHash, notification.event_id)
        .run();
    }
    throw error;
  }
}

async function notify(request: Request, env: Env): Promise<Response> {
  const database = requireDatabase(env);
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return json({ error: "Web Push is not configured." }, 503);
  }
  await ensureSchema(database);
  const body = await readJson<MatrixNotifyRequest>(request);
  const notification = body.notification;
  const devices = notification?.devices;
  if (!notification || !Array.isArray(devices) || devices.length > MAX_DEVICES_PER_REQUEST) {
    return json({ errcode: "M_BAD_JSON", error: "Invalid Matrix notification." }, 400);
  }

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const rejected: string[] = [];
  for (const device of devices) {
    const result = await deliverToDevice(database, device, notification);
    if (result === "rejected" && typeof device.pushkey === "string") rejected.push(device.pushkey);
  }
  const cutoff = Math.floor(Date.now() / 1000) - DELIVERY_RETENTION_SECONDS;
  await database.prepare("DELETE FROM push_deliveries WHERE updated_at < ?").bind(cutoff).run();
  return json({ rejected });
}

async function routeRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/push/vapid-key" && request.method === "GET") {
    return env.VAPID_PUBLIC_KEY ? json({ publicKey: env.VAPID_PUBLIC_KEY }) : json({ error: "Web Push is not configured." }, 503);
  }
  if (url.pathname === "/api/push/subscriptions" && request.method === "POST") return registerSubscription(request, env);
  if (url.pathname === "/api/push/subscriptions" && request.method === "DELETE") return deleteSubscription(request, env);
  if (url.pathname === "/_matrix/push/v1/notify" && request.method === "POST") return notify(request, env);
  return null;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const routed = await routeRequest(request, env);
      if (routed) return routed;
    } catch (error) {
      if (error instanceof Response) return error;
      return json({ errcode: "M_UNKNOWN", error: "Push delivery failed." }, 502);
    }

    const url = new URL(request.url);
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
