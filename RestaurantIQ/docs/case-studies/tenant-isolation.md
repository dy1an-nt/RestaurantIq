# Case Study: Making Tenant Isolation Verifiable

## The problem

RestaurantIQ's backend uses a Supabase service-role key. That role bypasses PostgreSQL Row-Level Security, so application queries must never trust a restaurant ID supplied by the browser. A single missing tenant filter could expose or modify another restaurant's data.

Early routes repeated the same lookup in many handlers: read the JWT subject, find the restaurant whose `user_id` matches it, then use that restaurant ID for subsequent queries. Repetition made the boundary harder to audit because every copy could drift.

## Centralizing tenant resolution

I moved the shared lookup into [`requireRestaurant.ts`](../../restaurantiq-backend/src/middleware/requireRestaurant.ts). It runs after JWT authentication, resolves the restaurant from the verified `sub` claim, and attaches `restaurantId` to the request.

The middleware does not accept a tenant ID from query parameters or request bodies. Routes that operate on a nested resource still verify ownership at the write or read boundary. For example, menu item updates require the authenticated user's restaurant and the item ID to match before mutation.

Centralizing the common path reduced the number of places where the most important filter could be forgotten. It did not remove the need to review individual queries, especially tables such as `order_items` that do not carry `restaurant_id` directly.

## Testing the whole route surface

I wanted evidence stronger than a code search, so I added an HTTP-level tenant-isolation suite in [`tenantIsolation.test.ts`](../../restaurantiq-backend/src/routes/__tests__/tenantIsolation.test.ts).

The test harness mounts the real Express routers and discovers their registered routes. It then checks three layers:

1. Every discovered protected route rejects a request without a token.
2. Routes using `requireRestaurant` reject an authenticated user with no restaurant.
3. Wrong-tenant reads and writes cannot return or mutate another restaurant's resources.

The wrong-tenant cases also inspect the fake database after write attempts. A correct status code is not enough if another tenant's row was still modified.

Route discovery matters because a static hand-written list becomes stale when a new endpoint is added. The suite has a minimum route-surface assertion so an accidentally unmounted router cannot silently shrink coverage.

## Database backstop

Application scoping remains the primary boundary because the service-role connection bypasses RLS. I still enabled RLS on tenant-owned tables through [`024_enable_rls_backstop.sql`](../../restaurantiq-backend/migrations/024_enable_rls_backstop.sql).

The migration intentionally creates no policies for public `anon` or `authenticated` access. That makes direct PostgREST access default-deny while leaving the service-role backend unchanged. It protects against a future frontend query accidentally using the public Supabase client against a tenant table.

## Tradeoffs and limits

- A service-role backend remains high privilege. RLS does not rescue a missing filter inside that backend connection.
- Route discovery verifies mounted Express routes, but scheduled jobs and one-off scripts still require separate review.
- Central middleware makes the common case safer, but resource ownership must still be enforced on nested IDs and multi-step queries.

The design uses defense in depth: verified identity, centralized tenant resolution, scoped queries, adversarial HTTP tests, and a default-deny database backstop for public roles.

## Evidence

- [`auth.ts`](../../restaurantiq-backend/src/middleware/auth.ts): JWT verification
- [`requireRestaurant.ts`](../../restaurantiq-backend/src/middleware/requireRestaurant.ts): authenticated tenant resolution
- [`tenantIsolation.test.ts`](../../restaurantiq-backend/src/routes/__tests__/tenantIsolation.test.ts): auth, missing-tenant, and wrong-tenant sweeps
- [`024_enable_rls_backstop.sql`](../../restaurantiq-backend/migrations/024_enable_rls_backstop.sql): default-deny public backstop
- Historical sources: [Sprint R](../archive/sprint-notes/week-R.md), [Sprint U](../archive/sprint-notes/week-U.md), and the [R/S deep dive](../archive/sprint-notes/sprints-R-S-deep-dive.md)
