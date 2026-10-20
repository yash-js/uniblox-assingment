# DECISIONS.md

This document explains the invariants the service protects, the semantics I chose where the brief was ambiguous, the main design decisions and their trade-offs, and what I deliberately left out.

**Stack:** Node.js 22, TypeScript (strict), Express 5, Prisma 7 with SQLite (`@prisma/adapter-better-sqlite3`), zod, Vitest + Supertest.

---

## 1. System invariants

Each invariant is enforced in application logic **and**, where possible, by the database, so a bug or race in one layer is caught by the other.

| # | Invariant | Where it is enforced |
|---|---|---|
| I1 | Inventory never goes negative; we never sell more than we have | Conditional `updateMany` in `tryDecrementInventory` (`src/services/inventory.ts`); `CHECK (inventory >= 0)` in the migration |
| I2 | A cart produces at most one order | Cart claim `OPEN → CHECKED_OUT` as the first step of checkout; `UNIQUE(Order.cartId)` |
| I3 | Retrying a checkout never creates a second order or decrements stock twice | Idempotency lookup before and after the transaction; `UNIQUE(Order.idempotencyKey)` |
| I4 | A coupon is redeemed at most once | Conditional `updateMany` `AVAILABLE → REDEEMED` in `tryRedeemCoupon`; `UNIQUE(Order.couponId)` |
| I5 | A failed checkout changes nothing: cart, inventory and coupon are all untouched | The entire checkout runs in one transaction; any thrown error rolls it back |
| I6 | At most one coupon per order milestone | `UNIQUE(Coupon.milestone)` |
| I7 | An order can always explain what was bought and how the total was calculated, even after product data changes | Snapshot fields on `OrderItem` (`productName`, `unitPriceCents`, `lineTotalCents`) and `discountPercent` on `Order`; the order view is built only from order rows |
| I8 | `total = subtotal − discount`, and the total is never negative | `src/domain/pricing.ts` (percent limited to 1–100); `CHECK` constraints on order amounts |
| I9 | Cart mutations cannot land on a cart that has already been checked out | Conditional `updateMany` on `Cart` (`status = OPEN`) as the first statement of every cart mutation transaction |
| I10 | The report reconciles with the orders and coupons the API returns, and reading it never mutates state | Report is computed on demand from `Order`/`OrderItem`/`Coupon` inside a single read transaction; no stored counters |

---

## 2. Ambiguities and chosen semantics

### Carts, prices and availability
- **Price change after add-to-cart:** the cart does **not** lock prices. The cart view always shows the current price, and checkout charges the price at checkout time. The order snapshots that price.
- **Availability change after add-to-cart:** adding or updating an item performs a *soft* check and rejects a quantity above current stock (`409 INSUFFICIENT_INVENTORY`), so invalid quantities never silently enter a cart. No stock is reserved. The authoritative check happens atomically at checkout.
- **Add vs update:** `POST /carts/:id/items` *adds* (increments an existing line); `PUT /carts/:id/items/:productId` *sets* an absolute quantity. Quantity must be an integer from 1 to 100; removing a line is done with `DELETE`, not `quantity: 0`.

### Checkout and retries
| Situation | Behaviour |
|---|---|
| Same key, same cart, same coupon, order already placed | `200`, same order, header `Idempotent-Replayed: true` |
| Same key, different cart or different coupon | `422 IDEMPOTENCY_KEY_MISMATCH` |
| Same key, earlier attempt failed (e.g. out of stock) | Re-executes. Only successful checkouts are recorded; a failed one rolled back and changed nothing |
| Different key on an already checked-out cart | `409 CART_ALREADY_CHECKED_OUT` with `details.orderId` |

