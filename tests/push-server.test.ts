import assert from "node:assert/strict";
import test from "node:test";
import type {
    PushRepository,
    PushSubscriptionSnapshot,
    StoredPushSubscription,
} from "../lib/push-repository";
import { createPushServer, type PushLimits } from "../lib/push-server";

const ORIGIN = "https://sub-etha-matrix.vercel.app";
const PUSH_KEY = "a".repeat(40);
const MANAGEMENT_KEY = "m".repeat(40);
const GENERATION = "g".repeat(40);
const SUBSCRIPTION: StoredPushSubscription = {
    endpoint: "https://updates.push.services.mozilla.com/wpush/v2/example",
    p256dh: "p256dh",
    auth: "auth",
};

class MemoryPushRepository implements PushRepository {
    subscriptions = new Map<string, StoredPushSubscription>();
    managementKeys = new Map<string, string>();
    pending = new Map<
        string,
        { deliveryKeyHash: string; managementKeyHash: string; subscription: StoredPushSubscription }
    >();
    revokedManagementKeys = new Set<string>();
    deliveries = new Set<string>();
    deleted = 0;
    released = 0;
    allowRate = true;
    globalBudgets = new Map<string, boolean>();
    globalBudgetCalls: string[] = [];
    registrationOutcome: "created" | "refreshed" | "reassigned" | "capacity_exceeded" = "created";
    cleanupCalls = 0;
    returnAnySubscription = false;
    anySubscription = SUBSCRIPTION;

    async beginSubscriptionRegistration(
        deliveryKeyHash: string,
        managementKeyHash: string,
        subscription: StoredPushSubscription,
        challengeHash: string,
    ): Promise<
        | "active"
        | "challenge_required"
        | "capacity_exceeded"
        | "pending_capacity_exceeded"
        | "management_conflict"
        | "revoked"
    > {
        if (this.registrationOutcome === "capacity_exceeded") {
            return "capacity_exceeded";
        }

        if (this.revokedManagementKeys.has(managementKeyHash)) {
            return "revoked";
        }

        if (this.subscriptions.has(deliveryKeyHash)) {
            this.subscriptions.set(deliveryKeyHash, subscription);
            this.managementKeys.set(managementKeyHash, deliveryKeyHash);

            return "active";
        }

        this.pending.set(challengeHash, { deliveryKeyHash, managementKeyHash, subscription });

        return "challenge_required";
    }

    async confirmSubscription(
        challengeHash: string,
    ): Promise<
        | "created"
        | "refreshed"
        | "reassigned"
        | "capacity_exceeded"
        | "invalid_challenge"
        | "expired_challenge"
        | "revoked"
    > {
        const pending = this.pending.get(challengeHash);

        if (!pending) {
            return "invalid_challenge";
        }

        if (this.revokedManagementKeys.has(pending.managementKeyHash)) {
            this.pending.delete(challengeHash);

            return "revoked";
        }

        this.pending.delete(challengeHash);
        this.subscriptions.set(pending.deliveryKeyHash, pending.subscription);
        this.managementKeys.set(pending.managementKeyHash, pending.deliveryKeyHash);

        return "created";
    }

    async cancelPendingRegistration(challengeHash: string): Promise<void> {
        this.pending.delete(challengeHash);
    }

    async deleteSubscription(
        pushKeyHash: string,
        _now: number,
        maximumRevokedManagementKeys: number,
    ): Promise<"removed" | "not_found" | "capacity_exceeded"> {
        const deliveryKeyHash = this.managementKeys.get(pushKeyHash);
        const existingTombstone = this.revokedManagementKeys.has(pushKeyHash);

        if (!existingTombstone && this.revokedManagementKeys.size >= maximumRevokedManagementKeys) {
            return "capacity_exceeded";
        }

        let removed = deliveryKeyHash ? this.subscriptions.delete(deliveryKeyHash) : false;

        for (const [challengeHash, pending] of this.pending) {
            if (pending.managementKeyHash === pushKeyHash) {
                this.pending.delete(challengeHash);
                removed = true;
            }
        }

        for (const [managementKeyHash, deliveryHash] of this.managementKeys) {
            if (deliveryKeyHash && deliveryHash === deliveryKeyHash) {
                this.managementKeys.delete(managementKeyHash);
            }
        }

        this.deleted += 1;

        this.revokedManagementKeys.add(pushKeyHash);

        return removed ? "removed" : "not_found";
    }

