import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDbPath = path.join(root, "prisma", "test.db");
const testDbJournalPath = `${testDbPath}-journal`;

function removeIfExists(filePath: string) {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export default async function globalSetup() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file:./prisma/test.db";

  removeIfExists(testDbPath);
  removeIfExists(testDbJournalPath);

  const env = {
    ...process.env,
    DATABASE_URL: "file:./prisma/test.db",
    NODE_ENV: "test",
  };

  execSync("npx prisma migrate deploy", {
    cwd: root,
    env,
    stdio: "inherit",
  });

  execSync("npx prisma db seed", {
    cwd: root,
    env,
    stdio: "inherit",
  });
}
