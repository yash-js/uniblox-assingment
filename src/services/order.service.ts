import { prisma } from "../db.js";
import { notFound } from "../errors.js";
import type { Prisma } from "../generated/prisma/client.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export type OrderView = {
  currency: "INR";
  id: string;
  cartId: string;
  createdAt: Date;
  items: Array<{
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
  }>;
  subtotalCents: number;
  discountPercent: number;
  discountCents: number;
  couponCode: string | null;
  totalCents: number;
};

export async function getOrder(orderId: string): Promise<OrderView> {
  return getOrderView(orderId);
}

export async function getOrderView(
  orderId: string,
  client: DbClient = prisma,
): Promise<OrderView> {
  const order = await client.order.findUnique({
    where: { id: orderId },
    include: { items: true, coupon: true },
  });

  if (!order) {
    throw notFound("ORDER_NOT_FOUND", "Order not found");
  }

  return {
    currency: "INR",
    id: order.id,
    cartId: order.cartId,
    createdAt: order.createdAt,
    items: order.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      lineTotalCents: item.lineTotalCents,
    })),
    subtotalCents: order.subtotalCents,
    discountPercent: order.discountPercent,
    discountCents: order.discountCents,
    couponCode: order.coupon?.code ?? null,
    totalCents: order.totalCents,
  };
}
