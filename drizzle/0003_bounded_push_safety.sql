ALTER TABLE "push_gateway_state"
ADD COLUMN "revoked_management_key_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_gateway_state"
ADD COLUMN "revoked_management_key_limit" bigint DEFAULT 100000;--> statement-breakpoint
UPDATE "push_gateway_state"
SET "revoked_management_key_count" = (
    SELECT COUNT(*) FROM "push_revoked_management_keys"
);--> statement-breakpoint
ALTER TABLE "push_gateway_state"
ADD CONSTRAINT "push_gateway_state_revoked_management_key_count_nonnegative"
CHECK ("revoked_management_key_count" >= 0);--> statement-breakpoint
ALTER TABLE "push_gateway_state"
ADD CONSTRAINT "push_gateway_state_revoked_management_key_limit_positive"
CHECK ("revoked_management_key_limit" IS NULL OR "revoked_management_key_limit" > 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_update_revoked_management_key_count"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE "push_gateway_state"
        SET "revoked_management_key_count" = "revoked_management_key_count" + 1
        WHERE "id" = 1;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE "push_gateway_state"
        SET "revoked_management_key_count" = GREATEST(0, "revoked_management_key_count" - 1)
        WHERE "id" = 1;
    END IF;
    RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "push_revoked_management_key_count" ON "push_revoked_management_keys";--> statement-breakpoint
CREATE TRIGGER "push_revoked_management_key_count"
AFTER INSERT OR DELETE ON "push_revoked_management_keys"
FOR EACH ROW
EXECUTE FUNCTION "subetha_update_revoked_management_key_count"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_delete_push_subscription"(
    p_management_key_hash text,
    p_now bigint
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_delivery_key_hash text;
    v_pending_management_key_hash text;
    v_has_tombstone boolean;
    v_revoked_limit bigint;
BEGIN
    PERFORM 1 FROM "push_gateway_state" WHERE "id" = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Push gateway state is missing';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "push_revoked_management_keys"
        WHERE "management_key_hash" = p_management_key_hash
    ) INTO v_has_tombstone;
    SELECT "revoked_management_key_limit" INTO v_revoked_limit
    FROM "push_gateway_state" WHERE "id" = 1;

    IF NOT v_has_tombstone AND v_revoked_limit IS NULL THEN
        RAISE EXCEPTION 'Revoked management-key capacity is not configured for legacy deletion'
            USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_has_tombstone AND (
        SELECT "revoked_management_key_count"
        FROM "push_gateway_state" WHERE "id" = 1
    ) >= v_revoked_limit THEN
        RAISE EXCEPTION 'Revoked management-key capacity exceeded'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT "push_key_hash" INTO v_delivery_key_hash
    FROM "push_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash
    FOR UPDATE;

    SELECT "management_key_hash" INTO v_pending_management_key_hash
    FROM "push_pending_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash
    FOR UPDATE;

    IF NOT v_has_tombstone THEN
        INSERT INTO "push_revoked_management_keys" (
            "management_key_hash", "revoked_at"
        ) VALUES (
            p_management_key_hash, p_now
        );
    END IF;

    IF v_delivery_key_hash IS NULL AND v_pending_management_key_hash IS NULL THEN
        RETURN false;
    END IF;

    DELETE FROM "push_pending_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash;

    IF v_delivery_key_hash IS NOT NULL THEN
        DELETE FROM "push_deliveries" WHERE "push_key_hash" = v_delivery_key_hash;
        DELETE FROM "push_subscriptions"
        WHERE "management_key_hash" = p_management_key_hash;
    END IF;

    RETURN true;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_delete_push_subscription"(
    p_management_key_hash text,
    p_now bigint,
    p_maximum_revoked_management_keys bigint
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_delivery_key_hash text;
    v_pending_management_key_hash text;
    v_has_tombstone boolean;
    v_revoked_count bigint;
    v_revoked_limit bigint;
