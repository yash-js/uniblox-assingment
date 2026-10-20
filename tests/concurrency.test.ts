import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { resetDb } from "./helpers/resetDb.js";

const ITERATIONS = 10;

async function createCartWithItem(productId: string, quantity: number) {
  const { body: cart } = await request(app).post("/carts");
  const add = await request(app)
    .post(`/carts/${cart.id}/items`)
    .send({ productId, quantity });
  expect(add.status).toBe(200);
  return cart.id as string;
}

describe("concurrency", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it(
    "oversell: exactly 3 succeed and inventory reaches 0",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        await prisma.product.update({
          where: { id: "prod_limited" },
          data: { inventory: 3 },
        });

        const cartIds = [];
        for (let c = 0; c < 10; c++) {
          cartIds.push(await createCartWithItem("prod_limited", 1));
        }

        const responses = await Promise.all(
          cartIds.map((cartId, index) =>
            request(app)
              .post(`/carts/${cartId}/checkout`)
              .set("Idempotency-Key", `oversell-${i}-${index}-xxxxxxxx`)
              .send({}),
          ),
        );

        const created = responses.filter((r) => r.status === 201);
        const insufficient = responses.filter(
          (r) =>
            r.status === 409 &&
            r.body.error?.code === "INSUFFICIENT_INVENTORY",
        );
        const serverErrors = responses.filter((r) => r.status >= 500);

        expect(created).toHaveLength(3);
        expect(insufficient).toHaveLength(7);
        expect(serverErrors).toHaveLength(0);

        const product = await prisma.product.findUniqueOrThrow({
          where: { id: "prod_limited" },
        });
        expect(product.inventory).toBe(0);
        expect(await prisma.order.count()).toBe(3);
      }
    },
    120_000,
  );

  it(
    "double checkout: one winner among different keys",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        const cartId = await createCartWithItem("prod_mouse", 1);
        const inventoryBefore = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_mouse" },
          })
        ).inventory;

        const responses = await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            request(app)
              .post(`/carts/${cartId}/checkout`)
              .set("Idempotency-Key", `double-${i}-${index}-xxxxxxxx`)
              .send({}),
          ),
        );

        const created = responses.filter((r) => r.status === 201);
        const already = responses.filter(
          (r) =>
            r.status === 409 &&
            r.body.error?.code === "CART_ALREADY_CHECKED_OUT",
        );

        expect(created).toHaveLength(1);
        expect(already).toHaveLength(4);
        expect(await prisma.order.count()).toBe(1);

        const inventoryAfter = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_mouse" },
          })
        ).inventory;
        expect(inventoryAfter).toBe(inventoryBefore - 1);
      }
    },
    120_000,
  );

  it(
    "duplicate retry: same key returns the same order id",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        const cartId = await createCartWithItem("prod_mouse", 1);
        const inventoryBefore = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_mouse" },
          })
        ).inventory;
        const key = `duplicate-${i}-same-key-xx`;

        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            request(app)
              .post(`/carts/${cartId}/checkout`)
              .set("Idempotency-Key", key)
              .send({}),
          ),
        );

        const created = responses.filter((r) => r.status === 201);
        const replayed = responses.filter(
          (r) =>
            r.status === 200 && r.headers["idempotent-replayed"] === "true",
        );

        expect(created).toHaveLength(1);
        expect(replayed).toHaveLength(4);

        const orderIds = responses.map((r) => r.body.id);
        expect(new Set(orderIds).size).toBe(1);
        expect(await prisma.order.count()).toBe(1);

        const inventoryAfter = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_mouse" },
          })
        ).inventory;
        expect(inventoryAfter).toBe(inventoryBefore - 1);
      }
    },
    120_000,
  );

  it(
    "sequential retry returns 200 with the same order id",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        const cartId = await createCartWithItem("prod_mouse", 1);
        const key = `sequential-${i}-same-key`;

        const first = await request(app)
          .post(`/carts/${cartId}/checkout`)
          .set("Idempotency-Key", key)
          .send({});
        expect(first.status).toBe(201);

        const inventoryAfterFirst = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_mouse" },
          })
        ).inventory;

        const second = await request(app)
          .post(`/carts/${cartId}/checkout`)
          .set("Idempotency-Key", key)
          .send({});

        expect(second.status).toBe(200);
        expect(second.headers["idempotent-replayed"]).toBe("true");
        expect(second.body.id).toBe(first.body.id);

        const inventoryAfterSecond = (
          await prisma.product.findUniqueOrThrow({
            where: { id: "prod_mouse" },
          })
        ).inventory;
        expect(inventoryAfterSecond).toBe(inventoryAfterFirst);
        expect(await prisma.order.count()).toBe(1);
      }
    },
    120_000,
  );

  it(
    "key mismatch leaves cart B open",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        const cartA = await createCartWithItem("prod_mouse", 1);
        const cartB = await createCartWithItem("prod_keyboard", 1);
        const key = `mismatch-${i}-shared-key`;

        const first = await request(app)
          .post(`/carts/${cartA}/checkout`)
          .set("Idempotency-Key", key)
          .send({});
        expect(first.status).toBe(201);

        const second = await request(app)
          .post(`/carts/${cartB}/checkout`)
          .set("Idempotency-Key", key)
          .send({});

        expect(second.status).toBe(422);
        expect(second.body.error.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
        expect(second.body.error.details).toEqual({ idempotencyKey: key });

        const cart = await prisma.cart.findUniqueOrThrow({
          where: { id: cartB },
        });
        expect(cart.status).toBe("OPEN");
      }
    },
    120_000,
  );

  it(
    "retry after failure re-executes with the same key",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        const cartId = await createCartWithItem("prod_limited", 2);
        await prisma.product.update({
          where: { id: "prod_limited" },
          data: { inventory: 1 },
        });
        const key = `retry-after-fail-${i}-key`;

        const failed = await request(app)
          .post(`/carts/${cartId}/checkout`)
          .set("Idempotency-Key", key)
          .send({});
        expect(failed.status).toBe(409);
        expect(failed.body.error.code).toBe("INSUFFICIENT_INVENTORY");
        expect(await prisma.order.count()).toBe(0);

        await prisma.product.update({
          where: { id: "prod_limited" },
          data: { inventory: 3 },
        });

        const succeeded = await request(app)
          .post(`/carts/${cartId}/checkout`)
          .set("Idempotency-Key", key)
          .send({});

        expect(succeeded.status).toBe(201);
        expect(succeeded.body.id).toBeTruthy();
        expect(await prisma.order.count()).toBe(1);

        const product = await prisma.product.findUniqueOrThrow({
          where: { id: "prod_limited" },
        });
        expect(product.inventory).toBe(1);
      }
    },
    120_000,
  );
});
