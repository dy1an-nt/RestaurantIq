# Case Study: Preserving Financial Meaning

## The problem

Restaurant analytics lose trust quickly when a number looks precise but represents the wrong thing. RestaurantIQ had two related risks: JavaScript could treat a missing item cost as zero, and DoorDash revenue could look more profitable than it was if the platform commission and flat fee were ignored.

I treated these as data-modeling problems, not formatting problems.

## Unknown cost is not zero cost

Square does not provide ingredient cost, so the owner enters it manually. I kept `cost_cents` nullable from the database through the API and UI. A missing cost means the system cannot calculate a margin. It does not mean the item costs nothing to produce.

The update route accepts integer cents and builds its database payload only from supplied fields. It also verifies that both the restaurant and item belong to the authenticated user before writing. See [`menuItems.ts`](../../restaurantiq-backend/src/routes/menuItems.ts).

For margin analysis, both `null` and zero are treated as unknown. Zero appears in some imported DoorDash data as a default, so including it would create a confident but false 100% food margin. Those items are returned separately as missing-cost items instead of being mixed into profitability totals.

## Modeling the delivery cost explicitly

RestaurantIQ does not receive authoritative per-order DoorDash fees. I chose an explicit model that a restaurant can configure: commission in basis points plus a flat fee in integer cents.

[`channelMarginService.ts`](../../restaurantiq-backend/src/services/channelMarginService.ts) calculates:

- Gross item revenue from quantity times unit price
- Food cost from quantity times `cost_cents`
- Commission with integer basis-point arithmetic
- Each order's flat fee allocated proportionally across its delivery line items
- Net revenue after food cost and the modeled delivery charge

The service uses `Math.floor` for allocated fee shares, so it never invents fractional cents. The rounding remainder is intentionally left unallocated and pinned by tests. That is a conservative, explainable rule, even though a more complex largest-remainder allocation could reconcile every final cent.

## Tenant-safe access without a tenant column

`order_items` does not contain `restaurant_id`. I did not query it directly from client-provided order IDs. The service first loads orders scoped to the authenticated restaurant, then fetches order items only for that verified set of order IDs. Large lists are split into bounded batches so PostgREST query URLs remain manageable.

This two-step read is more verbose than a direct query, but it preserves the tenant boundary without denormalizing another column solely for this report.

## Tradeoffs and limits

- The delivery fee is a configured estimate, not an imported DoorDash settlement value.
- Revenue is based on menu line items, not POS gross totals that may include tax, tips, service fees, and discounts.
- Items without a known cost are excluded from margin totals, so the report favors honesty over apparent completeness.
- Cost edits currently overwrite the prior value; there is no cost-change audit history yet.

## Evidence

- [`channelMarginService.ts`](../../restaurantiq-backend/src/services/channelMarginService.ts): data access and integer-cents calculations
- [`channelMarginService.test.ts`](../../restaurantiq-backend/src/services/__tests__/channelMarginService.test.ts): rounding, missing-cost, fee, and channel cases
- [`menuItems.ts`](../../restaurantiq-backend/src/routes/menuItems.ts): validated, tenant-scoped cost updates
- [`known-limitations.md`](../known-limitations.md): current revenue and fee-model constraints
- Historical sources: [manual cost entry](../archive/sprint-notes/week-7.md) and [cross-channel margins](../archive/sprint-notes/week-Q.md)
