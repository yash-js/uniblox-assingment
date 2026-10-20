import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/db.js";

export const SEED_PRODUCTS = [
  {
    id: "prod_keyboard",
    name: "Mechanical Keyboard",
    priceCents: 349900,
    inventory: 50,
  },
  {
    id: "prod_mouse",
    name: "Wireless Mouse",
    priceCents: 129900,
    inventory: 100,
  },
  {
    id: "prod_headphones",
    name: "Noise-Cancelling Headphones",
    priceCents: 899900,
    inventory: 20,
  },
  {
    id: "prod_monitor",
    name: "27-inch Monitor",
    priceCents: 1899900,
    inventory: 10,
  },
  {
    id: "prod_limited",
    name: "Limited Edition Mousepad",
    priceCents: 99900,
    inventory: 3,
  },
] as const;

export async function seedDatabase(
  client: typeof prisma = prisma,
): Promise<void> {
  for (const product of SEED_PRODUCTS) {
    await client.product.upsert({
      where: { id: product.id },
      create: {
        id: product.id,
        name: product.name,
        priceCents: product.priceCents,
        inventory: product.inventory,
      },
      update: {
        name: product.name,
        priceCents: product.priceCents,
        inventory: product.inventory,
      },
    });
  }
}

async function main() {
  await seedDatabase();
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (error) => {
      console.error(error);
      await prisma.$disconnect();
      process.exit(1);
    });
}
