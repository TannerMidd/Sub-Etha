CREATE TABLE "push_revoked_management_keys" (
	"management_key_hash" text PRIMARY KEY NOT NULL,
	"revoked_at" bigint NOT NULL
);
--> statement-breakpoint
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
BEGIN
    PERFORM 1 FROM "push_gateway_state" WHERE "id" = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Push gateway state is missing';
    END IF;

    SELECT "push_key_hash" INTO v_delivery_key_hash
    FROM "push_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash
    FOR UPDATE;

    SELECT "management_key_hash" INTO v_pending_management_key_hash
    FROM "push_pending_subscriptions"
    WHERE "management_key_hash" = p_management_key_hash
    FOR UPDATE;

    -- Management capabilities are random and cannot be safely reused. This table is deliberately
    -- append-only so a delayed browser request can never resurrect a revoked capability.
    INSERT INTO "push_revoked_management_keys" (
        "management_key_hash", "revoked_at"
    ) VALUES (
        p_management_key_hash, p_now
    )
    ON CONFLICT ("management_key_hash") DO UPDATE
    SET "revoked_at" = EXCLUDED."revoked_at";

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
$$;
--> statement-breakpoint
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
    SELECT "subscription_count" INTO v_subscription_count
    FROM "push_gateway_state" WHERE "id" = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Push gateway state is missing';
    END IF;

    DELETE FROM "push_pending_subscriptions" WHERE "expires_at" <= p_now;
    IF EXISTS (
        SELECT 1 FROM "push_revoked_management_keys"
        WHERE "management_key_hash" = p_management_key_hash
    ) THEN
        RETURN 'revoked';
    END IF;

    SELECT * INTO v_existing
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

        SELECT "push_key_hash" INTO v_endpoint_key
        FROM "push_subscriptions"
        WHERE "endpoint" = p_endpoint AND "push_key_hash" <> p_delivery_key_hash
        FOR UPDATE;
        IF v_endpoint_key IS NOT NULL THEN
            DELETE FROM "push_deliveries" WHERE "push_key_hash" = v_endpoint_key;
            DELETE FROM "push_subscriptions" WHERE "push_key_hash" = v_endpoint_key;
        END IF;

        UPDATE "push_subscriptions"
        SET "management_key_hash" = p_management_key_hash,
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
        "management_key_hash", "delivery_key_hash", "challenge_hash",
        "endpoint", "p256dh", "auth", "created_at", "expires_at"
    ) VALUES (
        p_management_key_hash, p_delivery_key_hash, p_challenge_hash,
        p_endpoint, p_p256dh, p_auth, p_now, p_challenge_expires_at
    );
    RETURN 'challenge_required';
END;
$$;
--> statement-breakpoint
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
    SELECT "subscription_count" INTO v_subscription_count
    FROM "push_gateway_state" WHERE "id" = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Push gateway state is missing';
    END IF;

    SELECT * INTO v_pending
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
    IF EXISTS (
        SELECT 1 FROM "push_revoked_management_keys"
        WHERE "management_key_hash" = v_pending."management_key_hash"
    ) THEN
        DELETE FROM "push_pending_subscriptions"
        WHERE "management_key_hash" = v_pending."management_key_hash";
        RETURN 'revoked';
    END IF;

    SELECT "push_key_hash" INTO v_endpoint_key
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
        "push_key_hash", "management_key_hash", "endpoint", "p256dh", "auth",
        "created_at", "updated_at", "rate_window_start", "rate_count"
    ) VALUES (
        v_pending."delivery_key_hash", v_pending."management_key_hash",
        v_pending."endpoint", v_pending."p256dh", v_pending."auth",
        p_now, p_now, p_now, 0
    )
    ON CONFLICT ("push_key_hash") DO UPDATE
    SET "management_key_hash" = EXCLUDED."management_key_hash",
        "endpoint" = EXCLUDED."endpoint",
        "p256dh" = EXCLUDED."p256dh",
        "auth" = EXCLUDED."auth",
        "updated_at" = EXCLUDED."updated_at";

    DELETE FROM "push_pending_subscriptions"
    WHERE "management_key_hash" = v_pending."management_key_hash";
    RETURN v_outcome;
END;
$$;
