import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { pushDeliveries, pushGlobalRateBudgets, pushSubscriptions } from "@/db/schema";

export interface StoredPushSubscription {
    endpoint: string;
    p256dh: string;
    auth: string;
}

export interface ManagedPushSubscription extends StoredPushSubscription {
    deliveryKeyHash: string;
}

export interface PushSubscriptionSnapshot extends StoredPushSubscription {
    deliveryKeyHash: string;
}

export type PushDeletionOutcome = "removed" | "not_found" | "capacity_exceeded";

export type PushRegistrationOutcome = "created" | "refreshed" | "reassigned" | "capacity_exceeded";
export type PushRegistrationStartOutcome =
    | "active"
    | "challenge_required"
    | "capacity_exceeded"
    | "pending_capacity_exceeded"
    | "management_conflict"
    | "revoked";
export type PushConfirmationOutcome =
    PushRegistrationOutcome | "invalid_challenge" | "expired_challenge" | "revoked";

export interface PushRepository {
    beginSubscriptionRegistration(
        deliveryKeyHash: string,
        managementKeyHash: string,
        subscription: StoredPushSubscription,
        challengeHash: string,
        now: number,
        challengeExpiresAt: number,
        maximumSubscriptions: number,
        maximumPendingSubscriptions: number,
    ): Promise<PushRegistrationStartOutcome>;
    confirmSubscription(
        challengeHash: string,
        now: number,
        maximumSubscriptions: number,
    ): Promise<PushConfirmationOutcome>;
    cancelPendingRegistration(challengeHash: string): Promise<void>;
    deleteSubscription(
        managementKeyHash: string,
        now: number,
        maximumRevokedManagementKeys: number,
    ): Promise<PushDeletionOutcome>;
    deleteSubscriptionByDeliveryKeyIfCurrent(snapshot: PushSubscriptionSnapshot): Promise<boolean>;
    getSubscription(deliveryKeyHash: string): Promise<StoredPushSubscription | null>;
    getSubscriptions(deliveryKeyHashes: string[]): Promise<PushSubscriptionSnapshot[]>;
    getManagedSubscription(managementKeyHash: string): Promise<ManagedPushSubscription | null>;
    consumeRateLimit(
        pushKeyHash: string,
        now: number,
        windowSeconds: number,
        limit: number,
    ): Promise<boolean>;
    consumeGlobalRateLimit(
        bucket: string,
        now: number,
        windowSeconds: number,
        limit: number,
    ): Promise<boolean>;
    claimDelivery(
        pushKeyHash: string,
        eventId: string,
        now: number,
        staleAfterSeconds: number,
    ): Promise<boolean>;
    markDelivered(
        snapshot: PushSubscriptionSnapshot,
        eventId: string | null,
        now: number,
    ): Promise<boolean>;
    releaseDelivery(pushKeyHash: string, eventId: string): Promise<void>;
    cleanupSubscriptions(cutoff: number, limit: number): Promise<number>;
    cleanupDeliveries(cutoff: number): Promise<void>;
}

