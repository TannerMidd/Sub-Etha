import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Server persistence runs on Neon PostgreSQL in production and on a vanilla
 * PostgreSQL server for fully local Docker deployments. Both drivers sit behind
 * this factory so callers only ever see one Drizzle database surface.
 *
 * The shared contract is intentionally the Neon HTTP database type: the push
 * repository was written against it, its `execute()` results expose `rows`,
 * and — unlike the pooled wire-protocol driver — it has no `transaction()`,
 * so code that would silently break the HTTP path stays a type error for
 * both drivers. Every operation used by the repository behaves identically
 * on either adapter.
 */
export type SubEthaDatabase = NeonHttpDatabase<typeof schema>;

type DatabaseDriver = "neon" | "postgres";

/**
 * Resolves which PostgreSQL client the connection string needs.
 *
 * - `DATABASE_DRIVER=neon|postgres` overrides detection explicitly.
 * - Otherwise, Neon-hosted databases use the Neon HTTP driver and every other
 *   host (local containers, self-hosted servers) uses the standard wire
 *   protocol driver. Keep `scripts/migrate.mjs` in sync with this rule.
 */
export function resolveDatabaseDriver(connectionString: string): DatabaseDriver {
    const configured = process.env.DATABASE_DRIVER?.trim().toLowerCase();

    if (configured === "neon" || configured === "postgres") {
        return configured;
    }

    const hostname = new URL(connectionString).hostname;

    return hostname.endsWith(".neon.tech") ? "neon" : "postgres";
}

function createNeonDatabase(connectionString: string): SubEthaDatabase {
    return drizzleNeonHttp(neon(connectionString), { schema });
}

function createPostgresDatabase(connectionString: string): SubEthaDatabase {
    const pool = new Pool({ connectionString });

    // Surface asynchronous pool failures (server restarts, dropped sockets)
    // in structured logs instead of letting them become unhandled errors.
    pool.on("error", (error) => {
        console.error(JSON.stringify({ event: "database_pool_error", message: error.message }));
    });

    // The wire-protocol driver exposes every operation this application
    // performs (verified against the push repository); it merely lacks the
    // Neon-only `$withAuth` and `batch` members, hence the two-step cast.
    return drizzleNodePostgres(pool, { schema }) as unknown as SubEthaDatabase;
}

function createDatabase(): SubEthaDatabase {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error("DATABASE_URL is not configured.");
    }

    let driver: DatabaseDriver;

    try {
        driver = resolveDatabaseDriver(connectionString);
    } catch (error) {
        throw new Error("DATABASE_URL is not a valid PostgreSQL connection string.", {
            cause: error,
        });
    }

    return driver === "neon"
        ? createNeonDatabase(connectionString)
        : createPostgresDatabase(connectionString);
}

let database: ReturnType<typeof createDatabase> | null = null;

export function getDb() {
    database ??= createDatabase();

    return database;
}
