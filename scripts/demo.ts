const baseUrl = `http://localhost:${process.env.PORT ?? "3000"}`;

type Json = Record<string, unknown>;

async function request(
  method: string,
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Json) : {};
  return { status: response.status, body, headers: response.headers };
}

function step(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  step("List products");
  const products = await request("GET", "/products");
  console.log(products.status, {
    count: Array.isArray(products.body.products)
      ? products.body.products.length
      : 0,
  });

  step("Create cart");
  const created = await request("POST", "/carts");
  const cartId = String(created.body.id);
  console.log(created.status, { cartId, status: created.body.status });

  step("Add items");
  const added = await request("POST", `/carts/${cartId}/items`, {
    body: { productId: "prod_mouse", quantity: 2 },
  });
  console.log(added.status, {
    itemCount: added.body.itemCount,
    subtotalCents: added.body.subtotalCents,
  });

  step("View cart");
  const cart = await request("GET", `/carts/${cartId}`);
  console.log(cart.status, {
    itemCount: cart.body.itemCount,
    subtotalCents: cart.body.subtotalCents,
  });

  const idempotencyKey = `demo-checkout-${Date.now()}`;

  step("Checkout (fresh)");
  const checkout = await request("POST", `/carts/${cartId}/checkout`, {
    headers: { "Idempotency-Key": idempotencyKey },
    body: {},
  });
  const orderId = String(checkout.body.id);
  console.log(checkout.status, {
    orderId,
    totalCents: checkout.body.totalCents,
    replayed: checkout.headers.get("Idempotent-Replayed"),
  });

  step("Checkout retry (same Idempotency-Key)");
  const replay = await request("POST", `/carts/${cartId}/checkout`, {
    headers: { "Idempotency-Key": idempotencyKey },
    body: {},
  });
  console.log(replay.status, {
    orderId: replay.body.id,
    sameOrder: replay.body.id === orderId,
    replayed: replay.headers.get("Idempotent-Replayed"),
  });

  step("Checkout again with a new key (expect 409)");
  const secondKey = await request("POST", `/carts/${cartId}/checkout`, {
    headers: { "Idempotency-Key": `${idempotencyKey}-other` },
    body: {},
  });
  console.log(secondKey.status, {
    code: (secondKey.body.error as Json | undefined)?.code,
    orderId: (secondKey.body.error as Json | undefined)?.details
      ? ((secondKey.body.error as Json).details as Json).orderId
      : undefined,
  });

  step("Place more orders to reach coupon milestone");
  for (let i = 0; i < 4; i++) {
    const fillCart = await request("POST", "/carts");
    const fillId = String(fillCart.body.id);
    await request("POST", `/carts/${fillId}/items`, {
      body: { productId: "prod_mouse", quantity: 1 },
    });
    const placed = await request("POST", `/carts/${fillId}/checkout`, {
      headers: { "Idempotency-Key": `demo-fill-${Date.now()}-${i}` },
      body: {},
    });
    console.log(`fill #${i + 1}`, placed.status, { orderId: placed.body.id });
  }

  step("Generate admin coupon");
  const couponRes = await request("POST", "/admin/coupons");
  const couponCode = String((couponRes.body.coupon as Json).code);
  console.log(couponRes.status, {
    code: couponCode,
    milestone: (couponRes.body.coupon as Json).milestone,
  });

  step("Checkout with coupon");
  const couponCart = await request("POST", "/carts");
  const couponCartId = String(couponCart.body.id);
  await request("POST", `/carts/${couponCartId}/items`, {
    body: { productId: "prod_keyboard", quantity: 1 },
  });
  const discounted = await request("POST", `/carts/${couponCartId}/checkout`, {
    headers: { "Idempotency-Key": `demo-coupon-${Date.now()}` },
    body: { couponCode },
  });
  console.log(discounted.status, {
    orderId: discounted.body.id,
    subtotalCents: discounted.body.subtotalCents,
    discountCents: discounted.body.discountCents,
    totalCents: discounted.body.totalCents,
    couponCode: discounted.body.couponCode,
  });

  step("Reuse coupon (expect 409)");
  const reuseCart = await request("POST", "/carts");
  const reuseCartId = String(reuseCart.body.id);
  await request("POST", `/carts/${reuseCartId}/items`, {
    body: { productId: "prod_mouse", quantity: 1 },
  });
  const reuse = await request("POST", `/carts/${reuseCartId}/checkout`, {
    headers: { "Idempotency-Key": `demo-reuse-${Date.now()}` },
    body: { couponCode },
  });
  console.log(reuse.status, {
    code: (reuse.body.error as Json | undefined)?.code,
  });

  step("Admin report reconciliation");
  const report = await request("GET", "/admin/report");
  const gross = Number(report.body.grossRevenueCents);
  const discount = Number(report.body.totalDiscountCents);
  const net = Number(report.body.netRevenueCents);
  console.log(report.status, {
    ordersPlaced: report.body.ordersPlaced,
    grossRevenueCents: gross,
    totalDiscountCents: discount,
    netRevenueCents: net,
    reconciles: gross - discount === net,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
