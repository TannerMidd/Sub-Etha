import {
    bigint,
    index,
    integer,
    primaryKey,
    pgTable,
    text,
    uniqueIndex,
} from "drizzle-orm/pg-core";

const epochSeconds = (name: string) => bigint(name, { mode: "number" });

export const pushSubscriptions = pgTable(
    "push_subscriptions",
    {
        pushKeyHash: text("push_key_hash").primaryKey(),
        managementKeyHash: text("management_key_hash"),
        endpoint: text("endpoint").notNull(),
        p256dh: text("p256dh").notNull(),
        auth: text("auth").notNull(),
        createdAt: epochSeconds("created_at").notNull(),
        updatedAt: epochSeconds("updated_at").notNull(),
        lastSuccessAt: epochSeconds("last_success_at"),
        rateWindowStart: epochSeconds("rate_window_start").notNull().default(0),
        rateCount: bigint("rate_count", { mode: "number" }).notNull().default(0),
    },
    (table) => [
        index("idx_push_subscriptions_updated_at").on(table.updatedAt),
        uniqueIndex("uq_push_subscriptions_endpoint").on(table.endpoint),
        uniqueIndex("uq_push_subscriptions_management_key").on(table.managementKeyHash),
    ],
);

export const pushPendingSubscriptions = pgTable(
    "push_pending_subscriptions",
    {
        managementKeyHash: text("management_key_hash").primaryKey(),
        deliveryKeyHash: text("delivery_key_hash").notNull(),
        challengeHash: text("challenge_hash").notNull(),
        endpoint: text("endpoint").notNull(),
        p256dh: text("p256dh").notNull(),
        auth: text("auth").notNull(),
        createdAt: epochSeconds("created_at").notNull(),
        expiresAt: epochSeconds("expires_at").notNull(),
    },
    (table) => [
        uniqueIndex("uq_push_pending_delivery_key").on(table.deliveryKeyHash),
        uniqueIndex("uq_push_pending_challenge").on(table.challengeHash),
        uniqueIndex("uq_push_pending_endpoint").on(table.endpoint),
        index("idx_push_pending_expires_at").on(table.expiresAt),
    ],
);

export const pushRevokedManagementKeys = pgTable("push_revoked_management_keys", {
    managementKeyHash: text("management_key_hash").primaryKey(),
    revokedAt: epochSeconds("revoked_at").notNull(),
});

export const pushGatewayState = pgTable("push_gateway_state", {
    id: integer("id").primaryKey(),
    subscriptionCount: bigint("subscription_count", { mode: "number" }).notNull().default(0),
    revokedManagementKeyCount: bigint("revoked_management_key_count", { mode: "number" })
        .notNull()
        .default(0),
    revokedManagementKeyLimit: bigint("revoked_management_key_limit", { mode: "number" }).default(
        100_000,
    ),
});

export const pushGlobalRateBudgets = pgTable("push_global_rate_budgets", {
    name: text("name").primaryKey(),
    windowStart: epochSeconds("window_start").notNull().default(0),
    requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
});

export const pushDeliveries = pgTable(
    "push_deliveries",
    {
        pushKeyHash: text("push_key_hash").notNull(),
        eventId: text("event_id").notNull(),
        status: text("status", { enum: ["pending", "sent"] }).notNull(),
        updatedAt: epochSeconds("updated_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.pushKeyHash, table.eventId] }),
        index("idx_push_deliveries_updated_at").on(table.updatedAt),
    ],
);
