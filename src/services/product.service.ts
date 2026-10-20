import { prisma } from "../db.js";
import { notFound } from "../errors.js";

const productSelect = {
  id: true,
  name: true,
  priceCents: true,
  inventory: true,
} as const;

export async function listProducts() {
  return prisma.product.findMany({
    select: productSelect,
    orderBy: { id: "asc" },
  });
}

export async function getProductById(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: productSelect,
  });

  if (!product) {
    throw notFound("PRODUCT_NOT_FOUND", "Product not found");
  }

  return product;
}
