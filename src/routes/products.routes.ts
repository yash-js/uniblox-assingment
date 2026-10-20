import { Router } from "express";
import {
  getProductById,
  listProducts,
} from "../services/product.service.js";

export const productsRouter = Router();

productsRouter.get("/", async (_req, res) => {
  const products = await listProducts();
  res.json({ currency: "INR", products });
});

productsRouter.get("/:id", async (req, res) => {
  const product = await getProductById(req.params.id);
  res.json({ currency: "INR", ...product });
});
