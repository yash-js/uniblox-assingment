# Uniblox storefront API

A small Node.js + TypeScript + Express + Prisma (SQLite) storefront: products, carts, atomic checkout with inventory, idempotent orders, milestone coupons, and an admin revenue report. Money is stored and returned as integer paise (`*Cents` fields) with currency `INR`.

**TIME_SPENT: __ hours**

**Live demo (optional):** https://uniblox.yashpurani.com — Swagger UI at `/docs`.
Hosted on a personal home server, so it may occasionally be offline; the local setup below is the primary way to run the service.

**API docs:** interactive Swagger UI at [http://localhost:3000/docs](http://localhost:3000/docs) (OpenAPI source: [openapi.yaml](./openapi.yaml), also served as [http://localhost:3000/openapi.json](http://localhost:3000/openapi.json)).

See also [DECISIONS.md](./DECISIONS.md).

## Requirements

- **Node.js 22+** (see `.nvmrc` and `package.json` `engines`)
- npm
- **`better-sqlite3` is a native module** — `npm install` must be able to download or build native addons (working C/C++ toolchain / prebuilds). If install fails on `better-sqlite3`, fix native build tooling before continuing.

## Setup & run

Commands in order (from the repo root):

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

- `npm run db:migrate` runs `prisma migrate deploy` (non-interactive; safe for reviewers).
- `npm run db:seed` upserts the fixed catalog products.
- `npm run dev` starts the API (default [http://localhost:3000](http://localhost:3000)).

To wipe the SQLite database and re-apply migrations + seed:

```bash
npm run db:reset
```

## Tests

```bash
npm test
```

Concurrency suites prove checkout/inventory/coupon claims stay correct under parallel requests (no oversell, single winner for cart/coupon/idempotency). Negative-control suites (`inventory-race`, coupon redeem outside a transaction) prove protection comes from conditional `updateMany`, not from the adapter’s transaction mutex — a naive read-then-write path oversells.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP listen port |
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite file URL |
| `COUPON_EVERY_N_ORDERS` | `5` | Milestone size `n` (coupon eligible every `n` orders) |
| `COUPON_DISCOUNT_PERCENT` | `10` | Discount percent `x` stamped onto newly generated coupons |

## Seeded products

Prices shown in ₹ (API fields use paise).

| id | name | price (₹) | inventory |
|----|------|-----------|-----------|
| `prod_keyboard` | Mechanical Keyboard | 3499.00 | 50 |
| `prod_mouse` | Wireless Mouse | 1299.00 | 100 |
| `prod_headphones` | Noise-Cancelling Headphones | 8999.00 | 20 |
| `prod_monitor` | 27-inch Monitor | 18999.00 | 10 |
| `prod_limited` | Limited Edition Mousepad | 999.00 | 3 |

## Money

All monetary amounts are **integer paise** in fields whose names end with `Cents` (e.g. `priceCents`, `subtotalCents`). Responses include `"currency": "INR"`. Discounts are floored to the nearest paisa.

## API reference

Base URL: `http://localhost:3000` (or your `PORT`).

### `GET /health`

Success **200**:

```json
{ "status": "ok" }
```

Errors: none specific.

---

### `GET /products`

Success **200**:

```json
{
  "currency": "INR",
  "products": [
    { "id": "prod_mouse", "name": "Wireless Mouse", "priceCents": 129900, "inventory": 100 }
  ]
}
```

Errors: none specific.

---

### `GET /products/:id`

Success **200**:

```json
{
  "currency": "INR",
  "id": "prod_mouse",
  "name": "Wireless Mouse",
  "priceCents": 129900,
  "inventory": 100
}
```

| Code | Status |
|------|--------|
| `PRODUCT_NOT_FOUND` | 404 |

---

### `POST /carts`

Body: none (empty).

Success **201** (cart view):

```json
{
  "currency": "INR",
  "id": "clx...",
  "status": "OPEN",
  "items": [],
  "itemCount": 0,
  "subtotalCents": 0
}
```

Errors: none specific.

---

### `GET /carts/:cartId`

Success **200**: same cart view shape as create (with items when present).

| Code | Status |
|------|--------|
| `CART_NOT_FOUND` | 404 |

---

### `POST /carts/:cartId/items`

Body:

```json
{ "productId": "prod_mouse", "quantity": 2 }
```

Success **200**: cart view (quantity increments if the product is already in the cart).

| Code | Status |
|------|--------|
| `VALIDATION_ERROR` | 400 |
| `INVALID_JSON` | 400 |
| `CART_NOT_FOUND` | 404 |
| `PRODUCT_NOT_FOUND` | 404 |
| `CART_NOT_OPEN` | 409 |
| `INSUFFICIENT_INVENTORY` | 409 |

---

### `PUT /carts/:cartId/items/:productId`

Body:

```json
{ "quantity": 5 }
```

Success **200**: cart view.

| Code | Status |
|------|--------|
| `VALIDATION_ERROR` | 400 |
| `INVALID_JSON` | 400 |
| `CART_NOT_FOUND` | 404 |
| `CART_ITEM_NOT_FOUND` | 404 |
| `PRODUCT_NOT_FOUND` | 404 |
| `CART_NOT_OPEN` | 409 |
| `INSUFFICIENT_INVENTORY` | 409 |

---

### `DELETE /carts/:cartId/items/:productId`

Success **200**: cart view.

| Code | Status |
|------|--------|
| `CART_NOT_FOUND` | 404 |
| `CART_ITEM_NOT_FOUND` | 404 |
| `CART_NOT_OPEN` | 409 |

---

### `POST /carts/:cartId/checkout`

Headers:

- `Idempotency-Key` (required): string, 8–128 characters

Body (optional coupon):

```json
{}
```

or

```json
{ "couponCode": "SAVE10-ABCD1234" }
```

Success **201** (new order) or **200** with header `Idempotent-Replayed: true` (replay):

```json
{
  "currency": "INR",
  "id": "clx...",
  "cartId": "clx...",
  "createdAt": "2026-10-20T12:00:00.000Z",
  "items": [
    {
      "productId": "prod_mouse",
      "productName": "Wireless Mouse",
      "unitPriceCents": 129900,
      "quantity": 2,
      "lineTotalCents": 259800
    }
  ],
  "subtotalCents": 259800,
  "discountPercent": 0,
  "discountCents": 0,
  "couponCode": null,
  "totalCents": 259800
}
```

| Code | Status |
|------|--------|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 |
| `VALIDATION_ERROR` | 400 |
| `INVALID_JSON` | 400 |
| `CART_NOT_FOUND` | 404 |
| `PRODUCT_NOT_FOUND` | 404 |
| `COUPON_NOT_FOUND` | 404 |
| `CART_ALREADY_CHECKED_OUT` | 409 |
| `INSUFFICIENT_INVENTORY` | 409 |
| `COUPON_ALREADY_REDEEMED` | 409 |
| `CART_EMPTY` | 422 |
| `IDEMPOTENCY_KEY_MISMATCH` | 422 |

#### Idempotency-Key behaviour

| Situation | Result |
|-----------|--------|
| Same key + same cart + same coupon (incl. both absent) | **200** replay, header `Idempotent-Replayed: true`, same order id |
| Same key + different cart **or** different coupon (present vs absent counts) | **422** `IDEMPOTENCY_KEY_MISMATCH` |
| Same key after a **failed** checkout (no order stored) | Re-executes checkout |
| Different key on an already checked-out cart | **409** `CART_ALREADY_CHECKED_OUT` (`details.orderId` of the existing order) |

---

### `GET /orders/:orderId`

Success **200**: order view (snapshot fields only; not live product prices).

| Code | Status |
|------|--------|
| `ORDER_NOT_FOUND` | 404 |

---

### Admin endpoints

These are **administrative** operations. **No authentication is implemented.**

#### `POST /admin/coupons`

Success **201**:

```json
{
  "coupon": {
    "id": "clx...",
    "code": "SAVE10-ABCD1234",
    "discountPercent": 10,
    "milestone": 1,
    "status": "AVAILABLE",
    "createdAt": "2026-10-20T12:00:00.000Z"
  }
}
```

| Code | Status |
|------|--------|
| `NO_ELIGIBLE_MILESTONE` | 409 |
| `MILESTONE_ALREADY_REWARDED` | 409 |
| `CONFLICT` | 409 |

#### `GET /admin/coupons`

Success **200**:

```json
{ "coupons": [ /* same coupon objects, ordered by milestone */ ] }
```

#### `GET /admin/report`

Success **200** (read-only; includes `currency`, `generatedAt`, products, revenue totals, coupon counts, milestones). Does not write to the database.

---

## Error format

```json
{
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Product not found",
    "details": null
  }
}
```

`details` may be omitted, `null`, or an object (e.g. inventory shortages, milestone info). Stack traces are never returned to the client.

### All error codes

| Code | HTTP | When |
|------|------|------|
| `VALIDATION_ERROR` | 400 | Zod request validation failed |
| `INVALID_JSON` | 400 | Malformed JSON body |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing/invalid `Idempotency-Key` (need 8–128 chars) |
| `ROUTE_NOT_FOUND` | 404 | No matching route |
| `PRODUCT_NOT_FOUND` | 404 | Unknown product id |
| `CART_NOT_FOUND` | 404 | Unknown cart id |
| `CART_ITEM_NOT_FOUND` | 404 | Product line not in cart |
| `ORDER_NOT_FOUND` | 404 | Unknown order id |
| `COUPON_NOT_FOUND` | 404 | Unknown coupon code |
| `CONFLICT` | 409 | Unhandled Prisma unique constraint (`P2002`) |
| `CART_NOT_OPEN` | 409 | Mutating a non-`OPEN` cart |
| `CART_ALREADY_CHECKED_OUT` | 409 | Checkout when cart is already checked out |
| `INSUFFICIENT_INVENTORY` | 409 | Soft cart check or hard checkout stock claim failed |
| `COUPON_ALREADY_REDEEMED` | 409 | Coupon not `AVAILABLE` |
| `NO_ELIGIBLE_MILESTONE` | 409 | Admin generate with no unrewarded milestone |
| `MILESTONE_ALREADY_REWARDED` | 409 | Concurrent admin generate lost the milestone unique race |
| `CART_EMPTY` | 422 | Checkout with no cart lines |
| `IDEMPOTENCY_KEY_MISMATCH` | 422 | Idempotency key reused with different cart/coupon |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Demo script

With the server running on `PORT` (default 3000):

```bash
npm run demo
```

**Needs a freshly seeded database.** If you have already checked out carts, redeemed coupons, or advanced milestones, run `npm run db:reset` (then start `npm run dev` again) before `npm run demo`.

Executable HTTP examples for REST Client: [requests.http](./requests.http).
