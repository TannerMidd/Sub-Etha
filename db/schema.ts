import { bigint, index, primaryKey, pgTable, text } from "drizzle-orm/pg-core";

const epochSeconds = (name: string) => bigint(name, { mode: "number" });

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    pushKeyHash: text("push_key_hash").primaryKey(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: epochSeconds("created_at").notNull(),
    updatedAt: epochSeconds("updated_at").notNull(),
    lastSuccessAt: epochSeconds("last_success_at"),
    rateWindowStart: epochSeconds("rate_window_start").notNull().default(0),
    rateCount: bigint("rate_count", { mode: "number" }).notNull().default(0),
  },
  (table) => [index("idx_push_subscriptions_updated_at").on(table.updatedAt)],
);

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