### Coupons
| Question | Choice | Reason |
|---|---|---|
| How are milestones counted? | `eligible = floor(successfulOrders / n)`. With n = 5, milestone 1 unlocks at order 5, milestone 2 at order 10 | Derived from orders; no separate counter that can drift |
| Do orders that used a coupon count toward milestones? | Yes | The brief says "every nth successfully placed order" with no exception |
| Admin skipped a milestone and orders kept growing | Each call generates **one** coupon for the lowest unrewarded eligible milestone; call again for the next | No milestone is lost, and each coupon maps to exactly one milestone |
| No milestone eligible | `409 NO_ELIGIBLE_MILESTONE` with `ordersPlaced`, `everyNOrders`, `nextMilestoneAt` | Tells the admin when to retry |
| Who owns a coupon? | Nobody — it is a bearer code | There is no authentication, so ownership cannot be enforced |
| Expiry | None | Deferred (timebox) |
| Coupons per order | At most one | Stacking makes calculation order ambiguous |
| Config `x` changes later | Each coupon stores its own `discountPercent` at generation time | Existing coupons keep their value; orders record the percent applied |
| Code format | `SAVE{x}-` + 8 random uppercase alphanumerics from `crypto.randomBytes`; input is trimmed and uppercased | Hard to guess, case-insensitive for users |

---

## 3. Material design decisions

### Decision 1: Atomic conditional updates instead of read-then-write

**Context:** Two checkouts for the last units of a product, or two checkouts using the same coupon, must not both succeed.

**Options considered:**
- Read the row, check in application code, then write (`findUnique` → `if` → `update`).
- Pessimistic row locks (`SELECT … FOR UPDATE`).
- Optimistic locking with a version column and retries.
- A single conditional statement: `UPDATE … SET inventory = inventory - :qty WHERE id = :id AND inventory >= :qty`, and check the affected row count.

**Choice:** Conditional `updateMany` with the guard in the `WHERE` clause, for inventory (`inventory >= qty`), coupons (`status = AVAILABLE`) and the cart claim (`status = OPEN`). `count === 0` means the guard failed.

**Why:** Read-then-write has a gap between the read and the write in which another request can act on the same stale value. SQLite does not support `SELECT … FOR UPDATE`. Version columns add retry loops for no benefit here. A conditional update makes the check and the write a single atomic statement, and it behaves the same way on Postgres, where the second transaction waits for the row lock and re-evaluates the `WHERE` clause against the committed row.

**Consequences:** Logic is short and portable. When a guard fails, a second read is needed only to build a helpful error (e.g. `available` in `INSUFFICIENT_INVENTORY`); that read is informational and never makes the decision.

### Decision 2: Database constraints as the last line of defence

**Context:** Application checks can be wrong or raced.

**Options considered:** Rely only on application logic; or add unique and check constraints in the schema as well.

**Choice:** `UNIQUE` on `Order.cartId`, `Order.idempotencyKey`, `Order.couponId`, `Coupon.milestone`, `Coupon.code`, `CartItem(cartId, productId)`; `CHECK` constraints on inventory, prices, quantities, order amounts and coupon percent (written in the migration SQL because the Prisma schema cannot express them).

**Why:** If any race slips past the application logic, the database still refuses to store a second order for a cart, a second redemption of a coupon, or negative stock. Unique constraints also hold across multiple application instances without any extra coordination.

**Consequences:** Constraint violations must be translated into client errors. Prisma `P2002` is mapped to `409` (`CONFLICT` by default, or a more specific code where the service catches it), so a constraint hit is never a `500`.

### Decision 3: Idempotency key stored on the order, not in a response cache

**Context:** A client that times out will retry checkout; the retry must return the original result instead of creating a second order.

**Options considered:**
- A separate `IdempotencyKey` table that caches every response (success and failure), with request hashing and TTL.
- Rely on the cart alone (a checked-out cart returns its order).
- Store the key as a unique column on `Order`.

**Choice:** Required `Idempotency-Key` header, stored in `Order.idempotencyKey` (unique). Lookup before the transaction; if the transaction fails with `CART_ALREADY_CHECKED_OUT` or a unique violation on the key, look up again and replay if the key, cart and coupon match.

**Why:** Only a successful checkout changes state, so only successes need to be remembered. A failed attempt rolled back completely, so re-executing it is safe and may legitimately succeed later (e.g. after restocking). Using the cart alone cannot distinguish "the same request again" from "a different checkout attempt with another coupon", which is why the key and the payload are compared.