    async deleteSubscriptionByDeliveryKeyIfCurrent(
        snapshot: PushSubscriptionSnapshot,
    ): Promise<boolean> {
        const current =
            this.subscriptions.get(snapshot.deliveryKeyHash) ??
            (this.returnAnySubscription ? this.anySubscription : null);

        if (
            !current ||
            current.endpoint !== snapshot.endpoint ||
            current.p256dh !== snapshot.p256dh ||
            current.auth !== snapshot.auth
        ) {
            return false;
        }

        this.subscriptions.delete(snapshot.deliveryKeyHash);
        this.deleted += 1;

        return true;
    }

    async getSubscription(pushKeyHash: string): Promise<StoredPushSubscription | null> {
        return (
            this.subscriptions.get(pushKeyHash) ??
            (this.returnAnySubscription ? this.anySubscription : null)
        );
    }

    async getSubscriptions(pushKeyHashes: string[]): Promise<PushSubscriptionSnapshot[]> {
        return pushKeyHashes.flatMap((deliveryKeyHash) => {
            const subscription =
                this.subscriptions.get(deliveryKeyHash) ??
                (this.returnAnySubscription ? this.anySubscription : null);

            return subscription ? [{ ...subscription, deliveryKeyHash }] : [];
        });
    }

    async getManagedSubscription(
        managementKeyHash: string,
    ): Promise<(StoredPushSubscription & { deliveryKeyHash: string }) | null> {
        const deliveryKeyHash = this.managementKeys.get(managementKeyHash);

        if (!deliveryKeyHash) {
            return this.returnAnySubscription
                ? { ...this.anySubscription, deliveryKeyHash: "any-delivery-key" }
                : null;
        }

        const subscription = this.subscriptions.get(deliveryKeyHash);

        return subscription ? { ...subscription, deliveryKeyHash } : null;
    }

    async consumeRateLimit(): Promise<boolean> {
        return this.allowRate;
    }

    async consumeGlobalRateLimit(bucket: string): Promise<boolean> {
        this.globalBudgetCalls.push(bucket);

        return this.globalBudgets.get(bucket) ?? true;
    }

    async cleanupSubscriptions(): Promise<number> {
        this.cleanupCalls += 1;

        return 0;
    }

    async claimDelivery(pushKeyHash: string, eventId: string): Promise<boolean> {
        const key = `${pushKeyHash}:${eventId}`;

        if (this.deliveries.has(key)) {
            return false;
        }

        this.deliveries.add(key);

        return true;
    }

    async markDelivered(snapshot: PushSubscriptionSnapshot): Promise<boolean> {
        const current =
            this.subscriptions.get(snapshot.deliveryKeyHash) ??
            (this.returnAnySubscription ? this.anySubscription : null);

        return Boolean(
            current &&
            current.endpoint === snapshot.endpoint &&
            current.p256dh === snapshot.p256dh &&
            current.auth === snapshot.auth,
        );
    }

    async releaseDelivery(pushKeyHash: string, eventId: string): Promise<void> {
        this.deliveries.delete(`${pushKeyHash}:${eventId}`);
        this.released += 1;
    }

    async cleanupDeliveries(): Promise<void> {}
}

function configuredServer(
    repository: MemoryPushRepository,
    sender: (subscription: StoredPushSubscription, payload: string) => Promise<void> = async () =>
        undefined,
    logs: Array<Record<string, unknown>> = [],
    now: () => number = () => 1_800_000_000,
    limitOverrides: Partial<PushLimits> = {},
) {
    return createPushServer({
        repository,
        sendNotification: sender,
        configuration: () => ({ publicKey: "public", privateKey: "private", subject: ORIGIN }),
        now,
        log: (entry) => logs.push(entry),
        limits: {
            maxSubscriptions: 10_000,
            maxRevokedManagementKeys: 100_000,
            registrationPerTenMinutes: 300,
            testsPerMinute: 60,
            notifyPerMinute: 600,
            deliveriesPerMinute: 3_000,
            ...limitOverrides,
        },
    });
}

function subscriptionRequest(
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    origin = ORIGIN,
): Request {
    return new Request(`${ORIGIN}/api/push/subscriptions`, {
        method,
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
    });
}

