import { prisma } from "../db.js";
import { lineTotalCents, subtotalCents } from "../domain/pricing.js";
import { conflict, notFound } from "../errors.js";
import { CartStatus, type Prisma } from "../generated/prisma/client.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export type CartView = {
  currency: "INR";
  id: string;
  status: CartStatus;
  items: Array<{
    productId: string;
    name: string;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
    availableInventory: number;
    isAvailable: boolean;
  }>;
  itemCount: number;
  subtotalCents: number;
};

export async function createCart(): Promise<CartView> {
  const cart = await prisma.cart.create({ data: {} });
  return getCartView(cart.id);
}

export async function getCart(cartId: string): Promise<CartView> {
  return getCartView(cartId);
}

export async function addCartItem(
  cartId: string,
  productId: string,
  quantity: number,
): Promise<CartView> {
  return prisma.$transaction(async (tx) => {
    await assertCartOpenForMutation(tx, cartId);

    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw notFound("PRODUCT_NOT_FOUND", "Product not found");
    }

    const existing = await tx.cartItem.findUnique({
      where: { cartId_productId: { cartId, productId } },
    });

    const requested = (existing?.quantity ?? 0) + quantity;
    if (requested > product.inventory) {
      throw conflict("INSUFFICIENT_INVENTORY", "Insufficient inventory", {
        productId,
        requested,
        available: product.inventory,
      });
    }

    await tx.cartItem.upsert({
      where: { cartId_productId: { cartId, productId } },
      create: { cartId, productId, quantity },
      update: { quantity: { increment: quantity } },
    });

    return getCartView(cartId, tx);
  });
}

export async function setCartItemQuantity(
  cartId: string,
  productId: string,
  quantity: number,
): Promise<CartView> {
  return prisma.$transaction(async (tx) => {
    await assertCartOpenForMutation(tx, cartId);

    const existing = await tx.cartItem.findUnique({
      where: { cartId_productId: { cartId, productId } },
    });
    if (!existing) {
      throw notFound("CART_ITEM_NOT_FOUND", "Cart item not found");
    }

    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw notFound("PRODUCT_NOT_FOUND", "Product not found");
    }

    if (quantity > product.inventory) {
      throw conflict("INSUFFICIENT_INVENTORY", "Insufficient inventory", {
        productId,
        requested: quantity,
        available: product.inventory,
      });
    }

    await tx.cartItem.update({
      where: { cartId_productId: { cartId, productId } },
      data: { quantity },
    });

    return getCartView(cartId, tx);
  });
}

export async function removeCartItem(
  cartId: string,
  productId: string,
): Promise<CartView> {
  return prisma.$transaction(async (tx) => {
    await assertCartOpenForMutation(tx, cartId);

    const result = await tx.cartItem.deleteMany({
      where: { cartId, productId },
    });
    if (result.count === 0) {
      throw notFound("CART_ITEM_NOT_FOUND", "Cart item not found");
    }

    return getCartView(cartId, tx);
  });
}

export async function getCartView(
  cartId: string,
  client: DbClient = prisma,
): Promise<CartView> {
  const cart = await client.cart.findUnique({
    where: { id: cartId },
    include: {
      items: {
        include: { product: true },
      },
    },
  });

  if (!cart) {
    throw notFound("CART_NOT_FOUND", "Cart not found");
  }

  const items = cart.items
    .map((item) => {
      const unitPriceCents = item.product.priceCents;
      const availableInventory = item.product.inventory;
      return {
        productId: item.productId,
        name: item.product.name,
        unitPriceCents,
        quantity: item.quantity,
        lineTotalCents: lineTotalCents(unitPriceCents, item.quantity),
        availableInventory,
        isAvailable: availableInventory >= item.quantity,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    currency: "INR",
    id: cart.id,
    status: cart.status,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotalCents: subtotalCents(items),
  };
}

async function assertCartOpenForMutation(
  tx: Prisma.TransactionClient,
  cartId: string,
): Promise<void> {
  // This conditional write takes SQLite's write lock, so the status check and
  // the item write are atomic with respect to a concurrent checkout.
  const result = await tx.cart.updateMany({
    where: { id: cartId, status: CartStatus.OPEN },
    data: { updatedAt: new Date() },
  });

  if (result.count === 0) {
    const cart = await tx.cart.findUnique({ where: { id: cartId } });
    if (!cart) {
      throw notFound("CART_NOT_FOUND", "Cart not found");
    }
    throw conflict("CART_NOT_OPEN", "Cart is not open");
  }
}
