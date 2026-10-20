import { Router } from "express";
import { getOrder } from "../services/order.service.js";

export const ordersRouter = Router();

ordersRouter.get("/:orderId", async (req, res) => {
  const order = await getOrder(req.params.orderId);
  res.json(order);
});
