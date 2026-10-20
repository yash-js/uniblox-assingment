import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import swaggerUi from "swagger-ui-express";
import { ZodError } from "zod";
import { AppError, badRequest, conflict, notFound } from "./errors.js";
import { Prisma } from "./generated/prisma/client.js";
import { openApiDocumentForRequest } from "./openapi.js";
import { adminRouter } from "./routes/admin.routes.js";
import { cartsRouter } from "./routes/carts.routes.js";
import { checkoutRouter } from "./routes/checkout.routes.js";
import { ordersRouter } from "./routes/orders.routes.js";
import { productsRouter } from "./routes/products.routes.js";

export const app = express();

// Honor X-Forwarded-* when behind nginx/Cloudflare (needed for correct OpenAPI server URL).
app.set("trust proxy", 1);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Prevent Cloudflare/edge from caching docs assets (esp. swagger-ui-init.js) or the spec.
app.use(["/docs", "/openapi.json"], (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/openapi.json", (req, res) => {
  // Spec YAML is loaded once at startup; servers are adjusted per request origin.
  res.json(openApiDocumentForRequest(req));
});

// Do not embed the spec in swagger-ui-init.js — fetch /openapi.json at runtime.
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(null, {
    swaggerOptions: {
      url: "/openapi.json",
    },
  }),
);

app.use("/products", productsRouter);
app.use("/carts", cartsRouter);
app.use("/carts", checkoutRouter);
app.use("/orders", ordersRouter);
app.use("/admin", adminRouter);

if (process.env.NODE_ENV === "test") {
  app.post("/__test/json", (_req, res) => {
    res.json({ ok: true });
  });
}

app.use((_req, _res, next) => {
  next(notFound("ROUTE_NOT_FOUND", "Route not found"));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: err.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (isMalformedJsonError(err)) {
    const error = badRequest("INVALID_JSON", "Malformed JSON body");
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const error = conflict("CONFLICT", "Conflict");
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
});

function isMalformedJsonError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) {
    return false;
  }

  const candidate = err as SyntaxError & { status?: number; type?: string };
  return candidate.status === 400 || candidate.type === "entity.parse.failed";
}
