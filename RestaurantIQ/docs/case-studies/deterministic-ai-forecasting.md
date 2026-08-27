# Case Study: Keeping Forecast Math Outside the LLM

## The problem

The purchasing advisor needed to answer a numerical question: how many units of each menu item might sell next week? Asking an LLM to perform that calculation would make the result difficult to reproduce, test, or debug. It would also spend tokens on arithmetic that TypeScript can perform deterministically.

I separated the forecast from its explanation.

## Deterministic computation

[`forecastService.ts`](../../restaurantiq-backend/src/services/forecastService.ts) owns the numerical model. It loads restaurant-scoped menu items and daily summaries, then calculates each eligible item's projection with a linear trend over the selected trailing window.

I added guardrails around that simple model:

- At least 14 days of data are required for an item.
- Confidence is based on the amount of available history.
- Projections cannot drop below half or rise above one and a half times the previous seven-day actual.
- Unit and revenue projections are rounded before crossing the service boundary.
- Items without enough history are returned explicitly instead of receiving fabricated predictions.

The clamp is intentionally conservative. Linear regression can extrapolate aggressively from a short trend, and a purchasing recommendation that doubles an order based on noise can create real waste.

## The LLM's limited role

After TypeScript finishes the forecast, [`forecastNarrativeService.ts`](../../restaurantiq-backend/src/services/forecastNarrativeService.ts) sends only the completed item projections to Claude. The model turns those numbers into a short purchasing summary and action callouts.

The request forces a named tool with a defined output shape. The prompt prohibits invented information and requires the narrative to cite projected units and revenue from the supplied data. Claude can explain the forecast, but it cannot choose the projected quantities.

This boundary keeps the business calculation independently testable without mocking Anthropic. It also makes a model change or narrative failure separate from the numerical result.

## Cost and latency controls

The HTTP contract separates reads from generation:

- `GET /api/advisor/forecast` reads a fresh cached payload and never calls Claude.
- `POST /api/advisor/forecast/refresh` computes a forecast, requests the narrative, and stores the result.

The refresh endpoint is rate-limited. It returns an explicit insufficient-history error when no item has enough data, and it reports narrative-generation failure without storing a partial result. See [`advisor.ts`](../../restaurantiq-backend/src/routes/advisor.ts).

## Tradeoffs and limits

- Linear regression does not understand holidays, weather, promotions, stockouts, or weekly seasonality.
- Confidence measures available history, not predictive accuracy.
- The projection clamp reduces extreme mistakes but can also suppress a real demand spike.
- A better model would need backtesting against held-out weeks before it could justify more complexity.

I chose a small, testable model because the current product needs an explainable baseline more than an opaque claim of intelligence.

## Evidence

- [`forecastService.ts`](../../restaurantiq-backend/src/services/forecastService.ts): pure forecast construction and guardrails
- [`forecastNarrativeService.ts`](../../restaurantiq-backend/src/services/forecastNarrativeService.ts): schema-constrained explanation
- [`advisor.ts`](../../restaurantiq-backend/src/routes/advisor.ts): cached read and explicit refresh contract
- [`tenantIsolation.test.ts`](../../restaurantiq-backend/src/routes/__tests__/tenantIsolation.test.ts): response-envelope coverage for the forecast read route
- Historical source: [Sprint P](../archive/sprint-notes/week-P.md)
