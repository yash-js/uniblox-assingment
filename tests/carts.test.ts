import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { CartStatus } from "../src/generated/prisma/client.js";
import { resetDb } from "./helpers/resetDb.js";

describe("carts", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("POST /carts creates an empty cart view", async () => {
    const response = await request(app).post("/carts");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      currency: "INR",
      status: "OPEN",
      items: [],
      itemCount: 0,
      subtotalCents: 0,
    });
    expect(response.body.id).toBeTruthy();
  });

  it("adds an item and increments quantity when added again", async () => {
    const { body: cart } = await request(app).post("/carts");

    const first = await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_mouse", quantity: 2 });

    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({
      productId: "prod_mouse",
      quantity: 2,
      unitPriceCents: 129900,
      lineTotalCents: 259800,
    });
    expect(first.body.itemCount).toBe(2);
    expect(first.body.subtotalCents).toBe(259800);

    const second = await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_mouse", quantity: 1 });

    expect(second.status).toBe(200);
    expect(second.body.items[0].quantity).toBe(3);
    expect(second.body.itemCount).toBe(3);
    expect(second.body.subtotalCents).toBe(389700);
  });

  it("PUT sets quantity and DELETE removes the line", async () => {
    const { body: cart } = await request(app).post("/carts");
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_keyboard", quantity: 1 });

    const updated = await request(app)
      .put(`/carts/${cart.id}/items/prod_keyboard`)
      .send({ quantity: 5 });

    expect(updated.status).toBe(200);
    expect(updated.body.items[0].quantity).toBe(5);
    expect(updated.body.itemCount).toBe(5);
    expect(updated.body.subtotalCents).toBe(1749500);

    const deleted = await request(app).delete(
      `/carts/${cart.id}/items/prod_keyboard`,
    );

    expect(deleted.status).toBe(200);
    expect(deleted.body.items).toEqual([]);
    expect(deleted.body.itemCount).toBe(0);
    expect(deleted.body.subtotalCents).toBe(0);

    const missing = await request(app).delete(
      `/carts/${cart.id}/items/prod_keyboard`,
    );

    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("CART_ITEM_NOT_FOUND");
  });

  it("rejects invalid quantities with VALIDATION_ERROR", async () => {
    const { body: cart } = await request(app).post("/carts");

    for (const quantity of [0, -1, 1.5, "2"]) {
      const response = await request(app)
        .post(`/carts/${cart.id}/items`)
        .send({ productId: "prod_mouse", quantity });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns PRODUCT_NOT_FOUND and CART_NOT_FOUND", async () => {
    const { body: cart } = await request(app).post("/carts");

    const unknownProduct = await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_missing", quantity: 1 });

    expect(unknownProduct.status).toBe(404);
    expect(unknownProduct.body.error.code).toBe("PRODUCT_NOT_FOUND");

    const unknownCart = await request(app).get("/carts/cart_missing");

    expect(unknownCart.status).toBe(404);
    expect(unknownCart.body.error.code).toBe("CART_NOT_FOUND");
  });

  it("rejects quantity above inventory with INSUFFICIENT_INVENTORY", async () => {
    const { body: cart } = await request(app).post("/carts");

    const response = await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_limited", quantity: 4 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    expect(response.body.error.details).toEqual({
      productId: "prod_limited",
      requested: 4,
      available: 3,
    });
  });

  it("rejects mutations when cart is not OPEN", async () => {
    const { body: cart } = await request(app).post("/carts");

    await prisma.cart.update({
      where: { id: cart.id },
      data: { status: CartStatus.CHECKED_OUT },
    });

    const response = await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_mouse", quantity: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CART_NOT_OPEN");
  });

  it("GET cart reflects a product price change", async () => {
    const { body: cart } = await request(app).post("/carts");
    await request(app)
      .post(`/carts/${cart.id}/items`)
      .send({ productId: "prod_mouse", quantity: 2 });

    await prisma.product.update({
      where: { id: "prod_mouse" },
      data: { priceCents: 100000 },
    });

    const response = await request(app).get(`/carts/${cart.id}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0].unitPriceCents).toBe(100000);
    expect(response.body.items[0].lineTotalCents).toBe(200000);
    expect(response.body.subtotalCents).toBe(200000);
  });
});
