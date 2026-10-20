import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers/resetDb.js";

describe("checkout", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("checks out successfully and decrements inventory", async () => {
    const { body: cart } = await request(app).post("/carts");
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_mouse", quantity: 2 });

    const response = await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .set("Idempotency-Key", "checkout-key-001")
      .send({});

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      currency: "INR",
      cartId: cart.id,
      subtotalCents: 259800,
      discountPercent: 0,
      discountCents: 0,
      couponCode: null,
      totalCents: 259800,
      items: [
        {
          productId: "prod_mouse",
          productName: "Wireless Mouse",
          unitPriceCents: 129900,
          quantity: 2,
          lineTotalCents: 259800,
        },
      ],
    });

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: "prod_mouse" },
    });
    expect(product.inventory).toBe(98);

    const checkedOutCart = await prisma.cart.findUniqueOrThrow({
      where: { id: cart.id },
    });
    expect(checkedOutCart.status).toBe("CHECKED_OUT");
  });

  it("order snapshot ignores later product name/price changes", async () => {
    const { body: cart } = await request(app).post("/carts");
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_keyboard", quantity: 1 });

    const { body: order } = await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .set("Idempotency-Key", "checkout-key-snapshot")
      .send({});

    await prisma.product.update({
      where: { id: "prod_keyboard" },
      data: { name: "Changed Keyboard", priceCents: 1 },
    });

    const response = await request(app).get(`/orders/${order.id}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      productId: "prod_keyboard",
      productName: "Mechanical Keyboard",
      unitPriceCents: 349900,
      quantity: 1,
      lineTotalCents: 349900,
    });
    expect(response.body.totalCents).toBe(349900);
  });

  it("second checkout with a different key returns CART_ALREADY_CHECKED_OUT", async () => {
    const { body: cart } = await request(app).post("/carts");
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_mouse", quantity: 1 });

    await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .set("Idempotency-Key", "checkout-key-first")
      .send({});

    const response = await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .set("Idempotency-Key", "checkout-key-second")
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CART_ALREADY_CHECKED_OUT");
  });

  it("empty cart returns CART_EMPTY", async () => {
    const { body: cart } = await request(app).post("/carts");

    const response = await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .set("Idempotency-Key", "checkout-key-empty")
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("CART_EMPTY");
  });

  it("missing Idempotency-Key returns IDEMPOTENCY_KEY_REQUIRED", async () => {
    const { body: cart } = await request(app).post("/carts");

    const response = await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("rolls back inventory and cart when a later line is short", async () => {
    const { body: cart } = await request(app).post("/carts");
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_keyboard", quantity: 2 });
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_limited", quantity: 2 });

    await prisma.product.update({
      where: { id: "prod_limited" },
      data: { inventory: 1 },
    });

    const keyboardBefore = await prisma.product.findUniqueOrThrow({
      where: { id: "prod_keyboard" },
    });

    const response = await request(app)
      .post(`/carts/${cart.id}/checkout`)
      .set("Idempotency-Key", "checkout-key-rollback")
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    expect(response.body.error.details.items).toEqual([
      {
        productId: "prod_limited",
        requested: 2,
        available: 1,
      },
    ]);

    const keyboardAfter = await prisma.product.findUniqueOrThrow({
      where: { id: "prod_keyboard" },
    });
    expect(keyboardAfter.inventory).toBe(keyboardBefore.inventory);

    const openCart = await prisma.cart.findUniqueOrThrow({
      where: { id: cart.id },
    });
    expect(openCart.status).toBe("OPEN");

    expect(await prisma.order.count()).toBe(0);
  });

  it("unknown order returns ORDER_NOT_FOUND", async () => {
    const response = await request(app).get("/orders/order_missing");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ORDER_NOT_FOUND");
  });
});