**Consequences:** One fewer table and no cache invalidation. Keys never expire (deferred). Failed responses are not replayed byte-for-byte; a retry after failure gets a fresh evaluation.

### Decision 4: Price is decided at checkout, not locked when an item is added

**Context:** The brief asks what happens when price changes between add-to-cart and checkout.

**Options considered:**
- Lock the price at add time and honour it at checkout.
- Store the price at add time and reject checkout with `PRICE_CHANGED` if it differs.
- Use the current price at checkout and show the current price in the cart view.

**Choice:** Current price at checkout; the cart view always shows current prices; the order snapshots the price actually charged.

**Why:** Locking prices makes carts a way to hold old prices indefinitely. Rejecting on change is the most customer-friendly option but needs extra request fields and client handling. Using the current price keeps one source of truth and is what the cart view already shows.

**Consequences:** If the price changes between the client's last cart view and checkout, the customer pays the new price without an explicit warning. This is a known weakness (see section 7); the planned fix is an optional `expectedTotalCents` in the checkout request.

### Decision 5: No inventory reservation on add-to-cart

**Context:** Should adding to a cart hold stock?

**Options considered:** Reserve on add with an expiry; or soft-check on add and decrement only at checkout.

**Choice:** Soft check on add/update, atomic decrement at checkout.

**Why:** Reservations let abandoned carts block stock and require expiry, cleanup and release logic, which is out of scope for the timebox. The soft check still prevents obviously invalid quantities from entering a cart.

**Consequences:** A customer can see an item as available and still lose it at checkout to someone faster. The cart view exposes `isAvailable` per line so clients can warn before checkout.

### Decision 6: Coupon redemption inside the checkout transaction

**Context:** A coupon must not be lost by a checkout that fails, and must not be redeemed by two concurrent checkouts.

**Options considered:**
- Validate the coupon, place the order, then mark the coupon used.
- Reserve the coupon in a separate step and release it on failure.
- Redeem with a conditional update inside the same transaction as the order.

**Choice:** In the checkout transaction: claim cart → redeem coupon (`AVAILABLE → REDEEMED`) → decrement inventory → snapshot prices → create order.

**Why:** If anything after redemption fails, the rollback returns the coupon to `AVAILABLE` automatically; there is no compensating "release" step to forget. The conditional update guarantees only one concurrent checkout can redeem it, and `UNIQUE(Order.couponId)` backs that up.

**Consequences:** Simple and correct within one database. It would need rethinking only if redemption and order creation lived in different services.

### Decision 7: Integer minor units with floor rounding

**Context:** Money must be calculated without floating-point errors, and discounts must be deterministic.

**Options considered:** JavaScript numbers as rupees; decimal libraries / `Decimal` columns; integer paise.

**Choice:** All amounts are integer paise in fields ending in `Cents`. `discountCents = floor(subtotalCents × percent / 100)`.

**Why:** Integers are exact, simple to store in SQLite, and easy to reason about. With only a percentage discount there is a single rounding point, so a decimal library adds dependency without benefit.

**Consequences:** Rounding favours the store by less than one paisa per order. All arithmetic stays well inside JavaScript's safe-integer range for realistic order sizes.

### Decision 8: Report computed on demand in one read transaction

**Context:** The report must reconcile with orders and coupons, and must not mutate state.

**Options considered:** Maintain running counters updated during checkout; or aggregate from the source tables on each request.

**Choice:** `aggregate` and `groupBy` over `Order`, `OrderItem` and `Coupon`, all inside one `$transaction`.

**Why:** Stored counters can drift from the data they summarise. Aggregating from the source tables makes the report correct by construction. Running all queries in one transaction ensures they read the same snapshot; otherwise an order committing between two queries could make product totals disagree with the overall gross.

**Consequences:** Cost grows with the number of orders, which is fine at this scale. At large scale this would move to incrementally maintained aggregates or a replica (section 8).

### Decision 9: SQLite + Prisma, and being explicit about what it hides

**Context:** The service needs real transactions and constraints but should run with no external services.

**Options considered:** In-memory store with manual locks; Postgres in Docker; SQLite.

