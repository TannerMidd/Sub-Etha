CREATE TABLE "push_deliveries" (
	"push_key_hash" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "push_deliveries_push_key_hash_event_id_pk" PRIMARY KEY("push_key_hash","event_id")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"push_key_hash" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_success_at" bigint,
	"rate_window_start" bigint DEFAULT 0 NOT NULL,
	"rate_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_push_deliveries_updated_at" ON "push_deliveries" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_push_subscriptions_updated_at" ON "push_subscriptions" USING btree ("updated_at");