import { Router } from "express";
import { generateCoupon, listCoupons } from "../services/coupon.service.js";
import { getReport } from "../services/report.service.js";

// Administrative operations — would sit behind auth in production.
export const adminRouter = Router();

adminRouter.post("/coupons", async (_req, res) => {
  const coupon = await generateCoupon();
  res.status(201).json({ coupon });
});

adminRouter.get("/coupons", async (_req, res) => {
  const coupons = await listCoupons();
  res.json({ coupons });
});

adminRouter.get("/report", async (_req, res) => {
  const report = await getReport();
  res.json({
    currency: "INR",
    generatedAt: new Date().toISOString(),
    ...report,
  });
});