**Choice:** SQLite via Prisma with the better-sqlite3 adapter, WAL mode and `busy_timeout = 5000`.

**Why:** Zero setup for reviewers, real transactions, real unique and check constraints.

**Consequences:** The adapter serializes interactive transactions in-process with a `Semaphore(1)`. That means a naive implementation would also pass concurrency tests that go through the HTTP layer. To make sure correctness does not rely on this, I added negative-control tests that run the inventory and coupon helpers **outside** a transaction: the conditional updates hold, while a deliberately naive read-then-write version oversells. Throughput is limited to one writing transaction at a time.

---

## 4. Transaction, concurrency and idempotency strategy

**Checkout (single transaction):**
1. Claim the cart: `UPDATE Cart SET status = 'CHECKED_OUT' WHERE id = ? AND status = 'OPEN'`. Zero rows → `CART_NOT_FOUND` or `CART_ALREADY_CHECKED_OUT`. Claiming first is safe because any later failure rolls the status back to `OPEN`.
2. Redeem the coupon if supplied (conditional update). Zero rows → `COUPON_NOT_FOUND` or `COUPON_ALREADY_REDEEMED`.
3. Load items; none → `CART_EMPTY`.
4. Decrement inventory per item, sorted by `productId` (deterministic order; on Postgres this avoids deadlocks between checkouts touching the same products). Shortages are collected so the error lists every short item, then `INSUFFICIENT_INVENTORY` is thrown.
5. Read current names and prices inside the transaction, compute lines, subtotal, discount and total.
6. Create the order and its snapshot items.

**Cart mutations:** each runs in a transaction whose first statement is a conditional write on the cart (`status = OPEN`). In SQLite this acquires the write lock, so the status check and the item write are atomic with respect to a concurrent checkout.

**Coupon generation:** in a transaction, count orders, compute the next unrewarded milestone, insert the coupon. A concurrent duplicate hits `UNIQUE(Coupon.milestone)` and receives `409 MILESTONE_ALREADY_REWARDED`.

**Idempotency:** described in Decision 3. A concurrent duplicate with the same key loses the cart claim (or hits the unique key), then the post-failure lookup finds the winner's order and replays it, so both callers receive the same order.

**What the tests prove:**
- 10 parallel checkouts for a product with 3 in stock → exactly 3 succeed, 7 get `INSUFFICIENT_INVENTORY`, stock ends at 0.
- 5 parallel checkouts of one cart with different keys → exactly one order.
- 5 parallel checkouts of one cart with the same key → one order, all callers receive it.
- Two carts racing for one coupon → exactly one redemption; the loser's cart is still open and its stock restored.
- 5 parallel admin generations at one eligible milestone → exactly one coupon.
- Reports requested during parallel checkouts always reconcile.
- Negative controls: naive read-then-write oversells; the real helpers do not.
- Parallel scenarios run in loops of 5–10 iterations to surface flaky races.

---

## 5. Money and rounding

- All amounts are integers in paise (INR); API fields end in `Cents`.
- `lineTotalCents = unitPriceCents × quantity`; `subtotalCents = Σ lineTotalCents`.
- `discountCents = floor(subtotalCents × percent / 100)`, with `percent` an integer from 1 to 100.
- `totalCents = subtotalCents − discountCents`, asserted non-negative in code and by a `CHECK` constraint.
- Pricing functions are pure (`src/domain/pricing.ts`) and reject non-integer or negative input.
- Orders store the percent that was applied, so totals can be recomputed and explained later.

---

## 6. Error model

