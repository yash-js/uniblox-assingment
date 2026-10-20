import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("error responses", () => {
  it("unknown route returns ROUTE_NOT_FOUND", async () => {
    const response = await request(app).get("/no-such-route");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: "ROUTE_NOT_FOUND",
      message: "Route not found",
    });
  });

  it("malformed JSON body returns INVALID_JSON", async () => {
    const response = await request(app)
      .post("/__test/json")
      .set("Content-Type", "application/json")
      .send("{ not-json");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
  });
});
