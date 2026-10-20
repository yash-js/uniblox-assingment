import {
  discountCents,
  lineTotalCents,
  subtotalCents,
  totalCents,
} from "../domain/pricing.js";
import { prisma } from "../db.js";
import {
  AppError,
  conflict,
  notFound,
  unprocessable,
} from "../errors.js";
import { CartStatus, Prisma } from "../generated/prisma/client.js";
import { tryRedeemCoupon } from "./coupon.service.js";
import { tryDecrementInventory } from "./inventory.js";
import { getOrderView, type OrderView } from "./order.service.js";

export type CheckoutResult = {
  order: OrderView;
  replayed: boolean;
};

export type CheckoutOptions = {
  couponCode?: string;
};

/**
 * Invariants protected by checkoutCart:
 * - A cart can be claimed for checkout at most once (OPEN -> CHECKED_OUT).
 * - Inventory is decremented only when sufficient stock remains (conditional update).
 * - Order + OrderItem rows are a frozen snapshot of name/price/qty at checkout time.
 * - On any failure, the transaction rolls back: cart stays OPEN (or returns to it),
 *   inventory is restored, and no Order is persisted.
 * - A failed checkout also rolls back coupon redemption, so the coupon stays AVAILABLE.
 * - Failed checkouts are NOT recorded; retrying the same idempotency key after a
 *   failure re-executes. That is safe because a failed checkout rolled back and
 *   changed no durable state.
 *
 * Note: @prisma/adapter-better-sqlite3 serializes interactive $transaction calls
 * in-process via a mutex. Correctness does not rely on that — on Postgres with
 * multiple app instances, the conditional inventory updates and unique constraints
 * carry the invariants.
 */