- Every error has the shape `{ "error": { "code": string, "message": string, "details"?: object } }`.
- `code` is the stable contract clients branch on; `message` is for humans and may change.
- Status codes:
  - `400` — malformed input (`VALIDATION_ERROR`, `INVALID_JSON`, `IDEMPOTENCY_KEY_REQUIRED`)
  - `404` — missing resource (`PRODUCT_NOT_FOUND`, `CART_NOT_FOUND`, `CART_ITEM_NOT_FOUND`, `ORDER_NOT_FOUND`, `COUPON_NOT_FOUND`, `ROUTE_NOT_FOUND`)
  - `409` — conflict with current state (`CART_NOT_OPEN`, `CART_ALREADY_CHECKED_OUT`, `INSUFFICIENT_INVENTORY`, `COUPON_ALREADY_REDEEMED`, `NO_ELIGIBLE_MILESTONE`, `MILESTONE_ALREADY_REWARDED`, `CONFLICT`)
  - `422` — well-formed but semantically unacceptable (`CART_EMPTY`, `IDEMPOTENCY_KEY_MISMATCH`)
  - `500` — `INTERNAL_ERROR`, generic message, real error logged server-side, no stack traces sent
- `details` carries machine-readable context, e.g. `{ productId, requested, available }` for stock errors and `orderId` for an already checked-out cart.

---

## 7. Implemented vs intentionally deferred

**Implemented:** products, carts, checkout with idempotent replay, orders with snapshots, milestone coupons with atomic redemption, admin coupon generation and listing, reconciling read-only report, consistent error model, concurrency and negative-control tests, README, `requests.http`, and `npm run demo`.

**Deferred:**
- Authentication and authorization; `/admin/*` routes are unprotected.
- Coupon expiry and per-customer ownership.
- Idempotency for `POST /admin/coupons`: a retried admin call may generate the **next** milestone's coupon if one is eligible.
- Expiry/cleanup of idempotency keys.
- **Price-change warning at checkout:** if price changes between the last cart view and checkout, the customer pays the new price without being told. Known weakness.
- Real payment integration. It would require an order state machine (`PENDING_PAYMENT → PAID / FAILED`), a webhook, and moving the payment call outside the database transaction.
- Pagination, rate limiting, structured logging and metrics.

---

## 8. Multiple instances and production scale

- **Database:** move to Postgres. The adapter's in-process mutex no longer exists, but the conditional updates remain atomic: a concurrent transaction waits for the row lock and re-checks the `WHERE` clause on the committed row. Unique constraints work across all instances unchanged.
- **Report isolation:** Postgres defaults to `READ COMMITTED`, where each statement sees its own snapshot. The report transaction must run at `REPEATABLE READ` to keep the single-snapshot guarantee. Heavy reporting should move to a read replica or incrementally maintained aggregates.
- **Hot products:** many checkouts for one product contend on one row. Options: short transactions (already the case), a reservation queue, or splitting stock into buckets.
- **Idempotency:** works as-is across instances because the key is a unique column. Add a TTL and a cleanup job.
- **Payments and side effects:** an order state machine with an outbox table, so emails or payment events are published reliably after commit instead of inside the transaction.
- **Operations:** connection pooling, structured logs with request IDs, metrics on conflict and retry rates.

---

## 9. How I used AI tools

I used Claude to break the assignment down, decide the build order and talk through the concurrency design before writing code, and Cursor to implement each step from a specific prompt. I built the service in small steps (setup, schema, products, carts, checkout, idempotency, coupons, report, docs) and reviewed the generated code and tests at each step before committing.

**Example of correcting AI output:** after the checkout step, the generated concurrency tests all passed. When I asked how the Prisma SQLite adapter handles overlapping transactions, it turned out the adapter serializes them with a `Semaphore(1)`. That meant the tests would also have passed with a naive `findUnique → if → update` implementation, so they were not actually proving our oversell protection. I added negative-control tests that call the inventory and coupon helpers outside a transaction, plus a deliberately naive version that is expected to oversell. The naive version oversells and ours does not, so the suite can now detect an incorrect implementation.

**Example of a design redirection:** the first instinct for preventing oversell was a row lock, but SQLite has no `SELECT … FOR UPDATE`. I chose conditional updates instead, which also carry over unchanged to Postgres.

---

## 10. What I would examine first with two more hours

1. Add optional `expectedTotalCents` to checkout and return `409 PRICE_CHANGED` when prices moved, closing the known weakness.
2. Run the concurrency suite against Postgres in Docker to verify the multi-instance claims instead of only reasoning about them.
3. Add `Idempotency-Key` support to `POST /admin/coupons`.
4. Add expiry for idempotency keys and coupons.