CREATE TABLE "push_gateway_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"subscription_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_global_rate_budgets" (
	"name" text PRIMARY KEY NOT NULL,
	"window_start" bigint DEFAULT 0 NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_pending_subscriptions" (
	"management_key_hash" text PRIMARY KEY NOT NULL,
	"delivery_key_hash" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "management_key_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_pending_delivery_key" ON "push_pending_subscriptions" USING btree ("delivery_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_pending_challenge" ON "push_pending_subscriptions" USING btree ("challenge_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_pending_endpoint" ON "push_pending_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "idx_push_pending_expires_at" ON "push_pending_subscriptions" USING btree ("expires_at");--> statement-breakpoint
DELETE FROM "push_deliveries" AS delivery
USING (
    SELECT ranked."push_key_hash"
    FROM (
        SELECT
            "push_key_hash",
            ROW_NUMBER() OVER (
                PARTITION BY "endpoint"
                ORDER BY "updated_at" DESC, "created_at" DESC, "push_key_hash" DESC
            ) AS duplicate_rank
        FROM "push_subscriptions"
    ) AS ranked
    WHERE ranked.duplicate_rank > 1
) AS duplicate
WHERE delivery."push_key_hash" = duplicate."push_key_hash";--> statement-breakpoint
DELETE FROM "push_subscriptions" AS subscription
USING (
    SELECT ranked."push_key_hash"
    FROM (
        SELECT
            "push_key_hash",
            ROW_NUMBER() OVER (
                PARTITION BY "endpoint"
                ORDER BY "updated_at" DESC, "created_at" DESC, "push_key_hash" DESC
            ) AS duplicate_rank
        FROM "push_subscriptions"
    ) AS ranked
    WHERE ranked.duplicate_rank > 1
) AS duplicate
WHERE subscription."push_key_hash" = duplicate."push_key_hash";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_subscriptions_endpoint" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_subscriptions_management_key" ON "push_subscriptions" USING btree ("management_key_hash");--> statement-breakpoint
ALTER TABLE "push_gateway_state"
ADD CONSTRAINT "push_gateway_state_singleton" CHECK ("id" = 1);--> statement-breakpoint
ALTER TABLE "push_gateway_state"
ADD CONSTRAINT "push_gateway_state_nonnegative" CHECK ("subscription_count" >= 0);--> statement-breakpoint
ALTER TABLE "push_global_rate_budgets"
ADD CONSTRAINT "push_global_rate_budgets_nonnegative" CHECK ("request_count" >= 0);--> statement-breakpoint
INSERT INTO "push_gateway_state" ("id", "subscription_count")
VALUES (1, (SELECT COUNT(*) FROM "push_subscriptions"))
ON CONFLICT ("id") DO UPDATE
SET "subscription_count" = EXCLUDED."subscription_count";--> statement-breakpoint
INSERT INTO "push_global_rate_budgets" ("name", "window_start", "request_count")
VALUES
    ('subscription-mutations', 0, 0),
    ('test-sends', 0, 0),
    ('matrix-notify', 0, 0),
    ('outbound-deliveries', 0, 0)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_update_push_subscription_count"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE "push_gateway_state"
        SET "subscription_count" = "subscription_count" + 1
        WHERE "id" = 1;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE "push_gateway_state"
        SET "subscription_count" = GREATEST(0, "subscription_count" - 1)
        WHERE "id" = 1;
    END IF;
    RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "push_subscription_count" ON "push_subscriptions";--> statement-breakpoint
CREATE TRIGGER "push_subscription_count"
AFTER INSERT OR DELETE ON "push_subscriptions"
FOR EACH ROW
EXECUTE FUNCTION "subetha_update_push_subscription_count"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_begin_push_subscription_registration"(
    p_delivery_key_hash text,
    p_management_key_hash text,
    p_endpoint text,
    p_p256dh text,
    p_auth text,
    p_challenge_hash text,
    p_now bigint,
    p_challenge_expires_at bigint,
    p_maximum_subscriptions bigint,
    p_maximum_pending_subscriptions bigint
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing "push_subscriptions"%ROWTYPE;
    v_endpoint_key text;
    v_subscription_count bigint;
    v_pending_count bigint;
BEGIN
    SELECT "subscription_count"
    INTO v_subscription_count
    FROM "push_gateway_state"
    WHERE "id" = 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Push gateway state is missing';
    END IF;

    DELETE FROM "push_pending_subscriptions" WHERE "expires_at" <= p_now;

    SELECT *
    INTO v_existing
    FROM "push_subscriptions"
    WHERE "push_key_hash" = p_delivery_key_hash
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing."management_key_hash" IS NOT NULL
            AND v_existing."management_key_hash" <> p_management_key_hash THEN
            RETURN 'management_conflict';
        END IF;
        IF v_existing."management_key_hash" IS NULL
            AND (
                v_existing."endpoint" <> p_endpoint
                OR v_existing."p256dh" <> p_p256dh
                OR v_existing."auth" <> p_auth
            ) THEN
            RETURN 'management_conflict';
        END IF;

        SELECT "push_key_hash"
        INTO v_endpoint_key
        FROM "push_subscriptions"
        WHERE "endpoint" = p_endpoint
          AND "push_key_hash" <> p_delivery_key_hash
        FOR UPDATE;
        IF v_endpoint_key IS NOT NULL THEN
            DELETE FROM "push_deliveries" WHERE "push_key_hash" = v_endpoint_key;
            DELETE FROM "push_subscriptions" WHERE "push_key_hash" = v_endpoint_key;
        END IF;

        UPDATE "push_subscriptions"
        SET
            "management_key_hash" = p_management_key_hash,
            "endpoint" = p_endpoint,
            "p256dh" = p_p256dh,
            "auth" = p_auth,
            "updated_at" = p_now
        WHERE "push_key_hash" = p_delivery_key_hash;
        DELETE FROM "push_pending_subscriptions"
        WHERE "delivery_key_hash" = p_delivery_key_hash
           OR "management_key_hash" = p_management_key_hash
           OR "endpoint" = p_endpoint;
        RETURN 'active';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "push_subscriptions"
        WHERE "management_key_hash" = p_management_key_hash
    ) THEN
        RETURN 'management_conflict';
    END IF;

    IF v_subscription_count >= p_maximum_subscriptions THEN
        RETURN 'capacity_exceeded';
    END IF;

    DELETE FROM "push_pending_subscriptions"
    WHERE "delivery_key_hash" = p_delivery_key_hash
       OR "management_key_hash" = p_management_key_hash
       OR "endpoint" = p_endpoint;

    SELECT COUNT(*) INTO v_pending_count FROM "push_pending_subscriptions";
    IF v_pending_count >= p_maximum_pending_subscriptions THEN
        RETURN 'pending_capacity_exceeded';
    END IF;

    INSERT INTO "push_pending_subscriptions" (
        "management_key_hash",
        "delivery_key_hash",
        "challenge_hash",
        "endpoint",
        "p256dh",
        "auth",
        "created_at",
        "expires_at"
    ) VALUES (
        p_management_key_hash,
        p_delivery_key_hash,
        p_challenge_hash,
        p_endpoint,
        p_p256dh,
        p_auth,
        p_now,
        p_challenge_expires_at
    );
    RETURN 'challenge_required';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_confirm_push_subscription"(
    p_challenge_hash text,
    p_now bigint,
    p_maximum_subscriptions bigint
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pending "push_pending_subscriptions"%ROWTYPE;
    v_endpoint_key text;
    v_subscription_count bigint;
    v_outcome text := 'created';
BEGIN
    SELECT "subscription_count"
    INTO v_subscription_count
    FROM "push_gateway_state"
    WHERE "id" = 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Push gateway state is missing';
    END IF;

    SELECT *
    INTO v_pending
    FROM "push_pending_subscriptions"
    WHERE "challenge_hash" = p_challenge_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'invalid_challenge';
    END IF;
    IF v_pending."expires_at" <= p_now THEN
        DELETE FROM "push_pending_subscriptions"
        WHERE "management_key_hash" = v_pending."management_key_hash";
        RETURN 'expired_challenge';
    END IF;

    SELECT "push_key_hash"
    INTO v_endpoint_key
    FROM "push_subscriptions"
    WHERE "endpoint" = v_pending."endpoint"
    FOR UPDATE;
    IF v_endpoint_key IS NOT NULL AND v_endpoint_key <> v_pending."delivery_key_hash" THEN
        DELETE FROM "push_deliveries" WHERE "push_key_hash" = v_endpoint_key;
        DELETE FROM "push_subscriptions" WHERE "push_key_hash" = v_endpoint_key;
        v_outcome := 'reassigned';
    END IF;

    IF v_outcome <> 'reassigned' AND v_subscription_count >= p_maximum_subscriptions THEN
        RETURN 'capacity_exceeded';
    END IF;

    INSERT INTO "push_subscriptions" (
        "push_key_hash",
        "management_key_hash",
        "endpoint",
        "p256dh",
        "auth",
        "created_at",
        "updated_at",
        "rate_window_start",
        "rate_count"
    ) VALUES (
        v_pending."delivery_key_hash",
        v_pending."management_key_hash",
        v_pending."endpoint",
        v_pending."p256dh",
        v_pending."auth",
        p_now,
        p_now,
        p_now,
        0
    )
    ON CONFLICT ("push_key_hash") DO UPDATE
    SET
        "management_key_hash" = EXCLUDED."management_key_hash",
        "endpoint" = EXCLUDED."endpoint",
        "p256dh" = EXCLUDED."p256dh",
        "auth" = EXCLUDED."auth",
        "updated_at" = EXCLUDED."updated_at";

    DELETE FROM "push_pending_subscriptions"
    WHERE "management_key_hash" = v_pending."management_key_hash";
    RETURN v_outcome;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_cleanup_push_subscriptions"(
    p_cutoff bigint,
    p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys text[];
    v_removed integer := 0;
BEGIN
    SELECT ARRAY_AGG(stale."push_key_hash")
    INTO v_keys
    FROM (
        SELECT "push_key_hash"
        FROM "push_subscriptions"
        WHERE "updated_at" <= p_cutoff
        ORDER BY "updated_at", "push_key_hash"
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ) AS stale;

    IF COALESCE(ARRAY_LENGTH(v_keys, 1), 0) = 0 THEN
        RETURN 0;
    END IF;

    DELETE FROM "push_deliveries" WHERE "push_key_hash" = ANY(v_keys);
    DELETE FROM "push_subscriptions" WHERE "push_key_hash" = ANY(v_keys);
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    RETURN v_removed;
END;
$$;
