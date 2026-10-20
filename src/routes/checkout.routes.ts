import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { checkoutCart } from "../services/checkout.service.js";

export const checkoutRouter = Router();

const checkoutBodySchema = z
  .object({
    couponCode: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .strict();

const idempotencyKeySchema = z.string().min(8).max(128);

checkoutRouter.post("/:cartId/checkout", async (req, res) => {
  const headerValue = req.header("Idempotency-Key");
  const parsedKey = idempotencyKeySchema.safeParse(headerValue);
  if (!parsedKey.success) {
    throw badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required (8-128 characters)",
    );
  }

  const body = checkoutBodySchema.parse(req.body ?? {});

  const { order, replayed } = await checkoutCart(
    req.params.cartId,
    parsedKey.data,
    { couponCode: body.couponCode },
  );

  if (replayed) {
    res.set("Idempotent-Replayed", "true");
    res.status(200).json(order);
    return;
  }

  res.status(201).json(order);
});
