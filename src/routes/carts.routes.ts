import { Router } from "express";
import { z } from "zod";
import {
  addCartItem,
  createCart,
  getCart,
  removeCartItem,
  setCartItemQuantity,
} from "../services/cart.service.js";

export const cartsRouter = Router();

const quantitySchema = z.number().int().min(1).max(100);

const addItemSchema = z.object({
  productId: z.string().min(1),
  quantity: quantitySchema,
});

const updateItemSchema = z.object({
  quantity: quantitySchema,
});

cartsRouter.post("/", async (_req, res) => {
  const cart = await createCart();
  res.status(201).json(cart);
});

cartsRouter.get("/:cartId", async (req, res) => {
  const cart = await getCart(req.params.cartId);
  res.json(cart);
});

cartsRouter.post("/:cartId/items", async (req, res) => {
  const body = addItemSchema.parse(req.body);
  const cart = await addCartItem(
    req.params.cartId,
    body.productId,
    body.quantity,
  );
  res.json(cart);
});

cartsRouter.put("/:cartId/items/:productId", async (req, res) => {
  const body = updateItemSchema.parse(req.body);
  const cart = await setCartItemQuantity(
    req.params.cartId,
    req.params.productId,
    body.quantity,
  );
  res.json(cart);
});

cartsRouter.delete("/:cartId/items/:productId", async (req, res) => {
  const cart = await removeCartItem(req.params.cartId, req.params.productId);
  res.json(cart);
});