function subscriptionBody(
    deliveryKey = PUSH_KEY,
    managementKey = MANAGEMENT_KEY,
    subscription = SUBSCRIPTION,
): Record<string, unknown> {
    return {
        deliveryKey,
        managementKey,
        generation: GENERATION,
        subscription: {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
    };
}

function notifyRequest(devices: unknown[], eventId = "$event"): Request {
    return new Request(`${ORIGIN}/_matrix/push/v1/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            notification: { event_id: eventId, room_id: "!room:example", devices },
        }),
    });
}

test("push subscriptions require an endpoint challenge and a separate management capability", async () => {
    const repository = new MemoryPushRepository();
    const payloads: string[] = [];
    const server = configuredServer(repository, async (_subscription, payload) => {
        payloads.push(payload);
    });
    const blocked = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody(), "https://attacker.example"),
    );

    assert.equal(blocked.status, 403);

    const pending = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );

    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { pending: true });
    assert.equal(repository.subscriptions.size, 0);
    assert.equal(payloads.length, 1);
    const challengePayload = JSON.parse(payloads[0]) as {
        kind?: unknown;
        challenge?: unknown;
        generation?: unknown;
    };

    assert.equal(challengePayload.kind, "subscription-challenge");
    assert.equal(typeof challengePayload.challenge, "string");
    assert.equal(challengePayload.generation, GENERATION);

    const confirmed = await server.changeSubscription(
        subscriptionRequest("PATCH", {
            challenge: challengePayload.challenge,
        }),
    );

    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), { registered: true });
    assert.equal(repository.subscriptions.size, 1);

    const deliveryCannotRemove = await server.changeSubscription(
        subscriptionRequest("DELETE", { managementKey: PUSH_KEY }),
    );

    assert.equal(deliveryCannotRemove.status, 404);
    assert.equal(repository.subscriptions.size, 1);

    const removed = await server.changeSubscription(
        subscriptionRequest("DELETE", { managementKey: MANAGEMENT_KEY }),
    );

    assert.equal(removed.status, 200);
    assert.equal(repository.subscriptions.size, 0);
});

test("omitted registration generation emits a legacy-compatible challenge", async () => {
    const repository = new MemoryPushRepository();
    const payloads: string[] = [];
    const server = configuredServer(repository, async (_subscription, payload) => {
        payloads.push(payload);
    });
    const body = subscriptionBody();

    delete body.generation;

    const response = await server.changeSubscription(subscriptionRequest("POST", body));

    assert.equal(response.status, 202);
    const challenge = JSON.parse(payloads[0] ?? "{}") as {
        challenge?: unknown;
        generation?: unknown;
    };

    assert.equal(typeof challenge.challenge, "string");
    assert.equal("generation" in challenge, false);
});

test("explicit null registration generation remains invalid", async () => {
    const server = configuredServer(new MemoryPushRepository());
    const body = { ...subscriptionBody(), generation: null };

    const response = await server.changeSubscription(subscriptionRequest("POST", body));

    assert.equal(response.status, 400);
});

test("deletion cancels pending registration and rejects its late challenge", async () => {
    const repository = new MemoryPushRepository();
    const payloads: string[] = [];
    const server = configuredServer(repository, async (_subscription, payload) => {
        payloads.push(payload);
    });
    const pending = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );
    const challenge = (JSON.parse(payloads[0] ?? "{}") as { challenge?: string }).challenge;

    assert.equal(pending.status, 202);
    assert.ok(challenge);
    assert.equal(repository.pending.size, 1);

    const removed = await server.changeSubscription(
        subscriptionRequest("DELETE", { managementKey: MANAGEMENT_KEY }),
    );
    const lateConfirmation = await server.changeSubscription(
        subscriptionRequest("PATCH", { challenge }),
    );

    assert.equal(removed.status, 200);
    assert.equal(lateConfirmation.status, 410);
    assert.equal(repository.pending.size, 0);
    assert.equal(repository.subscriptions.size, 0);
});

test("delete tombstone blocks renewal POST and late challenge resurrection", async () => {
    const repository = new MemoryPushRepository();
    const payloads: string[] = [];
    const server = configuredServer(repository, async (_subscription, payload) => {
        payloads.push(payload);
    });
    const initial = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );
    const initialChallenge = (JSON.parse(payloads[0] ?? "{}") as { challenge?: string }).challenge;

    assert.equal(initial.status, 202);
    assert.ok(initialChallenge);
    assert.equal(
        (
            await server.changeSubscription(
                subscriptionRequest("PATCH", { challenge: initialChallenge }),
            )
        ).status,
        200,
    );

    assert.equal(
        (
            await server.changeSubscription(
                subscriptionRequest("DELETE", { managementKey: MANAGEMENT_KEY }),
            )
        ).status,
        200,
    );

    const renewal = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );
    const lateChallenge = await server.changeSubscription(
        subscriptionRequest("PATCH", { challenge: initialChallenge }),
    );

    assert.equal(renewal.status, 410);
    assert.equal(lateChallenge.status, 410);
    assert.equal(repository.pending.size, 0);
    assert.equal(repository.subscriptions.size, 0);
});

test("delete intent arriving before registration prevents a delayed POST", async () => {
    const repository = new MemoryPushRepository();
    const server = configuredServer(repository, async () => undefined);
    const removed = await server.changeSubscription(
        subscriptionRequest("DELETE", { managementKey: MANAGEMENT_KEY }),
    );
    const delayedRegistration = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );

    assert.equal(removed.status, 404);
    assert.equal(delayedRegistration.status, 410);
    assert.equal(repository.pending.size, 0);
    assert.equal(repository.subscriptions.size, 0);
});

test("delete intent still prevents stale registration beyond the former retention window", async () => {
    const repository = new MemoryPushRepository();
    let timestamp = 1_800_000_000;
    const server = configuredServer(
        repository,
        async () => undefined,
        [],
        () => timestamp,
    );
    const removed = await server.changeSubscription(
        subscriptionRequest("DELETE", { managementKey: MANAGEMENT_KEY }),
    );

    timestamp += 10 * 365 * 24 * 60 * 60;

    const staleRegistration = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );

    assert.equal(removed.status, 404);
    assert.equal(staleRegistration.status, 410);
    assert.equal(repository.pending.size, 0);
    assert.equal(repository.subscriptions.size, 0);
});

test("revoked management-key capacity fails closed before deleting a subscription", async () => {
    const repository = new MemoryPushRepository();

    repository.revokedManagementKeys.add("already-revoked");
    repository.managementKeys.set(MANAGEMENT_KEY, PUSH_KEY);
    repository.subscriptions.set(PUSH_KEY, SUBSCRIPTION);
    const server = configuredServer(repository, async () => undefined, [], undefined, {
        maxRevokedManagementKeys: 1,
    });

    const response = await server.changeSubscription(
        subscriptionRequest("DELETE", { managementKey: MANAGEMENT_KEY }),
    );

    assert.equal(response.status, 503);
    assert.equal(repository.subscriptions.has(PUSH_KEY), true);
    assert.equal(repository.revokedManagementKeys.has(MANAGEMENT_KEY), false);
});

test("hostile endpoints are rejected before subscription storage or outbound contact", async () => {
    const repository = new MemoryPushRepository();
    let sends = 0;
    const server = configuredServer(repository, async () => {
        sends += 1;
    });
    const registration = await server.changeSubscription(
        subscriptionRequest(
            "POST",
            subscriptionBody(PUSH_KEY, MANAGEMENT_KEY, {
                ...SUBSCRIPTION,
                endpoint: "https://updates.push.services.mozilla.com.attacker.example/collect",
            }),
        ),
    );

    assert.equal(registration.status, 400);
    assert.equal(repository.subscriptions.size, 0);

    repository.anySubscription = {
        ...SUBSCRIPTION,
        endpoint: "https://127.0.0.1/internal",
    };
    repository.returnAnySubscription = true;
    const delivery = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(delivery.status, 200);
    assert.deepEqual(await delivery.json(), { rejected: [PUSH_KEY] });
    assert.equal(sends, 0);
});

test("push gateway rejects oversized requests before reading JSON", async () => {
    const server = configuredServer(new MemoryPushRepository());
    const response = await server.notify(
        new Request(`${ORIGIN}/_matrix/push/v1/notify`, {
            method: "POST",
            headers: { "Content-Length": "70000" },
            body: "{}",
        }),
    );

    assert.equal(response.status, 413);
});

test("push gateway cancels chunked request bodies as soon as the byte limit is exceeded", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            pulls += 1;

            if (pulls <= 2) {
                controller.enqueue(new Uint8Array(40 * 1024));
            } else {
                controller.close();
            }
        },
        cancel() {
            cancelled = true;
        },
    });
    const request = new Request(`${ORIGIN}/_matrix/push/v1/notify`, {
        method: "POST",
        body,
        duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await configuredServer(new MemoryPushRepository()).notify(request);

    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
});

test("malformed push requests do not consume valid-operation budgets", async () => {
    const repository = new MemoryPushRepository();
    const server = configuredServer(repository);

    const invalidRegistration = await server.changeSubscription(
        subscriptionRequest("POST", {
            deliveryKey: "short",
            managementKey: MANAGEMENT_KEY,
            subscription: {},
        }),
    );

    assert.equal(invalidRegistration.status, 400);

    const invalidTest = await server.testNotification(
        new Request(`${ORIGIN}/api/push/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: ORIGIN },
            body: JSON.stringify({ managementKey: "short" }),
        }),
    );

    assert.equal(invalidTest.status, 400);

    const invalidNotify = await server.notify(
        new Request(`${ORIGIN}/_matrix/push/v1/notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notification: { devices: "not-an-array" } }),
        }),
    );

    assert.equal(invalidNotify.status, 400);
    assert.deepEqual(repository.globalBudgetCalls, []);
});

test("Matrix notify rejects unknown devices without exposing notification content to logs", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const server = configuredServer(new MemoryPushRepository(), async () => undefined, logs);
    const response = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rejected: [PUSH_KEY] });
    assert.deepEqual(
        logs.filter((entry) => entry.budgetCategory === "matrix-notify"),
        [],
    );
    const serialized = JSON.stringify(logs);

    assert.equal(serialized.includes(PUSH_KEY), false);
    assert.equal(serialized.includes("!room:example"), false);
    assert.equal(serialized.includes("$event"), false);
});

test("empty and malformed Matrix device lists do not consume the notify budget", async () => {
    const repository = new MemoryPushRepository();
    const server = configuredServer(repository);

    const empty = await server.notify(notifyRequest([]));
    const malformed = await server.notify(notifyRequest([null]));

    assert.equal(empty.status, 200);
    assert.equal(malformed.status, 400);
    assert.deepEqual(repository.globalBudgetCalls, []);
});

test("Matrix relay payload excludes sender and message text", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    const payloads: string[] = [];
    const server = configuredServer(repository, async (_subscription, payload) => {
        payloads.push(payload);
    });
    const response = await server.notify(
        new Request(`${ORIGIN}/_matrix/push/v1/notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                notification: {
                    event_id: "$routing-only",
                    room_id: "!room:example",
                    sender: "@private:example",
                    sender_display_name: "Private sender",
                    content: { body: "secret message text", msgtype: "m.text" },
                    counts: { unread: 7 },
                    devices: [{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }],
                },
            }),
        }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(payloads[0] ?? "{}"), {
        kind: "matrix",
        roomId: "!room:example",
        eventId: "$routing-only",
        unread: 7,
    });
    assert.equal(payloads[0]?.includes("secret message text"), false);
    assert.equal(payloads[0]?.includes("Private sender"), false);
});

