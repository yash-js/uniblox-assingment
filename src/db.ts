import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";
import { env } from "./config.js";

const adapter = new PrismaBetterSqlite3({ url: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

/**
 * journal_mode=WAL: readers can proceed while a writer holds the lock, which
 * matters under concurrent checkout traffic on a single SQLite file.
 * busy_timeout=5000: if another connection holds the write lock, wait up to
 * 5 seconds instead of failing immediately with SQLITE_BUSY.
 */
export async function applySqlitePragmas(): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$executeRawUnsafe("PRAGMA busy_timeout = 5000");
}

export const sqliteReady = applySqlitePragmas();
