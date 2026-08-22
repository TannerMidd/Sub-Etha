import pg from "pg";

const DEFAULT_TIMEOUT_SECONDS = 60;
const RETRY_DELAY_MS = 1_000;

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * Blocks until the configured PostgreSQL server accepts a query. Used by the
 * container entrypoint so migrations never race database startup. Neon-hosted
 * databases have no persistent connection to wait for, so they pass
 * immediately.
 */
async function main() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        console.error("[wait-for-db] DATABASE_URL is not configured.");

        process.exitCode = 1;

        return;
    }

    let hostname;

    try {
        hostname = new URL(connectionString).hostname;
    } catch (error) {
        console.error(
            `[wait-for-db] DATABASE_URL is not a valid connection string: ${String(error)}`,
        );

        process.exitCode = 1;

        return;
    }

    const override = process.env.DATABASE_DRIVER?.trim().toLowerCase();

    if (override === "neon" || (!override && hostname.endsWith(".neon.tech"))) {
        console.log("[wait-for-db] Neon HTTP endpoint needs no connection warm-up.");

        return;
    }

    const deadline = Date.now() + DEFAULT_TIMEOUT_SECONDS * 1_000;
    let lastError;

    while (Date.now() < deadline) {
        const client = new pg.Client({ connectionString });

        try {
            await client.connect();
            await client.query("SELECT 1");
            await client.end();

            console.log("[wait-for-db] PostgreSQL is accepting connections.");

            return;
        } catch (error) {
            lastError = error;
            await client.end().catch(() => undefined);
            await sleep(RETRY_DELAY_MS);
        }
    }

    console.error(
        `[wait-for-db] PostgreSQL was not reachable within ${DEFAULT_TIMEOUT_SECONDS}s: ${
            lastError instanceof Error ? lastError.message : String(lastError)
        }`,
    );

    process.exitCode = 1;
}

main();
