import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { resetDb } from "./helpers/resetDb.js";

describe("products", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("GET /products returns 5 seeded products", async () => {
    const response = await request(app).get("/products");

    expect(response.status).toBe(200);
    expect(response.body.currency).toBe("INR");
    expect(response.body.products).toHaveLength(5);
    expect(response.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "prod_keyboard" }),
        expect.objectContaining({ id: "prod_mouse" }),
        expect.objectContaining({ id: "prod_headphones" }),
        expect.objectContaining({ id: "prod_monitor" }),
        expect.objectContaining({ id: "prod_limited" }),
      ]),
    );
  });

  it("GET /products/unknown returns 404 PRODUCT_NOT_FOUND", async () => {
    const response = await request(app).get("/products/unknown");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});
