import webpush from "web-push";
import { createPublicPushAgent, genericNotificationPayload, validPushEndpoint, validPushKey } from "./push-gateway";
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
const STALE_SUBSCRIPTION_SECONDS = 30 * 24 * 60 * 60;
const STALE_CLEANUP_BATCH = 500;
const TEN_MINUTES_SECONDS = 10 * 60;
const ONE_MINUTE_SECONDS = 60;
const RETRY_AFTER_SECONDS = 60;
const REGISTRATION_CHALLENGE_SECONDS = 10 * 60;
const publicPushAgent = createPublicPushAgent();

const BUDGET_SUBSCRIPTION_MUTATIONS = "subscription-mutations";
const BUDGET_TEST_SENDS = "test-sends";
const BUDGET_MATRIX_NOTIFY = "matrix-notify";
const BUDGET_OUTBOUND_DELIVERIES = "outbound-deliveries";

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

export interface PushLimits {
  maxSubscriptions: number;
  registrationPerTenMinutes: number;
  testsPerMinute: number;
  notifyPerMinute: number;
  deliveriesPerMinute: number;
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
  limits?: PushLimits;
}

type DeviceDeliveryResult = "sent" | "suppressed" | "rejected" | "transient";

function json(body: unknown, status = 200, additionalHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...Object.fromEntries(new Headers(additionalHeaders)),
    },
  });
}

type PushEnvironment = Readonly<Record<string, string | undefined>>;

