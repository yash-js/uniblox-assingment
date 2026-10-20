import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default("file:./prisma/dev.db"),
  COUPON_EVERY_N_ORDERS: z.coerce.number().int().positive().default(5),
  COUPON_DISCOUNT_PERCENT: z.coerce.number().int().min(1).max(100).default(10),
});

export const env = envSchema.parse(process.env);

export type CouponConfig = {
  everyNOrders: number;
  discountPercent: number;
};

let couponConfigOverrides: Partial<CouponConfig> | null = null;

export function getCouponConfig(): CouponConfig {
  return {
    everyNOrders:
      couponConfigOverrides?.everyNOrders ?? env.COUPON_EVERY_N_ORDERS,
    discountPercent:
      couponConfigOverrides?.discountPercent ?? env.COUPON_DISCOUNT_PERCENT,
  };
}

/** Test-only: override coupon n/x without editing .env. Pass null to clear. */
export function setCouponConfigForTests(
  overrides: Partial<CouponConfig> | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "setCouponConfigForTests can only be used when NODE_ENV=test",
    );
  }
  couponConfigOverrides = overrides;
}