export const neonPushRepository: PushRepository = {
    async beginSubscriptionRegistration(
        deliveryKeyHash,
        managementKeyHash,
        subscription,
        challengeHash,
        now,
        challengeExpiresAt,
        maximumSubscriptions,
        maximumPendingSubscriptions,
    ) {
        const result = await getDb().execute<{ outcome: PushRegistrationStartOutcome }>(sql`
      SELECT subetha_begin_push_subscription_registration(
        ${deliveryKeyHash},
        ${managementKeyHash},
        ${subscription.endpoint},
        ${subscription.p256dh},
        ${subscription.auth},
        ${challengeHash},
        ${now},
        ${challengeExpiresAt},
        ${maximumSubscriptions},
        ${maximumPendingSubscriptions}
      ) AS outcome
    `);

        return result.rows[0]?.outcome ?? "capacity_exceeded";
    },

    async confirmSubscription(challengeHash, now, maximumSubscriptions) {
        const result = await getDb().execute<{ outcome: PushConfirmationOutcome }>(sql`
      SELECT subetha_confirm_push_subscription(
        ${challengeHash},
        ${now},
        ${maximumSubscriptions}
      ) AS outcome
    `);

        return result.rows[0]?.outcome ?? "invalid_challenge";
    },

    async cancelPendingRegistration(challengeHash) {
        await getDb().execute(sql`
      DELETE FROM "push_pending_subscriptions"
      WHERE "challenge_hash" = ${challengeHash}
    `);
    },

    async deleteSubscription(managementKeyHash, now, maximumRevokedManagementKeys) {
        const result = await getDb().execute<{ outcome: PushDeletionOutcome }>(sql`
      SELECT subetha_delete_push_subscription(
        ${managementKeyHash},
        ${now},
        ${maximumRevokedManagementKeys}
      ) AS outcome
    `);

        return result.rows[0]?.outcome ?? "not_found";
    },

    async deleteSubscriptionByDeliveryKeyIfCurrent(snapshot) {
        const result = await getDb().execute<{ removed: boolean }>(sql`
      SELECT subetha_delete_push_subscription_if_current(
        ${snapshot.deliveryKeyHash},
        ${snapshot.endpoint},
        ${snapshot.p256dh},
        ${snapshot.auth}
      ) AS removed
    `);

        return result.rows[0]?.removed === true;
    },

    async getSubscription(pushKeyHash) {
        const [subscription] = await getDb()
            .select({
                endpoint: pushSubscriptions.endpoint,
                p256dh: pushSubscriptions.p256dh,
                auth: pushSubscriptions.auth,
            })
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.pushKeyHash, pushKeyHash))
            .limit(1);

        return subscription ?? null;
    },

    async getSubscriptions(pushKeyHashes) {
        if (pushKeyHashes.length === 0) {
            return [];
        }

        return getDb()
            .select({
                deliveryKeyHash: pushSubscriptions.pushKeyHash,
                endpoint: pushSubscriptions.endpoint,
                p256dh: pushSubscriptions.p256dh,
                auth: pushSubscriptions.auth,
            })
            .from(pushSubscriptions)
            .where(inArray(pushSubscriptions.pushKeyHash, pushKeyHashes));
    },

    async getManagedSubscription(managementKeyHash) {
        const [subscription] = await getDb()
            .select({
                deliveryKeyHash: pushSubscriptions.pushKeyHash,
                endpoint: pushSubscriptions.endpoint,
                p256dh: pushSubscriptions.p256dh,
                auth: pushSubscriptions.auth,
            })
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.managementKeyHash, managementKeyHash))
            .limit(1);

        return subscription ?? null;
    },

    async consumeRateLimit(pushKeyHash, now, windowSeconds, limit) {
        const [result] = await getDb()
            .update(pushSubscriptions)
            .set({
                rateCount: sql`CASE
        WHEN ${pushSubscriptions.rateWindowStart} <= ${now - windowSeconds} THEN 1
        ELSE ${pushSubscriptions.rateCount} + 1
      END`,
                rateWindowStart: sql`CASE
        WHEN ${pushSubscriptions.rateWindowStart} <= ${now - windowSeconds} THEN ${now}
        ELSE ${pushSubscriptions.rateWindowStart}
      END`,
            })
            .where(eq(pushSubscriptions.pushKeyHash, pushKeyHash))
            .returning({
                rateCount: pushSubscriptions.rateCount,
            });
        const count = Number(result?.rateCount ?? limit + 1);

        return count <= limit;
    },

    async consumeGlobalRateLimit(bucket, now, windowSeconds, limit) {
        const [result] = await getDb()
            .update(pushGlobalRateBudgets)
            .set({
                requestCount: sql`CASE
        WHEN ${pushGlobalRateBudgets.windowStart} <= ${now - windowSeconds} THEN 1
        ELSE ${pushGlobalRateBudgets.requestCount} + 1
      END`,
                windowStart: sql`CASE
        WHEN ${pushGlobalRateBudgets.windowStart} <= ${now - windowSeconds} THEN ${now}
        ELSE ${pushGlobalRateBudgets.windowStart}
      END`,
            })
            .where(eq(pushGlobalRateBudgets.name, bucket))
            .returning({
                requestCount: pushGlobalRateBudgets.requestCount,
            });
        const count = Number(result?.requestCount ?? limit + 1);

        return count <= limit;
    },

    async claimDelivery(pushKeyHash, eventId, now, staleAfterSeconds) {
        const inserted = await getDb()
            .insert(pushDeliveries)
            .values({
                pushKeyHash,
                eventId,
                status: "pending",
                updatedAt: now,
            })
            .onConflictDoNothing()
            .returning({ eventId: pushDeliveries.eventId });

        if (inserted.length > 0) {
            return true;
        }

        const reclaimed = await getDb()
            .update(pushDeliveries)
            .set({ updatedAt: now })
            .where(
                and(
                    eq(pushDeliveries.pushKeyHash, pushKeyHash),
                    eq(pushDeliveries.eventId, eventId),
                    eq(pushDeliveries.status, "pending"),
                    lte(pushDeliveries.updatedAt, now - staleAfterSeconds),
                ),
            )
            .returning({ eventId: pushDeliveries.eventId });

        return reclaimed.length > 0;
    },

    async markDelivered(snapshot, eventId, now) {
        const result = await getDb().execute<{ marked: boolean }>(sql`
      SELECT subetha_mark_push_delivery_if_current(
        ${snapshot.deliveryKeyHash},
        ${snapshot.endpoint},
        ${snapshot.p256dh},
        ${snapshot.auth},
        ${eventId},
        ${now}
      ) AS marked
    `);

        return result.rows[0]?.marked === true;
    },

    async releaseDelivery(pushKeyHash, eventId) {
        await getDb()
            .delete(pushDeliveries)
            .where(
                and(
                    eq(pushDeliveries.pushKeyHash, pushKeyHash),
                    eq(pushDeliveries.eventId, eventId),
                    eq(pushDeliveries.status, "pending"),
                ),
            );
    },

    async cleanupSubscriptions(cutoff, limit) {
        const result = await getDb().execute<{ removed: number }>(sql`
      SELECT subetha_cleanup_push_subscriptions(${cutoff}, ${limit}) AS removed
    `);

        return Number(result.rows[0]?.removed ?? 0);
    },

    async cleanupDeliveries(cutoff) {
        await getDb().delete(pushDeliveries).where(lte(pushDeliveries.updatedAt, cutoff));
    },
};
