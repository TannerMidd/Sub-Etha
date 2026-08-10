import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { pushGatewayState, pushGlobalRateBudgets } from "../db/schema";
import { neonPushRepository } from "../lib/push-repository";

async function registerConfirmedSubscription(
    deliveryKeyHash: string,
    managementKeyHash: string,
    challengeHash: string,
    endpoint: string,
    now: number,
    maximumSubscriptions: number,
): Promise<string> {
    const start = await neonPushRepository.beginSubscriptionRegistration(
        deliveryKeyHash,
        managementKeyHash,
        { endpoint, p256dh: `${deliveryKeyHash}-p256dh`, auth: `${deliveryKeyHash}-auth` },
        challengeHash,
        now,
        now + 600,
        maximumSubscriptions,
        300,
    );

    assert.equal(start, "challenge_required");

    return neonPushRepository.confirmSubscription(challengeHash, now, maximumSubscriptions);
}

test(
    "Neon registers, deduplicates, and deletes push subscriptions",
    {
        skip: !process.env.DATABASE_URL,
    },
    async () => {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const pushKeyHash = `integration-${suffix}`;
        const managementKeyHash = `integration-management-${suffix}`;
        const eventId = `$integration-${suffix}:example.invalid`;
        const now = Math.floor(Date.now() / 1000);

        try {
            assert.equal(
                await registerConfirmedSubscription(
                    pushKeyHash,
                    managementKeyHash,
                    `integration-challenge-${suffix}`,
                    `https://push.example.invalid/${suffix}`,
                    now,
                    10_000,
                ),
                "created",
            );

            assert.deepEqual(await neonPushRepository.getSubscription(pushKeyHash), {
                endpoint: `https://push.example.invalid/${suffix}`,
                p256dh: `${pushKeyHash}-p256dh`,
                auth: `${pushKeyHash}-auth`,
            });
            assert.equal(
                (await neonPushRepository.getManagedSubscription(managementKeyHash))
                    ?.deliveryKeyHash,
                pushKeyHash,
            );

            assert.equal(
                await neonPushRepository.consumeRateLimit(pushKeyHash, now, 60, 120),
                true,
            );

            const claims = await Promise.all([
                neonPushRepository.claimDelivery(pushKeyHash, eventId, now, 120),
                neonPushRepository.claimDelivery(pushKeyHash, eventId, now, 120),
            ]);

            assert.equal(claims.filter(Boolean).length, 1);
        } finally {
            await neonPushRepository.deleteSubscription(managementKeyHash);
        }

        assert.equal(await neonPushRepository.getSubscription(pushKeyHash), null);
    },
);

test(
    "Neon atomically deduplicates endpoints and enforces capacity",
    {
        skip: !process.env.DATABASE_URL,
    },
    async () => {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const firstKey = `integration-first-${suffix}`;
        const secondKey = `integration-second-${suffix}`;
        const firstManagementKey = `integration-first-management-${suffix}`;
        const secondManagementKey = `integration-second-management-${suffix}`;
        const capacityKeyA = `integration-capacity-a-${suffix}`;
        const capacityKeyB = `integration-capacity-b-${suffix}`;
        const capacityManagementA = `integration-capacity-management-a-${suffix}`;
        const capacityManagementB = `integration-capacity-management-b-${suffix}`;
        const sharedEndpoint = `https://push.example.invalid/shared-${suffix}`;
        const now = Math.floor(Date.now() / 1000);

        try {
            assert.equal(
                await registerConfirmedSubscription(
                    firstKey,
                    firstManagementKey,
                    `integration-first-challenge-${suffix}`,
                    sharedEndpoint,
                    now,
                    Number.MAX_SAFE_INTEGER,
                ),
                "created",
            );
            assert.equal(
                await registerConfirmedSubscription(
                    secondKey,
                    secondManagementKey,
                    `integration-second-challenge-${suffix}`,
                    sharedEndpoint,
                    now + 1,
                    Number.MAX_SAFE_INTEGER,
                ),
                "reassigned",
            );
            assert.equal(await neonPushRepository.getSubscription(firstKey), null);
            assert.equal(
                (await neonPushRepository.getSubscription(secondKey))?.endpoint,
                sharedEndpoint,
            );

            const [state] = await getDb()
                .select({ count: pushGatewayState.subscriptionCount })
                .from(pushGatewayState)
                .where(eq(pushGatewayState.id, 1))
                .limit(1);
            const maximum = Number(state?.count ?? 0) + 1;
            const starts = await Promise.all([
                neonPushRepository.beginSubscriptionRegistration(
                    capacityKeyA,
                    capacityManagementA,
                    {
                        endpoint: `https://push.example.invalid/capacity-a-${suffix}`,
                        p256dh: "capacity-a-p256dh",
                        auth: "capacity-a-auth",
                    },
                    `integration-capacity-challenge-a-${suffix}`,
                    now + 2,
                    now + 602,
                    maximum,
                    300,
                ),
                neonPushRepository.beginSubscriptionRegistration(
                    capacityKeyB,
                    capacityManagementB,
                    {
                        endpoint: `https://push.example.invalid/capacity-b-${suffix}`,
                        p256dh: "capacity-b-p256dh",
                        auth: "capacity-b-auth",
                    },
                    `integration-capacity-challenge-b-${suffix}`,
                    now + 2,
                    now + 602,
                    maximum,
                    300,
                ),
            ]);

            assert.deepEqual(starts, ["challenge_required", "challenge_required"]);
            const outcomes = await Promise.all([
                neonPushRepository.confirmSubscription(
                    `integration-capacity-challenge-a-${suffix}`,
                    now + 2,
                    maximum,
                ),
                neonPushRepository.confirmSubscription(
                    `integration-capacity-challenge-b-${suffix}`,
                    now + 2,
                    maximum,
                ),
            ]);

            assert.equal(outcomes.filter((outcome) => outcome === "created").length, 1);
            assert.equal(outcomes.filter((outcome) => outcome === "capacity_exceeded").length, 1);
        } finally {
            await Promise.all([
                neonPushRepository.deleteSubscription(firstManagementKey),
                neonPushRepository.deleteSubscription(secondManagementKey),
                neonPushRepository.deleteSubscription(capacityManagementA),
                neonPushRepository.deleteSubscription(capacityManagementB),
            ]);
        }
    },
);

