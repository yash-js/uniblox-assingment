process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file:./prisma/test.db";

const { sqliteReady } = await import("../src/db.js");
await sqliteReady;
