import assert from "node:assert/strict";
import test from "node:test";
import type { PushRepository, StoredPushSubscription } from "../lib/push-repository";
import { createPushServer } from "../lib/push-server";

const ORIGIN = "https://sub-etha-matrix.vercel.app";
const PUSH_KEY = "a".repeat(40);
const SUBSCRIPTION: StoredPushSubscription = {
  endpoint: "https://updates.push.services.mozilla.com/wpush/v2/example",
  p256dh: "p256dh",
  auth: "auth",
};

class MemoryPushRepository implements PushRepository {
  subscriptions = new Map<string, StoredPushSubscription>();
  deliveries = new Set<string>();
  deleted = 0;
  released = 0;
  allowRate = true;
  returnAnySubscription = false;

  async upsertSubscription(pushKeyHash: string, subscription: StoredPushSubscription): Promise<void> {
    this.subscriptions.set(pushKeyHash, subscription);
  }

  async deleteSubscription(pushKeyHash: string): Promise<void> {
    this.subscriptions.delete(pushKeyHash);
    this.deleted += 1;
  }

  async getSubscription(pushKeyHash: string): Promise<StoredPushSubscription | null> {
    return this.subscriptions.get(pushKeyHash) ?? (this.returnAnySubscription ? SUBSCRIPTION : null);
  }

  async consumeRateLimit(): Promise<boolean> {
    return this.allowRate;
  }

  async claimDelivery(pushKeyHash: string, eventId: string): Promise<boolean> {
    const key = `${pushKeyHash}:${eventId}`;
    if (this.deliveries.has(key)) return false;
    this.deliveries.add(key);
    return true;
  }

  async markDelivered(): Promise<void> {}

  async releaseDelivery(pushKeyHash: string, eventId: string): Promise<void> {
    this.deliveries.delete(`${pushKeyHash}:${eventId}`);
    this.released += 1;
  }

  async cleanupDeliveries(): Promise<void> {}
}

function configuredServer(
  repository: MemoryPushRepository,
  sender: (subscription: StoredPushSubscription, payload: string) => Promise<void> = async () => undefined,
  logs: Array<Record<string, unknown>> = [],
) {
  return createPushServer({
    repository,
    sendNotification: sender,
    configuration: () => ({ publicKey: "public", privateKey: "private", subject: ORIGIN }),
    now: () => 1_800_000_000,
    log: (entry) => logs.push(entry),
  });
}

function subscriptionRequest(method: "POST" | "DELETE", body: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/push/subscriptions`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

function notifyRequest(devices: unknown[], eventId = "$event"): Request {
  return new Request(`${ORIGIN}/_matrix/push/v1/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notification: { event_id: eventId, room_id: "!room:example", devices } }),
  });
}

test("push subscriptions enforce same-origin registration and support deletion", async () => {
  const repository = new MemoryPushRepository();
  const server = configuredServer(repository);
  const blocked = await server.changeSubscription(subscriptionRequest("POST", {
    pushKey: PUSH_KEY,
    subscription: { ...SUBSCRIPTION, keys: { p256dh: SUBSCRIPTION.p256dh, auth: SUBSCRIPTION.auth } },
  }, "https://attacker.example"));
  assert.equal(blocked.status, 403);

  const registered = await server.changeSubscription(subscriptionRequest("POST", {
    pushKey: PUSH_KEY,
    subscription: {
      endpoint: SUBSCRIPTION.endpoint,
      keys: { p256dh: SUBSCRIPTION.p256dh, auth: SUBSCRIPTION.auth },
    },
  }));
  assert.equal(registered.status, 200);
  assert.equal(repository.subscriptions.size, 1);

  const removed = await server.changeSubscription(subscriptionRequest("DELETE", { pushKey: PUSH_KEY }));
  assert.equal(removed.status, 200);
  assert.equal(repository.subscriptions.size, 0);
});

test("push gateway rejects oversized requests before reading JSON", async () => {
  const server = configuredServer(new MemoryPushRepository());
  const response = await server.notify(new Request(`${ORIGIN}/_matrix/push/v1/notify`, {
    method: "POST",
    headers: { "Content-Length": "70000" },
    body: "{}",
  }));
  assert.equal(response.status, 413);
});

test("Matrix notify rejects unknown devices without exposing notification content to logs", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const server = configuredServer(new MemoryPushRepository(), async () => undefined, logs);
  const response = await server.notify(notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rejected: [PUSH_KEY] });
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(PUSH_KEY), false);
  assert.equal(serialized.includes("!room:example"), false);
  assert.equal(serialized.includes("$event"), false);
});

test("concurrent duplicate Matrix deliveries emit one Web Push notification", async () => {
  const repository = new MemoryPushRepository();
  repository.returnAnySubscription = true;
  let sends = 0;
  const server = configuredServer(repository, async () => { sends += 1; });
  const device = { app_id: "chat.subetha.pwa", pushkey: PUSH_KEY };
  const response = await server.notify(notifyRequest([device, device]));
  assert.equal(response.status, 200);
  assert.equal(sends, 1);
  assert.deepEqual(await response.json(), { rejected: [] });
});

test("rate-limited Matrix deliveries are suppressed without contacting push services", async () => {
  const repository = new MemoryPushRepository();
  repository.returnAnySubscription = true;
  repository.allowRate = false;
  let sends = 0;
  const server = configuredServer(repository, async () => { sends += 1; });
  const response = await server.notify(notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]));
  assert.equal(response.status, 200);
  assert.equal(sends, 0);
});

test("expired subscriptions are deleted and returned to Matrix as rejected", async () => {
  const repository = new MemoryPushRepository();
  repository.returnAnySubscription = true;
  const server = configuredServer(repository, async () => { throw { statusCode: 410 }; });
  const response = await server.notify(notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rejected: [PUSH_KEY] });
  assert.equal(repository.deleted, 1);
});

test("transient Web Push failures release deduplication claims and return a retriable status", async () => {
  const repository = new MemoryPushRepository();
  repository.returnAnySubscription = true;
  const server = configuredServer(repository, async () => { throw { statusCode: 503 }; });
  const response = await server.notify(notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]));
  assert.equal(response.status, 502);
  assert.equal(repository.released, 1);
});

test("same-origin test notifications use the registered generic push channel", async () => {
  const repository = new MemoryPushRepository();
  repository.returnAnySubscription = true;
  const payloads: string[] = [];
  const server = configuredServer(repository, async (_subscription, payload) => { payloads.push(payload); });
  const response = await server.testNotification(new Request(`${ORIGIN}/api/push/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ pushKey: PUSH_KEY }),
  }));
  assert.equal(response.status, 200);
  assert.equal(payloads.length, 1);
  assert.deepEqual(JSON.parse(payloads[0]), { kind: "test", roomId: null, eventId: "test-1800000000", unread: 0 });
});

test("preview deployments keep Web Push disabled", async () => {
  const server = createPushServer({
    repository: new MemoryPushRepository(),
    configuration: () => null,
    log: () => undefined,
  });
  const response = await server.getVapidKey();
  assert.equal(response.status, 503);
});
