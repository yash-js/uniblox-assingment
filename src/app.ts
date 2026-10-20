import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import swaggerUi from "swagger-ui-express";
import { ZodError } from "zod";
import { AppError, badRequest, conflict, notFound } from "./errors.js";
import { Prisma } from "./generated/prisma/client.js";
import { openapiDocument } from "./openapi.js";
import { adminRouter } from "./routes/admin.routes.js";
import { cartsRouter } from "./routes/carts.routes.js";
import { checkoutRouter } from "./routes/checkout.routes.js";
import { ordersRouter } from "./routes/orders.routes.js";
import { productsRouter } from "./routes/products.routes.js";

export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/openapi.json", (_req, res) => {
  res.json(openapiDocument);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

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
