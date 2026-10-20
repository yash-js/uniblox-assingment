import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCouponConfigForTests } from "../src/config.js";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers/resetDb.js";

async function createCartWith(productId: string, quantity: number) {
  const { body: cart } = await request(app).post("/carts");
  const add = await request(app)
    .post(`/carts/${cart.id}/items`)
    .send({ productId, quantity });
  expect(add.status).toBe(200);
  return cart.id as string;
}

async function checkout(
  cartId: string,
  key: string,
  body: Record<string, unknown> = {},
) {
  return request(app)
    .post(`/carts/${cartId}/checkout`)
    .set("Idempotency-Key", key)
    .send(body);
}

async function tableCounts() {
  return {
    product: await prisma.product.count(),
    cart: await prisma.cart.count(),
    cartItem: await prisma.cartItem.count(),
    order: await prisma.order.count(),
    orderItem: await prisma.orderItem.count(),
    coupon: await prisma.coupon.count(),
  };
}

describe("admin report", () => {
  beforeEach(async () => {
    setCouponConfigForTests(null);
    await resetDb();
  });

  afterEach(() => {
    setCouponConfigForTests(null);
  });

  it("empty DB returns zeros and five products with quantity 0", async () => {
    const response = await request(app).get("/admin/report");

    expect(response.status).toBe(200);
    expect(response.body.currency).toBe("INR");
    expect(response.body.generatedAt).toBeTruthy();
    expect(response.body.grossRevenueCents).toBe(0);
    expect(response.body.totalDiscountCents).toBe(0);
    expect(response.body.netRevenueCents).toBe(0);
    expect(response.body.ordersPlaced).toBe(0);
    expect(response.body.coupons).toEqual({
      generated: 0,
      available: 0,
      redeemed: 0,
    });
    expect(response.body.products).toHaveLength(5);
    for (const product of response.body.products) {
      expect(product.quantityPurchased).toBe(0);
      expect(product.grossRevenueCents).toBe(0);
    }
  });

  it("mix of orders: quantities, money, and coupons are consistent", async () => {
    // Order 1: mouse x2
    const cart1 = await createCartWith("prod_mouse", 2);
    const order1 = await checkout(cart1, "report-order-1-xxxxxxxx");
    expect(order1.status).toBe(201);

    // Order 2: keyboard x1
    const cart2 = await createCartWith("prod_keyboard", 1);
    const order2 = await checkout(cart2, "report-order-2-xxxxxxxx");
    expect(order2.status).toBe(201);

    // More orders to reach milestone, then coupon
    for (let i = 0; i < 3; i++) {
      const cartId = await createCartWith("prod_mouse", 1);
      const placed = await checkout(cartId, `report-fill-${i}-xxxxxxxx`);
      expect(placed.status).toBe(201);
    }

    const couponRes = await request(app).post("/admin/coupons");
    expect(couponRes.status).toBe(201);
    const couponCode = couponRes.body.coupon.code as string;

    // Order with coupon: headphones x1
    const cartCoupon = await createCartWith("prod_headphones", 1);
    const orderCoupon = await checkout(
      cartCoupon,
      "report-order-coupon-xxxx",
      { couponCode },
    );
    expect(orderCoupon.status).toBe(201);

    // Failed checkout (should not count): add while stock allows, then starve inventory
    const failCart = await createCartWith("prod_limited", 2);
    await prisma.product.update({
      where: { id: "prod_limited" },
      data: { inventory: 1 },
    });
    const failedInv = await checkout(failCart, "report-order-fail-inv-xx");
    expect(failedInv.status).toBe(409);
    expect(failedInv.body.error.code).toBe("INSUFFICIENT_INVENTORY");

    // Idempotent replay (must not double count)
    const replay = await checkout(cart1, "report-order-1-xxxxxxxx");
    expect(replay.status).toBe(200);

    const report = await request(app).get("/admin/report");
    expect(report.status).toBe(200);

    const byId = Object.fromEntries(
      report.body.products.map(
        (p: {
          productId: string;
          quantityPurchased: number;
          grossRevenueCents: number;
        }) => [p.productId, p],
      ),
    );

    // mouse: 2 + 1 + 1 + 1 = 5; keyboard: 1; headphones: 1; limited/monitor: 0
    expect(byId.prod_mouse.quantityPurchased).toBe(5);
    expect(byId.prod_keyboard.quantityPurchased).toBe(1);
    expect(byId.prod_headphones.quantityPurchased).toBe(1);
    expect(byId.prod_limited.quantityPurchased).toBe(0);
    expect(byId.prod_monitor.quantityPurchased).toBe(0);

    expect(report.body.grossRevenueCents - report.body.totalDiscountCents).toBe(
      report.body.netRevenueCents,
    );

    const orders = await prisma.order.findMany({ select: { id: true } });
    expect(orders).toHaveLength(6);

    let sumLineTotals = 0;
    let sumDiscounts = 0;
    let ordersWithCoupon = 0;

    for (const { id: orderId } of orders) {
      const orderRes = await request(app).get(`/orders/${orderId}`);
      expect(orderRes.status).toBe(200);
      sumLineTotals += orderRes.body.items.reduce(
        (sum: number, item: { lineTotalCents: number }) =>
          sum + item.lineTotalCents,
        0,
      );
      sumDiscounts += orderRes.body.discountCents;
      if (orderRes.body.couponCode) {
        ordersWithCoupon += 1;
      }
    }

    expect(report.body.grossRevenueCents).toBe(sumLineTotals);
    expect(report.body.totalDiscountCents).toBe(sumDiscounts);
    expect(report.body.ordersPlaced).toBe(6);

    expect(report.body.coupons.generated).toBe(
      report.body.coupons.available + report.body.coupons.redeemed,
    );
    expect(report.body.coupons.redeemed).toBe(ordersWithCoupon);
    expect(report.body.coupons.redeemed).toBe(1);
  });

  it("report is read-only and stable aside from generatedAt", async () => {
    const cartId = await createCartWith("prod_mouse", 1);
    expect((await checkout(cartId, "report-readonly-key-xx")).status).toBe(201);

    const countsBefore = await tableCounts();
    const first = await request(app).get("/admin/report");
    const second = await request(app).get("/admin/report");
    const countsAfter = await tableCounts();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(countsAfter).toEqual(countsBefore);

    const { generatedAt: _a, ...restFirst } = first.body;
    const { generatedAt: _b, ...restSecond } = second.body;
    expect(restSecond).toEqual(restFirst);
  });

  it(
    "consistency under parallel checkouts and reports",
    async () => {
      for (let iteration = 0; iteration < 5; iteration++) {
        await resetDb();

        const cartIds = [];
        for (let i = 0; i < 10; i++) {
          cartIds.push(await createCartWith("prod_mouse", 1));
        }

        const checkoutPromises = cartIds.map((cartId, index) =>
          checkout(cartId, `report-load-${iteration}-${index}-xx`),
        );
        const reportPromises = Array.from({ length: 10 }, () =>
          request(app).get("/admin/report"),
        );

        const [checkoutResponses, reportResponses] = await Promise.all([
          Promise.all(checkoutPromises),
          Promise.all(reportPromises),
        ]);

        expect(checkoutResponses.every((r) => r.status < 500)).toBe(true);

        for (const report of reportResponses) {
          expect(report.status).toBe(200);
          expect(
            report.body.grossRevenueCents - report.body.totalDiscountCents,
          ).toBe(report.body.netRevenueCents);

          const productGrossSum = report.body.products.reduce(
            (sum: number, product: { grossRevenueCents: number }) =>
              sum + product.grossRevenueCents,
            0,
          );
          expect(productGrossSum).toBe(report.body.grossRevenueCents);
        }
      }
    },
    120_000,
  );
});