test("concurrent duplicate Matrix deliveries emit one Web Push notification", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    let sends = 0;
    const server = configuredServer(repository, async () => {
        sends += 1;
    });
    const device = { app_id: "chat.subetha.pwa", pushkey: PUSH_KEY };
    const response = await server.notify(notifyRequest([device, device]));

    assert.equal(response.status, 200);
    assert.equal(sends, 1);
    assert.deepEqual(await response.json(), { rejected: [] });
    assert.deepEqual(
        repository.globalBudgetCalls.filter((bucket) => bucket === "matrix-notify"),
        ["matrix-notify"],
    );
});

test("rate-limited Matrix deliveries are suppressed without contacting push services", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    repository.allowRate = false;
    let sends = 0;
    const server = configuredServer(repository, async () => {
        sends += 1;
    });
    const response = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(response.status, 200);
    assert.equal(sends, 0);
});

test("expired subscriptions are deleted and returned to Matrix as rejected", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    const server = configuredServer(repository, async () => {
        throw { statusCode: 410 };
    });
    const response = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rejected: [PUSH_KEY] });
    assert.equal(repository.deleted, 1);
});

test("stale provider expiry cannot delete a rotated endpoint", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    const rotated: StoredPushSubscription = {
        ...SUBSCRIPTION,
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/rotated",
    };
    const server = configuredServer(repository, async () => {
        repository.anySubscription = rotated;

        throw { statusCode: 410 };
    });

    const response = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(response.status, 503);
    assert.equal(repository.deleted, 0);
    assert.equal(repository.anySubscription.endpoint, rotated.endpoint);
});