BEGIN
    IF p_maximum_revoked_management_keys <= 0 THEN
        RAISE EXCEPTION 'Maximum revoked management-key capacity must be positive'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT "revoked_management_key_count", "revoked_management_key_limit"
    INTO v_revoked_count, v_revoked_limit
    FROM "push_gateway_state" WHERE "id" = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Push gateway state is missing';
    END IF;

    IF v_revoked_limit IS NULL THEN
        v_revoked_limit := p_maximum_revoked_management_keys;
        UPDATE "push_gateway_state"
        SET "revoked_management_key_limit" = v_revoked_limit
        WHERE "id" = 1;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "push_revoked_management_keys"
        WHERE "management_key_hash" = p_management_key_hash
    ) INTO v_has_tombstone;

    IF NOT v_has_tombstone AND v_revoked_count >= v_revoked_limit THEN
        RETURN 'capacity_exceeded';
    END IF;

    SELECT "push_key_hash" INTO v_delivery_key_hash
    FROM "push_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash
    FOR UPDATE;

    SELECT "management_key_hash" INTO v_pending_management_key_hash
    FROM "push_pending_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash
    FOR UPDATE;

    IF NOT v_has_tombstone THEN
        INSERT INTO "push_revoked_management_keys" (
            "management_key_hash", "revoked_at"
        ) VALUES (
            p_management_key_hash, p_now
        );
    END IF;

    IF v_delivery_key_hash IS NULL AND v_pending_management_key_hash IS NULL THEN
        RETURN 'not_found';
    END IF;

    DELETE FROM "push_pending_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash;

    IF v_delivery_key_hash IS NOT NULL THEN
        DELETE FROM "push_deliveries" WHERE "push_key_hash" = v_delivery_key_hash;
        DELETE FROM "push_subscriptions"
        WHERE "management_key_hash" = p_management_key_hash;
    END IF;

    RETURN 'removed';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_delete_push_subscription_if_current"(
    p_delivery_key_hash text,
    p_endpoint text,
    p_p256dh text,
    p_auth text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_removed boolean;
BEGIN
    WITH removed AS (
        DELETE FROM "push_subscriptions"
        WHERE "push_key_hash" = p_delivery_key_hash
          AND "endpoint" = p_endpoint
          AND "p256dh" = p_p256dh
          AND "auth" = p_auth
        RETURNING "push_key_hash"
    ), deleted_deliveries AS (
        DELETE FROM "push_deliveries" AS delivery
        USING removed
        WHERE delivery."push_key_hash" = removed."push_key_hash"
    )
    SELECT EXISTS (SELECT 1 FROM removed) INTO v_removed;

    RETURN v_removed;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "subetha_mark_push_delivery_if_current"(
    p_delivery_key_hash text,
    p_endpoint text,
    p_p256dh text,
    p_auth text,
    p_event_id text,
    p_now bigint
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_current boolean := false;
BEGIN
    WITH current_subscription AS (
        UPDATE "push_subscriptions"
        SET "last_success_at" = p_now, "updated_at" = p_now
        WHERE "push_key_hash" = p_delivery_key_hash
          AND "endpoint" = p_endpoint
          AND "p256dh" = p_p256dh
          AND "auth" = p_auth
        RETURNING "push_key_hash"
    ), marked_delivery AS (
        UPDATE "push_deliveries" AS delivery
        SET "status" = 'sent', "updated_at" = p_now
        FROM current_subscription
        WHERE p_event_id IS NOT NULL
          AND delivery."push_key_hash" = current_subscription."push_key_hash"
          AND delivery."event_id" = p_event_id
        RETURNING delivery."push_key_hash"
    )
    SELECT EXISTS (SELECT 1 FROM current_subscription) INTO v_current;

    RETURN v_current;
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
    v_removed integer := 0;
BEGIN
    WITH stale AS (
        SELECT "push_key_hash", "updated_at"
        FROM "push_subscriptions"
        WHERE "updated_at" <= p_cutoff
        ORDER BY "updated_at", "push_key_hash"
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ), removed AS (
        DELETE FROM "push_subscriptions" AS subscription
        USING stale
        WHERE subscription."push_key_hash" = stale."push_key_hash"
          AND subscription."updated_at" = stale."updated_at"
          AND subscription."updated_at" <= p_cutoff
        RETURNING subscription."push_key_hash"
    ), deleted_deliveries AS (
        DELETE FROM "push_deliveries" AS delivery
        USING removed
        WHERE delivery."push_key_hash" = removed."push_key_hash"
    )
    SELECT COUNT(*) INTO v_removed FROM removed;

    RETURN v_removed;
END;
$$;
