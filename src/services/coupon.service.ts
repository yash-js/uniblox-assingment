import { randomBytes } from "node:crypto";
import { getCouponConfig } from "../config.js";
import { nextUnrewardedMilestone, eligibleMilestones } from "../domain/milestones.js";
import { prisma } from "../db.js";
import { conflict } from "../errors.js";
import {
  CouponStatus,
  Prisma,
  type PrismaClient,
} from "../generated/prisma/client.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomCodeSuffix(): string {
  const bytes = randomBytes(8);
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return suffix;
}

export type CouponView = {
  id: string;
  code: string;
  discountPercent: number;
  milestone: number;
  status: CouponStatus;
  createdAt: Date;
};

export async function generateCoupon(): Promise<CouponView> {
  const { everyNOrders, discountPercent } = getCouponConfig();

  try {
    return await prisma.$transaction(async (tx) => {
      const ordersPlaced = await tx.order.count();
      const existing = await tx.coupon.findMany({
        select: { milestone: true },
      });
      const milestone = nextUnrewardedMilestone(
        ordersPlaced,
        everyNOrders,
        existing.map((coupon) => coupon.milestone),
      );

      if (milestone === null) {
        throw conflict("NO_ELIGIBLE_MILESTONE", "No eligible milestone", {
          ordersPlaced,
          everyNOrders,
          nextMilestoneAt:
            (eligibleMilestones(ordersPlaced, everyNOrders) + 1) * everyNOrders,
        });
      }

      const code = `SAVE${discountPercent}-${randomCodeSuffix()}`;
      const coupon = await tx.coupon.create({
        data: {
          code,
          discountPercent,
          milestone,
        },
      });

      return toCouponView(coupon);
    });
  } catch (err) {
    if (isMilestoneConflict(err)) {
      throw conflict(
        "MILESTONE_ALREADY_REWARDED",
        "Milestone already rewarded",
      );
    }
    throw err;
  }
}

export async function listCoupons(): Promise<CouponView[]> {
  const coupons = await prisma.coupon.findMany({
    orderBy: { milestone: "asc" },
  });
  return coupons.map(toCouponView);
}

export async function tryRedeemCoupon(
  db: DbClient,
  code: string,
  now: Date,
) {
  const result = await db.coupon.updateMany({
    where: { code, status: CouponStatus.AVAILABLE },
    data: { status: CouponStatus.REDEEMED, redeemedAt: now },
  });

  if (result.count !== 1) {
    return null;
  }

  return db.coupon.findUnique({ where: { code } });
}

function toCouponView(coupon: {
  id: string;
  code: string;
  discountPercent: number;
  milestone: number;
  status: CouponStatus;
  createdAt: Date;
}): CouponView {
  return {
    id: coupon.id,
    code: coupon.code,
    discountPercent: coupon.discountPercent,
    milestone: coupon.milestone,
    status: coupon.status,
    createdAt: coupon.createdAt,
  };
}

function isMilestoneConflict(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== "P2002"
  ) {
    return false;
  }

  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("milestone");
  }
  if (typeof target === "string") {
    return target.includes("milestone");
  }
  return false;
}
