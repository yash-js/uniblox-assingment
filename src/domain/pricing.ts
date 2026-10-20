function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(value)
  ) {
    throw new Error(`${label} must be a safe non-negative integer`);
  }
}

export function lineTotalCents(
  unitPriceCents: number,
  quantity: number,
): number {
  assertSafeNonNegativeInteger(unitPriceCents, "unitPriceCents");
  assertSafeNonNegativeInteger(quantity, "quantity");
  return unitPriceCents * quantity;
}

export function subtotalCents(
  lines: ReadonlyArray<{ unitPriceCents: number; quantity: number }>,
): number {
  let total = 0;
  for (const line of lines) {
    total += lineTotalCents(line.unitPriceCents, line.quantity);
  }
  return total;
}

/**
 * Rounding rule: the discount is rounded DOWN to the nearest paisa
 * (Math.floor of subtotal * percent / 100).
 */
export function discountCents(subtotalCents: number, percent: number): number {
  assertSafeNonNegativeInteger(subtotalCents, "subtotalCents");
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error("percent must be an integer between 1 and 100");
  }
  return Math.floor((subtotalCents * percent) / 100);
}

export function totalCents(
  subtotalCentsValue: number,
  discountCentsValue: number,
): number {
  assertSafeNonNegativeInteger(subtotalCentsValue, "subtotalCents");
  assertSafeNonNegativeInteger(discountCentsValue, "discountCents");
  const total = subtotalCentsValue - discountCentsValue;
  if (total < 0) {
    throw new Error("totalCents must never be negative");
  }
  return total;
}
