import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { tryDecrementInventory } from "../src/services/inventory.js";
import { resetDb } from "./helpers/resetDb.js";

const ITERATIONS = 10;

/**
 * Naive read-then-write decrement — defined ONLY in this test file.
 * Intentionally racy: another request can change inventory between the read
 * and the write. This test exists to show the suite can detect a
 * read-then-write implementation.
 */
async function naiveDecrement(
  productId: string,
  qty: number,
): Promise<boolean> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.inventory < qty) {
    return false;
  }

  await new Promise<void>((resolve) => setImmediate(resolve));

  await prisma.product.update({
    where: { id: productId },
    data: { inventory: product.inventory - qty },
  });
  return true;
}

describe("inventory race (outside $transaction)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it(
    "safe conditional update: exactly 3 successes from inventory 3",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        await prisma.product.update({
          where: { id: "prod_limited" },
          data: { inventory: 3 },
        });

        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            tryDecrementInventory(prisma, "prod_limited", 1),
          ),
        );

        expect(results.filter(Boolean)).toHaveLength(3);
        expect(results.filter((ok) => !ok)).toHaveLength(7);

        const product = await prisma.product.findUniqueOrThrow({
          where: { id: "prod_limited" },
        });
        expect(product.inventory).toBe(0);
      }
    },
    60_000,
  );

  it(
    "naiveDecrement oversells (detects read-then-write races)",
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await resetDb();
        await prisma.product.update({
          where: { id: "prod_limited" },
          data: { inventory: 3 },
        });

        const results = await Promise.all(
          Array.from({ length: 10 }, () => naiveDecrement("prod_limited", 1)),
        );

        const successes = results.filter(Boolean).length;
        expect(successes).toBeGreaterThan(3);
      }
    },
    60_000,
  );
});
