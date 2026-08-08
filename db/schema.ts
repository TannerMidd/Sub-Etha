import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    pushKeyHash: text("push_key_hash").primaryKey(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastSuccessAt: integer("last_success_at"),
    rateWindowStart: integer("rate_window_start").notNull().default(0),
    rateCount: integer("rate_count").notNull().default(0),
  },
  (table) => [index("idx_push_subscriptions_updated_at").on(table.updatedAt)],
);

export const pushDeliveries = sqliteTable(
  "push_deliveries",
  {
    pushKeyHash: text("push_key_hash").notNull(),
    eventId: text("event_id").notNull(),
    status: text("status", { enum: ["pending", "sent"] }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.pushKeyHash, table.eventId] }),
    index("idx_push_deliveries_updated_at").on(table.updatedAt),
  ],
);
