import { describe, expect, it } from "vitest";
import {
  discountCents,
  lineTotalCents,
  subtotalCents,
  totalCents,
} from "../src/domain/pricing.js";
import {
  eligibleMilestones,
  nextUnrewardedMilestone,
} from "../src/domain/milestones.js";

describe("pricing", () => {
  it("lineTotalCents multiplies unit price by quantity", () => {
    expect(lineTotalCents(129900, 2)).toBe(259800);
  });

  it("subtotalCents sums line totals with integer math", () => {
    expect(
      subtotalCents([
        { unitPriceCents: 100, quantity: 2 },
        { unitPriceCents: 250, quantity: 3 },
      ]),
    ).toBe(950);
  });

  it("rejects non-safe or negative inputs", () => {
    expect(() => lineTotalCents(-1, 1)).toThrow();
    expect(() => lineTotalCents(1.5, 1)).toThrow();
    expect(() => lineTotalCents(1, -2)).toThrow();
    expect(() => lineTotalCents(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow();
  });

  it("discountCents floors to the nearest paisa", () => {
    expect(discountCents(12345, 10)).toBe(1234);
    expect(discountCents(1000, 100)).toBe(1000);
  });

  it("discountCents rejects invalid percents", () => {
    expect(() => discountCents(100, 0)).toThrow();
    expect(() => discountCents(100, 101)).toThrow();
    expect(() => discountCents(100, 10.5)).toThrow();
  });

  it("totalCents never goes negative", () => {
    expect(totalCents(1000, 100)).toBe(900);
    expect(() => totalCents(100, 101)).toThrow();
  });
});

describe("milestones", () => {
  it("eligibleMilestones is floor division", () => {
    expect(eligibleMilestones(0, 5)).toBe(0);
    expect(eligibleMilestones(4, 5)).toBe(0);
    expect(eligibleMilestones(5, 5)).toBe(1);
    expect(eligibleMilestones(10, 5)).toBe(2);
  });

  it("nextUnrewardedMilestone returns the smallest missing milestone", () => {
    expect(nextUnrewardedMilestone(10, 5, [])).toBe(1);
    expect(nextUnrewardedMilestone(10, 5, [1])).toBe(2);
    expect(nextUnrewardedMilestone(10, 5, [1, 2])).toBeNull();
    expect(nextUnrewardedMilestone(4, 5, [])).toBeNull();
  });
});
