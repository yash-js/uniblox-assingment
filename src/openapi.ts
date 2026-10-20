import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openapiPath = path.join(rootDir, "openapi.yaml");

export const openapiDocument = parse(
  readFileSync(openapiPath, "utf8"),
) as Record<string, unknown>;
