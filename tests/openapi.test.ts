import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { SEED_PRODUCTS } from "../prisma/seed.js";
import { app } from "../src/app.js";
import { openapiDocument } from "../src/openapi.js";
import { adminRouter } from "../src/routes/admin.routes.js";
import { cartsRouter } from "../src/routes/carts.routes.js";
import { checkoutRouter } from "../src/routes/checkout.routes.js";
import { ordersRouter } from "../src/routes/orders.routes.js";
import { productsRouter } from "../src/routes/products.routes.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openapiPath = path.join(rootDir, "openapi.yaml");

type RouteKey = `${string} ${string}`;

type Layer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
  handle?: {
    stack?: Layer[];
  };
};

function joinPaths(prefix: string, routePath: string): string {
  if (routePath === "/") {
    return prefix === "" ? "/" : prefix;
  }
  const combined = `${prefix}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
  return combined.replace(/\/{2,}/g, "/");
}

function collectFromStack(stack: Layer[], prefix: string): RouteKey[] {
  const routes: RouteKey[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) {
          routes.push(
            `${method.toUpperCase()} ${joinPaths(prefix, layer.route.path)}` as RouteKey,
          );
        }
      }
    }
  }
  return routes;
}

function collectAppRoutes(): RouteKey[] {
  const router = (app as unknown as { router: { stack: Layer[] } }).router;
  const mountByHandle = new Map<object, string>([
    [productsRouter as object, "/products"],
    [cartsRouter as object, "/carts"],
    [checkoutRouter as object, "/carts"],
    [ordersRouter as object, "/orders"],
    [adminRouter as object, "/admin"],
  ]);

  const routes: RouteKey[] = [];

  for (const layer of router.stack) {
    if (layer.route) {
      routes.push(...collectFromStack([layer], ""));
      continue;
    }

    if (!layer.handle?.stack) {
      continue;
    }

    const prefix = mountByHandle.get(layer.handle as object);
    if (prefix === undefined) {
      // swagger-ui and other non-API mounts
      continue;
    }

    routes.push(...collectFromStack(layer.handle.stack, prefix));
  }

  return [...new Set(routes)].sort();
}

function collectSpecRoutes(doc: Record<string, unknown>): RouteKey[] {
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  const routes: RouteKey[] = [];
  for (const [pathKey, operations] of Object.entries(paths)) {
    for (const method of Object.keys(operations)) {
      if (
        ["get", "post", "put", "patch", "delete", "options", "head"].includes(
          method,
        )
      ) {
        routes.push(`${method.toUpperCase()} ${pathKey}` as RouteKey);
      }
    }
  }
  return [...new Set(routes)].sort();
}

/** Normalize Express `:id` and OpenAPI `{productId}` to the same shape. */
function normalizePathTemplate(routePath: string): string {
  return routePath
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{param}")
    .replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, "{param}");
}

function collectErrorCodesFromSource(): Set<string> {
  const srcDir = path.join(rootDir, "src");
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "generated") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
  }

  walk(srcDir);

  const codes = new Set<string>();
  const patterns = [
    /\b(?:notFound|badRequest|conflict|unprocessable)\(\s*["']([A-Z0-9_]+)["']/g,
    /\bcode:\s*["']([A-Z0-9_]+)["']/g,
  ];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        codes.add(match[1]!);
      }
    }
  }

  return codes;
}

describe("openapi", () => {
  it("validates openapi.yaml as OpenAPI 3", async () => {
    await expect(SwaggerParser.validate(openapiPath)).resolves.toBeTruthy();
  });

  it("keeps app routes and spec paths in sync", () => {
    const appRoutes = collectAppRoutes()
      .filter((route) => {
        const [, pathKey] = route.split(" ");
        return (
          pathKey &&
          !pathKey.startsWith("/__test") &&
          !pathKey.startsWith("/docs") &&
          pathKey !== "/openapi.json"
        );
      })
      .map((route) => {
        const [method, pathKey] = route.split(" ");
        return `${method} ${normalizePathTemplate(pathKey!)}` as RouteKey;
      })
      .sort();

    const specRoutes = collectSpecRoutes(openapiDocument).map((route) => {
      const [method, pathKey] = route.split(" ");
      return `${method} ${normalizePathTemplate(pathKey!)}` as RouteKey;
    });

    const missingFromSpec = appRoutes.filter((route) => !specRoutes.includes(route));
    const missingFromApp = specRoutes.filter((route) => !appRoutes.includes(route));

    expect(missingFromSpec).toEqual([]);
    expect(missingFromApp).toEqual([]);
  });

  it("Error.code enum matches codes thrown in src/", () => {
    const fromSource = collectErrorCodesFromSource();
    const errorSchema = (
      openapiDocument.components as {
        schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } };
      }
    ).schemas.Error.properties.error.properties.code.enum;

    const fromSpec = new Set(errorSchema);

    expect([...fromSpec].sort()).toEqual([...fromSource].sort());
  });

  it("examples with productId + unitPriceCents match seed data", () => {
    const byId = new Map<string, (typeof SEED_PRODUCTS)[number]>(
      SEED_PRODUCTS.map((product) => [product.id, product]),
    );
    const mismatches: string[] = [];

    function visit(value: unknown, pathKey: string) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${pathKey}[${index}]`));
        return;
      }

      if (value === null || typeof value !== "object") {
        return;
      }

      const record = value as Record<string, unknown>;
      if (
        typeof record.productId === "string" &&
        typeof record.unitPriceCents === "number"
      ) {
        const seed = byId.get(record.productId);
        if (!seed) {
          mismatches.push(`${pathKey}: unknown productId ${record.productId}`);
        } else {
          if (record.unitPriceCents !== seed.priceCents) {
            mismatches.push(
              `${pathKey}: unitPriceCents ${record.unitPriceCents} != seed ${seed.priceCents}`,
            );
          }
          if (
            typeof record.productName === "string" &&
            record.productName !== seed.name
          ) {
            mismatches.push(
              `${pathKey}: productName "${record.productName}" != seed "${seed.name}"`,
            );
          }
          if (typeof record.name === "string" && record.name !== seed.name) {
            mismatches.push(
              `${pathKey}: name "${record.name}" != seed "${seed.name}"`,
            );
          }
        }
      }

      for (const [key, child] of Object.entries(record)) {
        visit(child, `${pathKey}.${key}`);
      }
    }

    visit(openapiDocument, "$");
    expect(mismatches).toEqual([]);
  });

  it("servers use same-origin relative URL in the YAML", () => {
    const servers = openapiDocument.servers as Array<{ url: string }>;
    expect(servers).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: "/" })]),
    );
    for (const server of servers) {
      expect(server.url).not.toMatch(/^https?:\/\//);
    }
  });

  it("GET /openapi.json rewrites servers to the request origin", async () => {
    const request = (await import("supertest")).default;
    const response = await request(app)
      .get("/openapi.json")
      .set("Host", "uniblox.yashpurani.com")
      .set("X-Forwarded-Proto", "https");

    expect(response.status).toBe(200);
    expect(response.body.servers).toEqual([
      {
        url: "https://uniblox.yashpurani.com",
        description: "Same origin as these docs",
      },
    ]);
  });

  it("GET /docs/ and GET /openapi.json return Cache-Control: no-store", async () => {
    const request = (await import("supertest")).default;

    const docs = await request(app).get("/docs/");
    expect(docs.status).toBe(200);
    expect(docs.headers["cache-control"]).toBe("no-store");

    const spec = await request(app).get("/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.headers["cache-control"]).toBe("no-store");
  });
});
