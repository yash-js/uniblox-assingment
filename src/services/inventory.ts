import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function tryDecrementInventory(
  db: DbClient,
  productId: string,
  qty: number,
): Promise<boolean> {
  const result = await db.product.updateMany({
    where: { id: productId, inventory: { gte: qty } },
    data: { inventory: { decrement: qty } },
  });
  return result.count === 1;
}
