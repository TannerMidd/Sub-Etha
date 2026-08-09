import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

function createDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  return drizzle(neon(connectionString), { schema });
}

let database: ReturnType<typeof createDatabase> | null = null;

export function getDb() {
  database ??= createDatabase();
  return database;
}
