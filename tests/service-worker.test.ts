import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface ShownNotification {
  title: string;
  options: {
    data?: { eventId?: string | null; kind?: string; roomId?: string | null };
    renotify?: boolean;
    tag?: string;
  };
}

function createWorker(visible = false) {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const shown: ShownNotification[] = [];
  const active = new Map<string, { close: () => void }>();
  const badgeSets: number[] = [];
  const clientMessages: unknown[] = [];
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  let badgeClears = 0;

  const registration = {
    async getNotifications({ tag }: { tag?: string }) {
      if (tag) return active.has(tag) ? [active.get(tag)!] : [];
      return [...active.values()];
    },
    pushManager: {},
    async showNotification(title: string, options: ShownNotification["options"]) {
      shown.push({ title, options });
      const tag = options.tag ?? "";
      const notification = {
        close: () => {
          if (active.get(tag) === notification) active.delete(tag);
        },
      };
      active.set(tag, notification);
    },
  };
  const worker = {
    addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
      handlers.set(type, handler);
    },
    clients: {
      async matchAll() {
        return [{
          visibilityState: visible ? "visible" : "hidden",
          postMessage(message: unknown) {
            clientMessages.push(message);
          },
        }];
      },
    },
    navigator: {
      async clearAppBadge() {
        badgeClears += 1;
      },
      async setAppBadge(count: number) {
        badgeSets.push(count);
      },
    },
    registration,
  };
  const workerFetch = async (input: string, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(null, { status: 200 });
  };
  vm.runInNewContext(source, { self: worker, console, Promise, URL, atob, caches: {}, fetch: workerFetch });

  const settle = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)?.({
      ...event,
      waitUntil(value: Promise<unknown>) {
        waits.push(value);
      },
    });
    await Promise.all(waits);
  };

  return {
    active,
    badgeClears: () => badgeClears,
    badgeSets,
    clientMessages,
    dismiss: (roomId: string) => settle("message", { data: { type: "DISMISS_ROOM_NOTIFICATION", roomId } }),
    push: (payload: Record<string, unknown>) => settle("push", { data: { json: () => payload } }),
    requests,
    shown,
  };
}

test("background Matrix pushes collapse to one notification per room", async () => {
  const worker = createWorker();
  await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$1", unread: 1 });
  await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$2", unread: 2 });
  assert.equal(worker.shown.length, 2);
  assert.equal(worker.shown[0].options.tag, worker.shown[1].options.tag);
  assert.equal(worker.shown[1].options.renotify, false);
  assert.equal(worker.active.size, 1);
  assert.deepEqual(worker.badgeSets, [1, 2]);

  await worker.push({ kind: "matrix", roomId: "!two:example", eventId: "$3", unread: 3 });
  assert.notEqual(worker.shown[1].options.tag, worker.shown[2].options.tag);
  assert.equal(worker.active.size, 2);
});

test("visible clients suppress Matrix notifications while badges remain accurate", async () => {
  const worker = createWorker(true);
  await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$1", unread: 4 });
  assert.equal(worker.shown.length, 0);
  assert.deepEqual(worker.badgeSets, [4]);

  await worker.push({ kind: "matrix", roomId: "!one:example", eventId: "$2", unread: 0 });
  assert.equal(worker.badgeClears(), 1);
});

test("test pushes always alert without changing the unread badge", async () => {
  const worker = createWorker(true);
  await worker.push({ kind: "test", roomId: null, eventId: "test-1", unread: 0 });
  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].options.tag, "sub-etha-test");
  assert.equal(worker.shown[0].options.renotify, true);
  assert.deepEqual(worker.badgeSets, []);
  assert.equal(worker.badgeClears(), 0);
});

test("subscription challenges confirm silently through the service worker", async () => {
  const worker = createWorker();
  await worker.push({ kind: "subscription-challenge", challenge: "challenge-token" });
  assert.equal(worker.shown.length, 0);
  assert.deepEqual(worker.badgeSets, []);
  assert.equal(worker.requests.length, 1);
  assert.equal(worker.requests[0].input, "/api/push/subscriptions");
  assert.equal(worker.requests[0].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(worker.requests[0].init?.body)), { challenge: "challenge-token" });
  assert.equal(JSON.stringify(worker.clientMessages), JSON.stringify([{ type: "PUSH_SUBSCRIPTION_CONFIRMED" }]));
});

test("opening a room dismisses its grouped notification", async () => {
  const worker = createWorker();
  await worker.push({ roomId: "!one:example", eventId: "$1", unread: 1 });
  assert.equal(worker.active.size, 1);
  await worker.dismiss("!one:example");
  assert.equal(worker.active.size, 0);
});