test("transient Web Push failures release deduplication claims and return a retriable status", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    const server = configuredServer(repository, async () => {
        throw { statusCode: 503 };
    });
    const response = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(repository.released, 1);
});

test("same-origin test notifications use the registered generic push channel", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    const payloads: string[] = [];
    const server = configuredServer(repository, async (_subscription, payload) => {
        payloads.push(payload);
    });
    const response = await server.testNotification(
        new Request(`${ORIGIN}/api/push/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: ORIGIN },
            body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
        }),
    );

    assert.equal(response.status, 200);
    assert.equal(payloads.length, 1);
    assert.deepEqual(JSON.parse(payloads[0]), {
        kind: "test",
        roomId: null,
        eventId: "test-1800000000",
        unread: 0,
    });
});

test("Matrix delivery identifiers cannot authorize browser test sends", async () => {
    const repository = new MemoryPushRepository();
    const payloads: string[] = [];
    const server = configuredServer(repository, async (_subscription, payload) => {
        payloads.push(payload);
    });

    const pending = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );
    const challengePayload = JSON.parse(payloads.shift() ?? "{}") as { challenge?: unknown };

    assert.equal(pending.status, 202);
    assert.equal(typeof challengePayload.challenge, "string");
    const confirmed = await server.changeSubscription(
        subscriptionRequest("PATCH", { challenge: challengePayload.challenge }),
    );

    assert.equal(confirmed.status, 200);

    const deliveryKeyTest = await server.testNotification(
        new Request(`${ORIGIN}/api/push/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: ORIGIN },
            body: JSON.stringify({ managementKey: PUSH_KEY }),
        }),
    );

    assert.equal(deliveryKeyTest.status, 404);

    const managementKeyTest = await server.testNotification(
        new Request(`${ORIGIN}/api/push/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: ORIGIN },
            body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
        }),
    );

    assert.equal(managementKeyTest.status, 200);

    const managementAsDelivery = await server.notify(
        notifyRequest(
            [
                {
                    app_id: "chat.subetha.pwa",
                    pushkey: MANAGEMENT_KEY,
                },
            ],
            "$management-key",
        ),
    );

    assert.deepEqual(await managementAsDelivery.json(), { rejected: [MANAGEMENT_KEY] });

    const delivery = await server.notify(
        notifyRequest(
            [
                {
                    app_id: "chat.subetha.pwa",
                    pushkey: PUSH_KEY,
                },
            ],
            "$delivery-key",
        ),
    );

    assert.equal(delivery.status, 200);
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

test("subscription mutation budget returns 429 before storage", async () => {
    const repository = new MemoryPushRepository();

    repository.globalBudgets.set("subscription-mutations", false);
    const server = configuredServer(repository);
    const response = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );

    assert.equal(response.status, 429);
    assert.equal(repository.subscriptions.size, 0);
});

test("registration cleans stale rows and returns 503 when capacity remains full", async () => {
    const repository = new MemoryPushRepository();

    repository.registrationOutcome = "capacity_exceeded";
    const server = configuredServer(repository);
    const response = await server.changeSubscription(
        subscriptionRequest("POST", subscriptionBody()),
    );

    assert.equal(response.status, 503);
    assert.equal(repository.cleanupCalls, 1);
});

test("test-send budget returns 429 without contacting a push provider", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    repository.globalBudgets.set("test-sends", false);
    let sends = 0;
    const server = configuredServer(repository, async () => {
        sends += 1;
    });
    const response = await server.testNotification(
        new Request(`${ORIGIN}/api/push/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: ORIGIN },
            body: JSON.stringify({ managementKey: MANAGEMENT_KEY }),
        }),
    );

    assert.equal(response.status, 429);
    assert.equal(sends, 0);
});

test("Matrix request pressure returns retriable M_UNKNOWN without parsing devices", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    repository.globalBudgets.set("matrix-notify", false);
    let sends = 0;
    const server = configuredServer(repository, async () => {
        sends += 1;
    });
    const response = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.deepEqual(await response.json(), {
        errcode: "M_UNKNOWN",
        error: "Push gateway is temporarily busy.",
    });
    assert.equal(sends, 0);
});

test("delivery budget pressure releases claims and never rejects or sends", async () => {
    const repository = new MemoryPushRepository();

    repository.returnAnySubscription = true;
    repository.globalBudgets.set("outbound-deliveries", false);
    let sends = 0;
    const server = configuredServer(repository, async () => {
        sends += 1;
    });
    const response = await server.notify(
        notifyRequest([{ app_id: "chat.subetha.pwa", pushkey: PUSH_KEY }]),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(sends, 0);
    assert.equal(repository.released, 1);
});
