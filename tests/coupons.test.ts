import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCouponConfigForTests } from "../src/config.js";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { tryRedeemCoupon } from "../src/services/coupon.service.js";
import { resetDb } from "./helpers/resetDb.js";

async function placeSuccessfulOrders(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const { body: cart } = await request(app).post("/carts");
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_mouse", quantity: 1 });

    const checkout = await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .set("Idempotency-Key", `place-order-${count}-${i}-${Date.now()}`)
      .send({});
    expect(checkout.status).toBe(201);
  }
}

async function createCartWith(productId: string, quantity: number) {
  const { body: cart } = await request(app).post("/carts");
  const add = await request(app)
    .post(`/carts/${cart.id}/items`)
    .send({ productId, quantity });
  expect(add.status).toBe(200);
  return cart.id as string;
}

describe("coupons", () => {
  beforeEach(async () => {
    setCouponConfigForTests(null);
    await resetDb();
  });

  afterEach(() => {
    setCouponConfigForTests(null);
  });

  it("generate with 0 or 4 orders returns NO_ELIGIBLE_MILESTONE", async () => {
    const zero = await request(app).post("/admin/coupons");
    expect(zero.status).toBe(409);
    expect(zero.body.error.code).toBe("NO_ELIGIBLE_MILESTONE");
    expect(zero.body.error.details).toEqual({
      ordersPlaced: 0,
      everyNOrders: 5,
      nextMilestoneAt: 5,
    });

    await placeSuccessfulOrders(4);

    const four = await request(app).post("/admin/coupons");
    expect(four.status).toBe(409);
    expect(four.body.error.code).toBe("NO_ELIGIBLE_MILESTONE");
    expect(four.body.error.details).toEqual({
      ordersPlaced: 4,
      everyNOrders: 5,
      nextMilestoneAt: 5,
    });
  });

  it("after 5 orders generates milestone 1 once", async () => {
    await placeSuccessfulOrders(5);

    const first = await request(app).post("/admin/coupons");
    expect(first.status).toBe(201);
    expect(first.body.coupon.milestone).toBe(1);
    expect(first.body.coupon.discountPercent).toBe(10);
    expect(first.body.coupon.status).toBe("AVAILABLE");
    expect(first.body.coupon.code).toMatch(/^SAVE10-[A-Z0-9]{8}$/);

    const second = await request(app).post("/admin/coupons");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("NO_ELIGIBLE_MILESTONE");
  });

  it("after 10 orders with none generated yields milestones 1 then 2", async () => {
    await placeSuccessfulOrders(10);

    const first = await request(app).post("/admin/coupons");
    const second = await request(app).post("/admin/coupons");
    const third = await request(app).post("/admin/coupons");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect([first.body.coupon.milestone, second.body.coupon.milestone].sort()).toEqual([
      1, 2,
    ]);
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("NO_ELIGIBLE_MILESTONE");
  });

  it("checkout with coupon applies discount and cannot be reused", async () => {
    await placeSuccessfulOrders(5);
    const { body } = await request(app).post("/admin/coupons");
    const code = body.coupon.code as string;

    const cartId = await createCartWith("prod_mouse", 2);
    const checkout = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "coupon-checkout-ok-01")
      .send({ couponCode: code });

    expect(checkout.status).toBe(201);
    expect(checkout.body.subtotalCents).toBe(259800);
    expect(checkout.body.discountPercent).toBe(10);
    expect(checkout.body.discountCents).toBe(25980);
    expect(checkout.body.totalCents).toBe(233820);
    expect(checkout.body.couponCode).toBe(code);

    const coupon = await prisma.coupon.findUniqueOrThrow({ where: { code } });
    expect(coupon.status).toBe("REDEEMED");

    const otherCart = await createCartWith("prod_mouse", 1);
    const reuse = await request(app)
      .post(`/carts/${otherCart}/checkout`)
      .set("Idempotency-Key", "coupon-checkout-reuse-01")
      .send({ couponCode: code });

    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("COUPON_ALREADY_REDEEMED");
  });

  it("unknown code 404; lowercase/whitespace still works", async () => {
    await placeSuccessfulOrders(5);
    const { body } = await request(app).post("/admin/coupons");
    const code = body.coupon.code as string;

    const missing = await request(app)
      .post(`/carts/${await createCartWith("prod_mouse", 1)}/checkout`)
      .set("Idempotency-Key", "coupon-missing-code-01")
      .send({ couponCode: "SAVE10-DOESNOTEXIST" });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("COUPON_NOT_FOUND");

    const cartId = await createCartWith("prod_mouse", 1);
    const checkout = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "coupon-normalize-code-01")
      .send({ couponCode: `  ${code.toLowerCase()}  ` });

    expect(checkout.status).toBe(201);
    expect(checkout.body.couponCode).toBe(code);
  });

  it("failed checkout keeps coupon AVAILABLE for another cart", async () => {
    await placeSuccessfulOrders(5);
    const { body } = await request(app).post("/admin/coupons");
    const code = body.coupon.code as string;

    const cartId = await createCartWith("prod_limited", 2);
    await prisma.product.update({
      where: { id: "prod_limited" },
      data: { inventory: 1 },
    });

    const failed = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "coupon-fail-inventory-01")
      .send({ couponCode: code });

    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe("INSUFFICIENT_INVENTORY");

    const coupon = await prisma.coupon.findUniqueOrThrow({ where: { code } });
    expect(coupon.status).toBe("AVAILABLE");

    const otherCart = await createCartWith("prod_mouse", 1);
    const ok = await request(app)
      .post(`/carts/${otherCart}/checkout`)
      .set("Idempotency-Key", "coupon-retry-other-cart-01")
      .send({ couponCode: code });

    expect(ok.status).toBe(201);
    expect(ok.body.couponCode).toBe(code);
  });

  it("discount uses coupon stored percent after config x changes", async () => {
    await placeSuccessfulOrders(5);
    const { body } = await request(app).post("/admin/coupons");
    const code = body.coupon.code as string;
    expect(body.coupon.discountPercent).toBe(10);

    setCouponConfigForTests({ discountPercent: 50 });

    const cartId = await createCartWith("prod_mouse", 1);
    const checkout = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "coupon-stored-percent-01")
      .send({ couponCode: code });

    expect(checkout.status).toBe(201);
    expect(checkout.body.discountPercent).toBe(10);
    expect(checkout.body.discountCents).toBe(12990);
    expect(checkout.body.totalCents).toBe(116910);
  });

  it("same key with different couponCode is IDEMPOTENCY_KEY_MISMATCH", async () => {
    await placeSuccessfulOrders(5);
    const { body } = await request(app).post("/admin/coupons");
    const code = body.coupon.code as string;

    const cartId = await createCartWith("prod_mouse", 1);
    const first = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "coupon-idem-mismatch-01")
      .send({});
    expect(first.status).toBe(201);

    const mismatch = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "coupon-idem-mismatch-01")
      .send({ couponCode: code });

    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
  });

  it(
    "parallel checkout with same coupon: one wins, loser stays OPEN",
    async () => {
      for (let i = 0; i < 10; i++) {
        setCouponConfigForTests(null);
        await resetDb();
        await placeSuccessfulOrders(5);
        const { body } = await request(app).post("/admin/coupons");
        const code = body.coupon.code as string;

        const cartA = await createCartWith("prod_mouse", 1);
        const cartB = await createCartWith("prod_keyboard", 1);
        const inventoryMouseBefore = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_mouse" },
          })
        ).inventory;
        const inventoryKeyboardBefore = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_keyboard" },
          })
        ).inventory;

        const responses = await Promise.all([
          request(app)
            .post(`/carts/${cartA}/checkout`)
            .set("Idempotency-Key", `coupon-race-a-${i}-xxxxxxxx`)
            .send({ couponCode: code }),
          request(app)
            .post(`/carts/${cartB}/checkout`)
            .set("Idempotency-Key", `coupon-race-b-${i}-xxxxxxxx`)
            .send({ couponCode: code }),
        ]);

        const created = responses.filter((r) => r.status === 201);
        const already = responses.filter(
          (r) =>
            r.status === 409 &&
            r.body.error?.code === "COUPON_ALREADY_REDEEMED",
        );

        expect(created).toHaveLength(1);
        expect(already).toHaveLength(1);
        expect(created[0]!.body.discountCents).toBeGreaterThan(0);

        const loserCartId =
          already[0] === responses[0] ? cartA : cartB;
        const loserProductId =
          loserCartId === cartA ? "prod_mouse" : "prod_keyboard";
        const loserInventoryBefore =
          loserProductId === "prod_mouse"
            ? inventoryMouseBefore
            : inventoryKeyboardBefore;

        const loserCart = await prisma.cart.findUniqueOrThrow({
          where: { id: loserCartId },
        });
        expect(loserCart.status).toBe("OPEN");

        const loserProduct = await prisma.product.findUniqueOrThrow({
          where: { id: loserProductId },
        });
        expect(loserProduct.inventory).toBe(loserInventoryBefore);
      }
    },
    180_000,
  );

  it(
    "parallel admin generate after 5 orders creates exactly one coupon",
    async () => {
      for (let i = 0; i < 10; i++) {
        setCouponConfigForTests(null);
        await resetDb();
        await placeSuccessfulOrders(5);

        const responses = await Promise.all(
          Array.from({ length: 5 }, () => request(app).post("/admin/coupons")),
        );

        const created = responses.filter((r) => r.status === 201);
        const serverErrors = responses.filter((r) => r.status >= 500);

        expect(created).toHaveLength(1);
        expect(serverErrors).toHaveLength(0);
        expect(await prisma.coupon.count()).toBe(1);
      }
    },
    180_000,
  );

  it("tryRedeemCoupon outside transaction: exactly one non-null", async () => {
    await placeSuccessfulOrders(5);
    const { body } = await request(app).post("/admin/coupons");
    const code = body.coupon.code as string;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        tryRedeemCoupon(prisma, code, new Date()),
      ),
    );

    expect(results.filter((coupon) => coupon !== null)).toHaveLength(1);
    expect(results.filter((coupon) => coupon === null)).toHaveLength(9);
  });
});
