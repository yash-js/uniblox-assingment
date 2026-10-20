import { seedDatabase } from "../../prisma/seed.js";
import { prisma } from "../../src/db.js";

export async function resetDb(): Promise<void> {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.product.deleteMany();
  await seedDatabase(prisma);
}
