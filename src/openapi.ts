import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { parse } from "yaml";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openapiPath = path.join(rootDir, "openapi.yaml");

export const openapiDocument = parse(
  readFileSync(openapiPath, "utf8"),
) as Record<string, unknown>;

/**
 * Spec for HTTP responses: servers always match the browser origin (works
 * behind HTTPS reverse proxies). Falls back to relative "/" when host is missing.
 */
export function openApiDocumentForRequest(
  req: Request,
): Record<string, unknown> {
  const protoHeader = req.get("x-forwarded-proto");
  const hostHeader = req.get("x-forwarded-host") ?? req.get("host");
  const proto = (protoHeader?.split(",")[0] ?? req.protocol).trim();
  const host = hostHeader?.split(",")[0]?.trim();

  const serverUrl = host ? `${proto}://${host}` : "/";

  return {
    ...openapiDocument,
    servers: [
      {
        url: serverUrl,
        description: "Same origin as these docs",
      },
    ],
  };
}