function positiveIntegerEnvironment(environment: PushEnvironment, name: string, fallback: number): number {
  const raw = environment[name];
  if (!raw || !/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function pushLimitsFromEnvironment(environment: PushEnvironment): PushLimits {
  return {
    maxSubscriptions: positiveIntegerEnvironment(environment, "PUSH_MAX_SUBSCRIPTIONS", 10_000),
    registrationPerTenMinutes: positiveIntegerEnvironment(environment, "PUSH_REGISTRATION_LIMIT_PER_10M", 300),
    testsPerMinute: positiveIntegerEnvironment(environment, "PUSH_TEST_LIMIT_PER_MIN", 60),
    notifyPerMinute: positiveIntegerEnvironment(environment, "PUSH_NOTIFY_LIMIT_PER_MIN", 600),
    deliveriesPerMinute: positiveIntegerEnvironment(environment, "PUSH_DELIVERY_LIMIT_PER_MIN", 3_000),
  };
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
    { TTL: PUSH_TTL_SECONDS, urgency: "high", agent: publicPushAgent },
  );
}

function defaultLog(entry: Record<string, unknown>): void {
  console.info(JSON.stringify({ event: "push_gateway", ...entry }));
}

async function readJson<T>(request: Request): Promise<T> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
      throw new Response("Request body is too large.", { status: 413 });
    }
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel("Request body limit exceeded.").catch(() => undefined);
          throw new Response("Request body is too large.", { status: 413 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
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

async function hashCapability(capability: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  const limits = dependencies.limits ?? pushLimitsFromEnvironment(process.env);

  const configured = (): PushConfiguration | Response => configuration() ?? json({ error: "Web Push is not configured." }, 503);

  const consumeBudget = async (bucket: string, windowSeconds: number, limit: number): Promise<boolean> => {
    const allowed = await repository.consumeGlobalRateLimit(bucket, now(), windowSeconds, limit);
    if (!allowed) log({ route: "push-budget", status: 429, budgetCategory: bucket, allowed: false });
    return allowed;
  };

  const cleanupStaleSubscriptions = async (): Promise<number> => {
    const removed = await repository.cleanupSubscriptions(now() - STALE_SUBSCRIPTION_SECONDS, STALE_CLEANUP_BATCH);
    if (removed > 0) log({ route: "subscription-cleanup", status: 200, removedCount: removed });
    return removed;
  };

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
    const keyHash = await hashCapability(device.pushkey);
    const subscription = await repository.getSubscription(keyHash);
    if (!subscription) return "rejected";
    if (!validPushEndpoint(subscription.endpoint)) {
      await repository.deleteSubscriptionByDeliveryKey(keyHash);
      return "rejected";
    }
    const timestamp = now();
    if (!(await repository.consumeRateLimit(keyHash, timestamp, RATE_WINDOW_SECONDS, RATE_LIMIT))) return "suppressed";
    const eventId = typeof notification.event_id === "string" ? notification.event_id : null;
    if (eventId && !(await repository.claimDelivery(keyHash, eventId, timestamp, PENDING_DELIVERY_TIMEOUT_SECONDS))) {
      return "suppressed";
    }

    if (!(await consumeBudget(BUDGET_OUTBOUND_DELIVERIES, ONE_MINUTE_SECONDS, limits.deliveriesPerMinute))) {
      if (eventId) await repository.releaseDelivery(keyHash, eventId);
      return "transient";
    }

    try {
      await sendNotification(subscription, genericNotificationPayload(notification), pushConfiguration);
      await repository.markDelivered(keyHash, eventId, timestamp);
      return "sent";
    } catch (error) {
      const pushStatus = statusCode(error);
      if (pushStatus === 404 || pushStatus === 410) {
        await repository.deleteSubscriptionByDeliveryKey(keyHash);
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

        if (request.method === "PATCH") {
          const body = await readJson<{ challenge?: unknown }>(request);
          if (!validPushKey(body.challenge)) return json({ error: "Invalid push confirmation." }, 400);
          const outcome = await repository.confirmSubscription(
            await hashCapability(body.challenge),
            now(),
            limits.maxSubscriptions,
          );
          if (outcome === "invalid_challenge" || outcome === "expired_challenge") {
            return json({ error: "Push confirmation expired or was not recognized." }, 410);
          }
          if (outcome === "capacity_exceeded") {
            return json(
              { error: "Push subscription capacity is temporarily full." },
              503,
              { "Retry-After": String(RETRY_AFTER_SECONDS) },
            );
          }
          return json({ registered: true });
        }

        if (request.method === "DELETE") {
          const body = await readJson<{ managementKey?: unknown }>(request);
          if (!validPushKey(body.managementKey)) return json({ error: "Invalid push management key." }, 400);
          const managementKeyHash = await hashCapability(body.managementKey);
          if (!(await repository.getManagedSubscription(managementKeyHash))) {
            return json({ error: "Push subscription was not found." }, 404);
          }
          if (!(await consumeBudget(BUDGET_SUBSCRIPTION_MUTATIONS, TEN_MINUTES_SECONDS, limits.registrationPerTenMinutes))) {
            return json({ error: "Push subscription rate limit exceeded." }, 429);
          }
          await repository.deleteSubscription(managementKeyHash);
          return json({ removed: true });
        }

        const body = await readJson<{
          deliveryKey?: unknown;
          managementKey?: unknown;
          subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
        }>(request);
        const endpoint = body.subscription?.endpoint;
        const p256dh = body.subscription?.keys?.p256dh;
        const auth = body.subscription?.keys?.auth;
        if (
          !validPushKey(body.deliveryKey)
          || !validPushKey(body.managementKey)
          || body.deliveryKey === body.managementKey
          || !validPushEndpoint(endpoint)
          || typeof p256dh !== "string"
          || typeof auth !== "string"
        ) {
          return json({ error: "Invalid push subscription." }, 400);
        }
        if (p256dh.length > 256 || auth.length > 128) return json({ error: "Invalid push subscription keys." }, 400);
        if (!(await consumeBudget(BUDGET_SUBSCRIPTION_MUTATIONS, TEN_MINUTES_SECONDS, limits.registrationPerTenMinutes))) {
          return json({ error: "Push subscription rate limit exceeded." }, 429);
        }
        await cleanupStaleSubscriptions();
        const challenge = randomCapability();
        const challengeHash = await hashCapability(challenge);
        const outcome = await repository.beginSubscriptionRegistration(
          await hashCapability(body.deliveryKey),
          await hashCapability(body.managementKey),
          { endpoint, p256dh, auth },
          challengeHash,
          now(),
          now() + REGISTRATION_CHALLENGE_SECONDS,
          limits.maxSubscriptions,
          limits.registrationPerTenMinutes,
        );
        if (outcome === "active") return json({ registered: true });
        if (outcome === "management_conflict") {
          return json({ error: "The delivery identifier is already managed by another browser capability." }, 409);
        }
        if (outcome === "capacity_exceeded" || outcome === "pending_capacity_exceeded") {
          return json({ error: "Push subscription capacity is temporarily full." }, 503, { "Retry-After": String(RETRY_AFTER_SECONDS) });
        }
        if (!(await consumeBudget(BUDGET_OUTBOUND_DELIVERIES, ONE_MINUTE_SECONDS, limits.deliveriesPerMinute))) {
          await repository.cancelPendingRegistration(challengeHash);
          return json({ error: "Push confirmation capacity is temporarily busy." }, 429);
        }
        try {
          await sendNotification(
            { endpoint, p256dh, auth },
            JSON.stringify({ kind: "subscription-challenge", challenge }),
            pushConfiguration,
          );
          return json({ pending: true }, 202);
        } catch {
          await repository.cancelPendingRegistration(challengeHash);
          return json({ error: "The browser push endpoint could not be confirmed." }, 502);
        }
      });
    },

    testNotification(request: Request): Promise<Response> {
      return guarded("test", async () => {
        const pushConfiguration = configured();
        if (pushConfiguration instanceof Response) return pushConfiguration;
        assertSameOrigin(request);
        const body = await readJson<{ managementKey?: unknown }>(request);
        if (!validPushKey(body.managementKey)) return json({ error: "Invalid push management key." }, 400);
        const managementKeyHash = await hashCapability(body.managementKey);
        const subscription = await repository.getManagedSubscription(managementKeyHash);
        if (!subscription) return json({ error: "Push subscription was not found." }, 404);
        if (!validPushEndpoint(subscription.endpoint)) {
          await repository.deleteSubscription(managementKeyHash);
          return json({ error: "Push subscription is no longer valid." }, 410);
        }
        if (!(await consumeBudget(BUDGET_TEST_SENDS, ONE_MINUTE_SECONDS, limits.testsPerMinute))) {
          return json({ error: "Push test rate limit exceeded." }, 429);
        }
        const timestamp = now();
        if (!(await repository.consumeRateLimit(subscription.deliveryKeyHash, timestamp, RATE_WINDOW_SECONDS, RATE_LIMIT))) {
          return json({ error: "Push rate limit exceeded." }, 429);
        }
        if (!(await consumeBudget(BUDGET_OUTBOUND_DELIVERIES, ONE_MINUTE_SECONDS, limits.deliveriesPerMinute))) {
          return json({ error: "Push delivery rate limit exceeded." }, 429);
        }
        try {
          const payload = genericNotificationPayload({ event_id: `test-${timestamp}`, counts: { unread: 0 } }, "test");
          await sendNotification(subscription, payload, pushConfiguration);
          await repository.markDelivered(subscription.deliveryKeyHash, null, timestamp);
          return json({ sent: true });
        } catch (error) {
          const pushStatus = statusCode(error);
          if (pushStatus === 404 || pushStatus === 410) {
            await repository.deleteSubscription(managementKeyHash);
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
        if (!(await consumeBudget(BUDGET_MATRIX_NOTIFY, ONE_MINUTE_SECONDS, limits.notifyPerMinute))) {
          return json(
            { errcode: "M_UNKNOWN", error: "Push gateway is temporarily busy." },
            503,
            { "Retry-After": String(RETRY_AFTER_SECONDS) },
          );
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
        await cleanupStaleSubscriptions().catch(() => undefined);
        log({ route: "matrix-notify-summary", ...counts, deviceCount: devices.length });
        if (counts.transient > 0) {
          return json(
            { errcode: "M_UNKNOWN", error: "Some push deliveries failed temporarily." },
            503,
            { "Retry-After": String(RETRY_AFTER_SECONDS) },
          );
        }
        return json({ rejected });
      });
    },
  };
}

export const pushServer = createPushServer();
