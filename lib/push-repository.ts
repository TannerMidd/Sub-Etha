import { and, eq, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { pushDeliveries, pushSubscriptions } from "@/db/schema";

export interface StoredPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRepository {
  upsertSubscription(pushKeyHash: string, subscription: StoredPushSubscription, now: number): Promise<void>;
  deleteSubscription(pushKeyHash: string): Promise<void>;
  getSubscription(pushKeyHash: string): Promise<StoredPushSubscription | null>;
  consumeRateLimit(pushKeyHash: string, now: number, windowSeconds: number, limit: number): Promise<boolean>;
  claimDelivery(pushKeyHash: string, eventId: string, now: number, staleAfterSeconds: number): Promise<boolean>;
  markDelivered(pushKeyHash: string, eventId: string | null, now: number): Promise<void>;
  releaseDelivery(pushKeyHash: string, eventId: string): Promise<void>;
  cleanupDeliveries(cutoff: number): Promise<void>;
}

export const neonPushRepository: PushRepository = {
  async upsertSubscription(pushKeyHash, subscription, now) {
    await getDb().insert(pushSubscriptions).values({
      pushKeyHash,
      ...subscription,
      createdAt: now,
      updatedAt: now,
      rateWindowStart: now,
      rateCount: 0,
    }).onConflictDoUpdate({
      target: pushSubscriptions.pushKeyHash,
      set: {
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        updatedAt: now,
      },
    });
  },

  async deleteSubscription(pushKeyHash) {
    const db = getDb();
    await db.batch([
      db.delete(pushDeliveries).where(eq(pushDeliveries.pushKeyHash, pushKeyHash)),
      db.delete(pushSubscriptions).where(eq(pushSubscriptions.pushKeyHash, pushKeyHash)),
    ]);
  },

  async getSubscription(pushKeyHash) {
    const [subscription] = await getDb().select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    }).from(pushSubscriptions).where(eq(pushSubscriptions.pushKeyHash, pushKeyHash)).limit(1);
    return subscription ?? null;
  },

  async consumeRateLimit(pushKeyHash, now, windowSeconds, limit) {
    const [result] = await getDb().update(pushSubscriptions).set({
      rateCount: sql`CASE
        WHEN ${pushSubscriptions.rateWindowStart} <= ${now - windowSeconds} THEN 1
        ELSE ${pushSubscriptions.rateCount} + 1
      END`,
      rateWindowStart: sql`CASE
        WHEN ${pushSubscriptions.rateWindowStart} <= ${now - windowSeconds} THEN ${now}
        ELSE ${pushSubscriptions.rateWindowStart}
      END`,
    }).where(eq(pushSubscriptions.pushKeyHash, pushKeyHash)).returning({
      rateCount: pushSubscriptions.rateCount,
    });
    const count = Number(result?.rateCount ?? limit + 1);
    return count <= limit;
  },

  async claimDelivery(pushKeyHash, eventId, now, staleAfterSeconds) {
    const inserted = await getDb().insert(pushDeliveries).values({
      pushKeyHash,
      eventId,
      status: "pending",
      updatedAt: now,
    }).onConflictDoNothing().returning({ eventId: pushDeliveries.eventId });
    if (inserted.length > 0) return true;

    const reclaimed = await getDb().update(pushDeliveries).set({ updatedAt: now }).where(and(
      eq(pushDeliveries.pushKeyHash, pushKeyHash),
      eq(pushDeliveries.eventId, eventId),
      eq(pushDeliveries.status, "pending"),
      lte(pushDeliveries.updatedAt, now - staleAfterSeconds),
    )).returning({ eventId: pushDeliveries.eventId });
    return reclaimed.length > 0;
  },

  async markDelivered(pushKeyHash, eventId, now) {
    const db = getDb();
    const updates = [
      db.update(pushSubscriptions).set({ lastSuccessAt: now, updatedAt: now })
        .where(eq(pushSubscriptions.pushKeyHash, pushKeyHash)),
    ] as const;
    if (!eventId) {
      await updates[0];
      return;
    }
    await db.batch([
      updates[0],
      db.update(pushDeliveries).set({ status: "sent", updatedAt: now }).where(and(
        eq(pushDeliveries.pushKeyHash, pushKeyHash),
        eq(pushDeliveries.eventId, eventId),
      )),
    ]);
  },

  async releaseDelivery(pushKeyHash, eventId) {
    await getDb().delete(pushDeliveries).where(and(
      eq(pushDeliveries.pushKeyHash, pushKeyHash),
      eq(pushDeliveries.eventId, eventId),
      eq(pushDeliveries.status, "pending"),
    ));
  },

  async cleanupDeliveries(cutoff) {
    await getDb().delete(pushDeliveries).where(lte(pushDeliveries.updatedAt, cutoff));
  },
};
