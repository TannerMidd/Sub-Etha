CREATE TABLE `push_deliveries` (
	`push_key_hash` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`push_key_hash`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_push_deliveries_updated_at` ON `push_deliveries` (`updated_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`push_key_hash` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_success_at` integer,
	`rate_window_start` integer DEFAULT 0 NOT NULL,
	`rate_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_push_subscriptions_updated_at` ON `push_subscriptions` (`updated_at`);