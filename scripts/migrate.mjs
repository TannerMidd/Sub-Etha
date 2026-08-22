import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = resolve(projectRoot, "drizzle");

function isNeonDatabase(connectionString) {
    const override = process.env.DATABASE_DRIVER?.trim().toLowerCase();

    if (override === "neon" || override === "postgres") {
        return override === "neon";
    }

    // Keep this rule in sync with `resolveDatabaseDriver()` in `db/index.ts`.
    return new URL(connectionString).hostname.endsWith(".neon.tech");
}

/**
 * Applies the committed Drizzle migrations with the same history table that
 * `drizzle-kit migrate` uses, so container startups and developer machines
 * share one migration state.
 */
async function main() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error("DATABASE_URL is not configured.");
    }

    if (isNeonDatabase(connectionString)) {
        const [{ neon }, { drizzle }, { migrate }] = await Promise.all([
            import("@neondatabase/serverless"),
            import("drizzle-orm/neon-http"),
            import("drizzle-orm/neon-http/migrator"),
        ]);

        await migrate(drizzle(neon(connectionString)), { migrationsFolder });

        return;
    }

    const pg = (await import("pg")).default;
    const [{ drizzle }, { migrate }] = await Promise.all([
        import("drizzle-orm/node-postgres"),
        import("drizzle-orm/node-postgres/migrator"),
    ]);

    const pool = new pg.Pool({ connectionString });

    try {
        await migrate(drizzle(pool), { migrationsFolder });
    } finally {
        await pool.end();
    }
}

main().then(
    () => {
        console.log("[migrate] Database schema is up to date.");
    },
    (error) => {
        console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`);

        process.exitCode = 1;
    },
);
