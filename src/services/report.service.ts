import { getCouponConfig } from "../config.js";
import { eligibleMilestones } from "../domain/milestones.js";
import { prisma } from "../db.js";
import { CouponStatus } from "../generated/prisma/client.js";

export type Report = {
  products: Array<{
    productId: string;
    productName: string;
    quantityPurchased: number;
    grossRevenueCents: number;
  }>;
  grossRevenueCents: number;
  totalDiscountCents: number;
  netRevenueCents: number;
  ordersPlaced: number;
  coupons: {
    generated: number;
    available: number;
    redeemed: number;
  };
  milestones: {
    everyNOrders: number;
    discountPercent: number;
    eligible: number;
    rewarded: number;
    nextMilestoneAt: number;
  };
};

export async function getReport(): Promise<Report> {
  // All reads share one interactive transaction so they observe a single
  // consistent snapshot — an order committing between separate queries could
  // otherwise make money totals disagree with product aggregates.
  return prisma.$transaction(async (tx) => {
    const { everyNOrders, discountPercent } = getCouponConfig();

    const [
      products,
      orderTotals,
      orderItemSales,
      couponGroups,
      couponsGenerated,
    ] = await Promise.all([
      tx.product.findMany({
        select: { id: true, name: true },
        orderBy: { id: "asc" },
      }),
      tx.order.aggregate({
        _sum: {
          subtotalCents: true,
          discountCents: true,
          totalCents: true,
        },
        _count: { _all: true },
      }),
      tx.orderItem.groupBy({
        by: ["productId"],
        _sum: {
          quantity: true,
          lineTotalCents: true,
        },
      }),
      tx.coupon.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      tx.coupon.count(),
    ]);

    const salesByProductId = new Map(
      orderItemSales.map((row) => [
        row.productId,
        {
          quantityPurchased: row._sum.quantity ?? 0,
          grossRevenueCents: row._sum.lineTotalCents ?? 0,
        },
      ]),
    );

    const available =
      couponGroups.find((row) => row.status === CouponStatus.AVAILABLE)?._count
        ._all ?? 0;
    const redeemed =
      couponGroups.find((row) => row.status === CouponStatus.REDEEMED)?._count
        ._all ?? 0;

    const ordersPlaced = orderTotals._count._all;
    const eligible = eligibleMilestones(ordersPlaced, everyNOrders);

    return {
      products: products.map((product) => {
        const sales = salesByProductId.get(product.id);
        return {
          productId: product.id,
          productName: product.name,
          quantityPurchased: sales?.quantityPurchased ?? 0,
          grossRevenueCents: sales?.grossRevenueCents ?? 0,
        };
      }),
      grossRevenueCents: orderTotals._sum.subtotalCents ?? 0,
      totalDiscountCents: orderTotals._sum.discountCents ?? 0,
      netRevenueCents: orderTotals._sum.totalCents ?? 0,
      ordersPlaced,
      coupons: {
        generated: couponsGenerated,
        available,
        redeemed,
      },
      milestones: {
        everyNOrders,
        discountPercent,
        eligible,
        rewarded: couponsGenerated,
        nextMilestoneAt: (eligible + 1) * everyNOrders,
      },
    };
  });
}