export async function checkoutCart(
  cartId: string,
  idempotencyKey: string,
  options: CheckoutOptions = {},
): Promise<CheckoutResult> {
  const requestCouponCode = options.couponCode;

  const existingByKey = await prisma.order.findUnique({
    where: { idempotencyKey },
    include: { coupon: true },
  });
  if (existingByKey) {
    if (
      existingByKey.cartId === cartId &&
      couponCodesMatch(existingByKey.coupon?.code, requestCouponCode)
    ) {
      return {
        order: await getOrderView(existingByKey.id),
        replayed: true,
      };
    }
    throw unprocessable(
      "IDEMPOTENCY_KEY_MISMATCH",
      "Idempotency key already used with different parameters",
      { idempotencyKey },
    );
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cart.updateMany({
        where: { id: cartId, status: CartStatus.OPEN },
        data: { status: CartStatus.CHECKED_OUT },
      });

      if (claimed.count === 0) {
        const cart = await tx.cart.findUnique({ where: { id: cartId } });
        if (!cart) {
          throw notFound("CART_NOT_FOUND", "Cart not found");
        }
        throw conflict("CART_ALREADY_CHECKED_OUT", "Cart already checked out");
      }

      const cartItems = await tx.cartItem.findMany({ where: { cartId } });
      if (cartItems.length === 0) {
        throw unprocessable("CART_EMPTY", "Cart is empty");
      }

      let redeemedCoupon: {
        id: string;
        code: string;
        discountPercent: number;
      } | null = null;

      if (requestCouponCode) {
        // Coupon redemption is inside the transaction; a later inventory failure
        // rolls it back so the coupon remains AVAILABLE for a retry.
        redeemedCoupon = await tryRedeemCoupon(
          tx,
          requestCouponCode,
          new Date(),
        );
        if (!redeemedCoupon) {
          const existingCoupon = await tx.coupon.findUnique({
            where: { code: requestCouponCode },
          });
          if (!existingCoupon) {
            throw notFound("COUPON_NOT_FOUND", "Coupon not found");
          }
          throw conflict("COUPON_ALREADY_REDEEMED", "Coupon already redeemed");
        }
      }

      // Deterministic lock order by productId (avoids deadlocks under Postgres).
      cartItems.sort((a, b) => a.productId.localeCompare(b.productId));

      const shortages: Array<{
        productId: string;
        requested: number;
        available: number;
      }> = [];

      for (const item of cartItems) {
        const decremented = await tryDecrementInventory(
          tx,
          item.productId,
          item.quantity,
        );

        if (!decremented) {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
          shortages.push({
            productId: item.productId,
            requested: item.quantity,
            available: product?.inventory ?? 0,
          });
        }
      }

      if (shortages.length > 0) {
        throw conflict("INSUFFICIENT_INVENTORY", "Insufficient inventory", {
          items: shortages,
        });
      }

      const products = await tx.product.findMany({
        where: { id: { in: cartItems.map((item) => item.productId) } },
      });
      const productById = new Map(
        products.map((product) => [product.id, product]),
      );

      const lines = cartItems.map((item) => {
        const product = productById.get(item.productId);
        if (!product) {
          throw notFound("PRODUCT_NOT_FOUND", "Product not found");
        }

        const unitPriceCents = product.priceCents;
        return {
          productId: item.productId,
          productName: product.name,
          unitPriceCents,
          quantity: item.quantity,
          lineTotalCents: lineTotalCents(unitPriceCents, item.quantity),
        };
      });

      const orderSubtotalCents = subtotalCents(lines);
      const orderDiscountPercent = redeemedCoupon?.discountPercent ?? 0;
      const orderDiscountCents =
        redeemedCoupon === null
          ? 0
          : discountCents(orderSubtotalCents, redeemedCoupon.discountPercent);
      const orderTotalCents = totalCents(
        orderSubtotalCents,
        orderDiscountCents,
      );

      const created = await tx.order.create({
        data: {
          cartId,
          idempotencyKey,
          couponId: redeemedCoupon?.id,
          subtotalCents: orderSubtotalCents,
          discountPercent: orderDiscountPercent,
          discountCents: orderDiscountCents,
          totalCents: orderTotalCents,
          items: {
            create: lines.map((line) => ({
              productId: line.productId,
              productName: line.productName,
              unitPriceCents: line.unitPriceCents,
              quantity: line.quantity,
              lineTotalCents: line.lineTotalCents,
            })),
          },
        },
      });

      return getOrderView(created.id, tx);
    });

    return { order, replayed: false };
  } catch (err) {
    const alreadyCheckedOut =
      err instanceof AppError && err.code === "CART_ALREADY_CHECKED_OUT";
    const idempotencyConflict = isIdempotencyKeyConflict(err);

    if (alreadyCheckedOut || idempotencyConflict) {
      const byKey = await prisma.order.findUnique({
        where: { idempotencyKey },
        include: { coupon: true },
      });
      if (
        byKey &&
        byKey.cartId === cartId &&
        couponCodesMatch(byKey.coupon?.code, requestCouponCode)
      ) {
        return { order: await getOrderView(byKey.id), replayed: true };
      }

      if (byKey) {
        throw unprocessable(
          "IDEMPOTENCY_KEY_MISMATCH",
          "Idempotency key already used with different parameters",
          { idempotencyKey },
        );
      }

      if (alreadyCheckedOut) {
        const orderForCart = await prisma.order.findUnique({
          where: { cartId },
        });
        throw conflict("CART_ALREADY_CHECKED_OUT", "Cart already checked out", {
          orderId: orderForCart?.id,
        });
      }
    }

    throw err;
  }
}

function couponCodesMatch(
  existingCode: string | null | undefined,
  requestCode: string | undefined,
): boolean {
  return (existingCode ?? null) === (requestCode ?? null);
}

function isIdempotencyKeyConflict(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== "P2002"
  ) {
    return false;
  }

  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("idempotencyKey");
  }
  if (typeof target === "string") {
    return target.includes("idempotencyKey");
  }
  return false;
}
