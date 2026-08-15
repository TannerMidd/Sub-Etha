import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { pushGatewayState, pushGlobalRateBudgets, pushRevokedManagementKeys } from "../db/schema";
import { neonPushRepository } from "../lib/push-repository";

const PUSH_MIGRATION = new URL("../drizzle/0003_bounded_push_safety.sql", import.meta.url);
const MAX_REVOKED_MANAGEMENT_KEYS = 100_000;

function migrationFunction(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION "${name}"`);

    assert.notEqual(start, -1, `${name} must exist in the push migration`);

    const end = source.indexOf("--> statement-breakpoint", start);

    return source.slice(start, end === -1 ? source.length : end);
}

test("push SQL keeps deletion intent fenced and bounds new management revocations", async () => {
    const source = await readFile(PUSH_MIGRATION, "utf8");
    const remove = migrationFunction(source, "subetha_delete_push_subscription");
    const tombstoneWrite = remove.indexOf('INSERT INTO "push_revoked_management_keys"');

    assert.notEqual(tombstoneWrite, -1);
    assert.ok(tombstoneWrite < remove.indexOf("RETURN false"));
    assert.match(source, /revoked_management_key_count/);
    assert.match(source, /revoked_management_key_limit/);
    assert.match(
        source,
        /ADD COLUMN "revoked_management_key_limit" bigint DEFAULT 100000;/,
        "migration must seed the cap before legacy app instances can call the two-argument delete",
    );
    assert.ok(
        source.indexOf('ADD COLUMN "revoked_management_key_limit"') <
            source.indexOf('CREATE OR REPLACE FUNCTION "subetha_delete_push_subscription"'),
    );
    assert.match(source, /capacity_exceeded/);
    assert.match(source, /Revoked management-key capacity is not configured for legacy deletion/);
    assert.match(source, /USING ERRCODE = 'P0001'/);
    assert.match(source, /v_revoked_count >= v_revoked_limit/);
    assert.match(source, /CREATE TRIGGER "push_revoked_management_key_count"/);
    assert.match(source, /subetha_delete_push_subscription_if_current/);
    assert.match(source, /subscription\."updated_at" = stale\."updated_at"/);
    assert.match(source, /subscription\."updated_at" <= p_cutoff/);
});

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
            await neonPushRepository.deleteSubscription(
                managementKeyHash,
                now,
                MAX_REVOKED_MANAGEMENT_KEYS,
            );
        }

        assert.equal(await neonPushRepository.getSubscription(pushKeyHash), null);
    },
);

test(
    "Neon deletion intent tombstones a management key before delayed registration",
    {
        skip: !process.env.DATABASE_URL,
    },
    async () => {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const deliveryKeyHash = `integration-delete-first-${suffix}`;
        const managementKeyHash = `integration-delete-first-management-${suffix}`;
        const now = Math.floor(Date.now() / 1_000);

        assert.equal(
            await neonPushRepository.deleteSubscription(
                managementKeyHash,
                now,
                MAX_REVOKED_MANAGEMENT_KEYS,
            ),
            "not_found",
        );
        assert.equal(
            await neonPushRepository.beginSubscriptionRegistration(
                deliveryKeyHash,
                managementKeyHash,
                {
                    endpoint: `https://push.example.invalid/delete-first-${suffix}`,
                    p256dh: "delete-first-p256dh",
                    auth: "delete-first-auth",
                },
                `integration-delete-first-challenge-${suffix}`,
                now + 86_401,
                now + 87_001,
                10_000,
                300,
            ),
            "revoked",
        );
        assert.equal(await neonPushRepository.getSubscription(deliveryKeyHash), null);
    },
);

test(
    "Neon management revocation count and persisted cap fence new tombstones",
    {
        skip: !process.env.DATABASE_URL,
    },
    async () => {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const managementKeyHash = `integration-cap-management-${suffix}`;
        const now = Math.floor(Date.now() / 1_000);
        const [before] = await getDb()
            .select({
                count: pushGatewayState.revokedManagementKeyCount,
                limit: pushGatewayState.revokedManagementKeyLimit,
            })
            .from(pushGatewayState)
            .where(eq(pushGatewayState.id, 1))
            .limit(1);

        assert.equal(
            await neonPushRepository.deleteSubscription(
                managementKeyHash,
                now,
                MAX_REVOKED_MANAGEMENT_KEYS,
            ),
            "not_found",
        );

        const [after] = await getDb()
            .select({
                count: pushGatewayState.revokedManagementKeyCount,
                limit: pushGatewayState.revokedManagementKeyLimit,
            })
            .from(pushGatewayState)
            .where(eq(pushGatewayState.id, 1))
            .limit(1);
        const [tombstone] = await getDb()
            .select({ hash: pushRevokedManagementKeys.managementKeyHash })
            .from(pushRevokedManagementKeys)
            .where(eq(pushRevokedManagementKeys.managementKeyHash, managementKeyHash))
            .limit(1);

        assert.equal(after?.count, Number(before?.count ?? 0) + 1);
        assert.equal(after?.limit, before?.limit ?? MAX_REVOKED_MANAGEMENT_KEYS);
        assert.equal(tombstone?.hash, managementKeyHash);
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
                neonPushRepository.deleteSubscription(
                    firstManagementKey,
                    now,
                    MAX_REVOKED_MANAGEMENT_KEYS,
                ),
                neonPushRepository.deleteSubscription(
                    secondManagementKey,
                    now,
                    MAX_REVOKED_MANAGEMENT_KEYS,
                ),
                neonPushRepository.deleteSubscription(
                    capacityManagementA,
                    now,
                    MAX_REVOKED_MANAGEMENT_KEYS,
                ),
                neonPushRepository.deleteSubscription(
                    capacityManagementB,
                    now,
                    MAX_REVOKED_MANAGEMENT_KEYS,
                ),
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
            await neonPushRepository.deleteSubscription(
                managementKeyHash,
                budgetNow,
                MAX_REVOKED_MANAGEMENT_KEYS,
            );

            if (budgetBefore) {
                await getDb()
                    .update(pushGlobalRateBudgets)
                    .set(budgetBefore)
                    .where(eq(pushGlobalRateBudgets.name, "test-sends"));
            }
        }
    },
);
