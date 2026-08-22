#!/bin/sh
# Container entrypoint: prepare push keys, wait for PostgreSQL, migrate, serve.
set -eu

state_dir="${SUB_ETHA_STATE_DIR:-/app/state}"
vapid_file="${SUB_ETHA_VAPID_FILE:-${state_dir}/vapid.json}"

mkdir -p "${state_dir}"

ensure_vapid_keys() {
    if [ -n "${VAPID_PUBLIC_KEY:-}" ] && [ -n "${VAPID_PRIVATE_KEY:-}" ]; then
        echo "[entrypoint] Using VAPID keys from the environment."
        return 0
    fi

    if [ ! -f "${vapid_file}" ]; then
        echo "[entrypoint] Generating Web Push (VAPID) keys; they persist in ${vapid_file}."
        node scripts/generate-vapid-keys.mjs "${vapid_file}" || {
            echo "[entrypoint] WARNING: VAPID key generation failed; closed-app notifications stay disabled."
            return 0
        }
    fi

    if VAPID_PUBLIC_KEY="$(node -p 'require(process.argv[1]).publicKey' "${vapid_file}" 2>/dev/null)" &&
        VAPID_PRIVATE_KEY="$(node -p 'require(process.argv[1]).privateKey' "${vapid_file}" 2>/dev/null)"; then
        export VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
        echo "[entrypoint] Using stored VAPID keys."
    else
        echo "[entrypoint] WARNING: stored VAPID keys are unreadable; closed-app notifications stay disabled."
    fi
}

ensure_vapid_keys

if [ -z "${VAPID_SUBJECT:-}" ]; then
    VAPID_SUBJECT="http://localhost:${PORT:-3000}"
    export VAPID_SUBJECT
fi

echo "[entrypoint] Waiting for PostgreSQL ..."
node scripts/wait-for-db.mjs

echo "[entrypoint] Applying database migrations ..."
node scripts/migrate.mjs

echo "[entrypoint] Starting Sub-Etha on http://0.0.0.0:${PORT:-3000} ..."
exec node .output/server/index.mjs