test(
    "Neon global budgets reset atomically and stale cleanup reconciles count",
    {
        skip: !process.env.DATABASE_URL,
    },
    async () => {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const pushKeyHash = `integration-stale-${suffix}`;
        const managementKeyHash = `integration-stale-management-${suffix}`;
        const endpoint = `https://push.example.invalid/stale-${suffix}`;
        const budgetNow = Math.floor(Date.now() / 1_000);
        const staleNow = 1_000;
        const [budgetBefore] = await getDb()
            .select({
                windowStart: pushGlobalRateBudgets.windowStart,
                requestCount: pushGlobalRateBudgets.requestCount,
            })
            .from(pushGlobalRateBudgets)
            .where(eq(pushGlobalRateBudgets.name, "test-sends"))
            .limit(1);
        const [before] = await getDb()
            .select({ count: pushGatewayState.subscriptionCount })
            .from(pushGatewayState)
            .where(eq(pushGatewayState.id, 1))
            .limit(1);

        try {
            await getDb()
                .update(pushGlobalRateBudgets)
                .set({
                    windowStart: budgetNow - 61,
                    requestCount: 0,
                })
                .where(eq(pushGlobalRateBudgets.name, "test-sends"));
            assert.equal(
                await neonPushRepository.consumeGlobalRateLimit("test-sends", budgetNow, 60, 1),
                true,
            );
            assert.equal(
                await neonPushRepository.consumeGlobalRateLimit("test-sends", budgetNow, 60, 1),
                false,
            );
            assert.equal(
                await neonPushRepository.consumeGlobalRateLimit(
                    "test-sends",
                    budgetNow + 61,
                    60,
                    1,
                ),
                true,
            );

            assert.equal(
                await registerConfirmedSubscription(
                    pushKeyHash,
                    managementKeyHash,
                    `integration-stale-challenge-${suffix}`,
                    endpoint,
                    staleNow - 1_000,
                    Number.MAX_SAFE_INTEGER,
                ),
                "created",
            );
            assert.equal(await neonPushRepository.cleanupSubscriptions(staleNow - 500, 500), 1);
            assert.equal(await neonPushRepository.getSubscription(pushKeyHash), null);
            const [after] = await getDb()
                .select({ count: pushGatewayState.subscriptionCount })
                .from(pushGatewayState)
                .where(eq(pushGatewayState.id, 1))
                .limit(1);

            assert.equal(after?.count, before?.count);
        } finally {
            await neonPushRepository.deleteSubscription(managementKeyHash);

            if (budgetBefore) {
                await getDb()
                    .update(pushGlobalRateBudgets)
                    .set(budgetBefore)
                    .where(eq(pushGlobalRateBudgets.name, "test-sends"));
            }
        }
    },
);
