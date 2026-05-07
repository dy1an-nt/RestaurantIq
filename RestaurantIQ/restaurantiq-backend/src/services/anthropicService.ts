import Anthropic, { APIError, APIUserAbortError } from '@anthropic-ai/sdk';

type RecommendationCategory =
  | 'staffing'
  | 'peak_hours'
  | 'slow_days'
  | 'sales_anomaly'
  | 'menu_performance'
  | 'operational'
  | 'customer_behavior';

interface Recommendation {
  category: RecommendationCategory;
  insight: string;
  priority: 'high' | 'medium' | 'low';
}

interface InsightsResponse {
  recommendations: Recommendation[];
  data_window_days: number;
  generated_at: string;
}

// Minimum rows required before we call the model — fewer rows produce
// low-signal outputs and waste tokens.
const MIN_ROWS_REQUIRED = 3;

const INSIGHTS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'staffing',
              'peak_hours',
              'slow_days',
              'sales_anomaly',
              'menu_performance',
              'operational',
              'customer_behavior',
            ],
          },
          insight: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['category', 'insight', 'priority'],
        additionalProperties: false,
      },
    },
    data_window_days: { type: 'number' },
    generated_at: { type: 'string' },
  },
  required: ['recommendations', 'data_window_days', 'generated_at'],
  additionalProperties: false,
} as const;

// This system prompt is sent on every request with the same content, making it
// an ideal candidate for prompt caching. The cache_control marker is applied to
// this block so Anthropic's infrastructure can reuse the KV cache entry across
// requests from the same restaurant (and even across restaurants, since the
// instructions are identical). The prompt is intentionally verbose — Haiku
// requires ≥1024 tokens in the cached block for cache write to activate.
const SYSTEM_PROMPT = `You are an expert restaurant operations analyst embedded in a live analytics dashboard. Your job is to generate concise, actionable, metric-backed recommendations for restaurant owners. You receive aggregated sales data covering a rolling window and must produce structured insights that help the operator make concrete decisions today.

## Your expertise covers seven domains

### staffing
Identify mismatches between revenue volume and implied staffing needs. Flag days or time windows where revenue is substantially above or below the weekly average, suggesting over- or under-staffing. Reference the specific revenue figure and how it compares to the mean. Never say "consider adjusting staffing" without quantifying the gap.

### peak_hours
Identify the highest-revenue days of the week. Quantify how much higher peak days are versus the weekly average. Help the operator understand when to push marketing, run promotions, or prepare extra inventory. Always cite the actual revenue number for the peak day.

### slow_days
Identify the lowest-revenue days. Compute the percentage shortfall versus the weekly mean. Suggest whether this pattern is consistent enough to warrant a structural response (e.g., a weekly promotion, reduced hours, or targeted discounting). Always cite the actual revenue figure.

### sales_anomaly
Flag any item or day where performance deviated significantly from its own trend — a sharp single-day spike or drop in orders or revenue that is not explained by day-of-week patterns. Quantify the deviation. Do not flag normal weekend/weekday variation as an anomaly.

### menu_performance
Rank items by revenue contribution. Flag items in the bottom quartile by order volume if they have been consistently underperforming. Suggest repricing, bundling, or removal for items with persistently low order counts. Always cite the order count and revenue contribution. Also flag top performers worth featuring in marketing.

### operational
Highlight patterns that suggest operational friction — e.g., a high-revenue item with unusually low order counts on specific days (possible prep/supply issue), or a category that contributes disproportionately to revenue versus order count (pricing opportunity). Keep these observations grounded in the numbers.

### customer_behavior
Infer demand patterns from day-of-week revenue trends. Identify whether the customer base skews toward weekday or weekend visits. Note any category-level patterns (e.g., a lunch-oriented category dominating weekday orders). These observations should help operators understand their customer mix without speculating beyond the data.

## Output rules — these are strict

1. Produce exactly 5 to 8 recommendations total. Cover at least 4 distinct categories.
2. Every insight must cite at least one specific metric: a revenue figure in dollars (convert from cents by dividing by 100 for display), an order count, a percentage change, or a day-of-week label with its value.
3. Each insight must be 1–2 sentences maximum. Dashboard cards have limited vertical space.
4. Do NOT use generic motivational language. Phrases like "Keep up the great work!", "Your team is doing an excellent job", "Great performance this week", or any variant are strictly prohibited. Every sentence must carry analytical content.
5. Assign priority based on revenue impact and actionability: high = immediate revenue impact (>10% swing potential), medium = meaningful but lower urgency, low = directional / nice-to-know.
6. The generated_at field must be the current UTC ISO 8601 timestamp at the moment you generate the response.
7. The data_window_days field must reflect the actual span of the data provided, not a hardcoded value.
8. If the data is too sparse to support a specific category, skip that category rather than inventing observations.
9. Never reference data you were not given. Do not assume time-of-day granularity unless the data explicitly provides it.
10. Output must be valid JSON conforming exactly to the provided schema — no extra fields, no markdown fences, no preamble.

## Metric interpretation guidance

- When comparing a day's revenue to the weekly mean, compute: deviation% = (day_value - mean) / mean * 100
- A deviation of ±15% or more is worth flagging for slow_days or peak_hours
- For menu_performance, "bottom quartile" means items ranked in the lowest 25% by total_quantity over the window
- For sales_anomaly, look for single-day values that are more than 2 standard deviations from the item's own daily mean
- Revenue figures sent to you are in cents; convert to dollars for display in insights (divide by 100)

You are operating in a production SaaS environment. Restaurant owners will act on your recommendations. Accuracy and specificity matter more than encouragement.`;

interface SummaryRow {
  date: string;
  menu_item_name: string;
  menu_item_category: string;
  total_quantity: number;
  total_revenue_cents: number;
  total_orders: number;
}

function buildPrompt(restaurantName: string, summaries: SummaryRow[]): string {
  const dates = summaries.map((r) => new Date(r.date));
  const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  const windowDays =
    Math.round((maxDate.getTime() - minDate.getTime()) / 86400000) + 1;

  const startDate = minDate.toISOString().split('T')[0];
  const endDate = maxDate.toISOString().split('T')[0];

  // Aggregate by menu item across the entire window
  const byItem = new Map<
    string,
    { name: string; category: string; qty: number; revCents: number; orders: number; days: Set<string> }
  >();
  for (const row of summaries) {
    const key = row.menu_item_name;
    const existing = byItem.get(key) ?? {
      name: row.menu_item_name,
      category: row.menu_item_category,
      qty: 0,
      revCents: 0,
      orders: 0,
      days: new Set<string>(),
    };
    existing.qty += row.total_quantity;
    existing.revCents += row.total_revenue_cents;
    existing.orders += row.total_orders;
    existing.days.add(row.date);
    byItem.set(key, existing);
  }

  const items = Array.from(byItem.values());

  // Revenue per day aggregated across all items
  const byDate = new Map<string, number>();
  for (const row of summaries) {
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.total_revenue_cents);
  }

  // Sort dates for trend display — show last 7 available days
  const sortedDates = Array.from(byDate.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const last7 = sortedDates.slice(-7);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Day-of-week averages (revenue in cents)
  const dowBuckets = new Map<number, { total: number; count: number }>();
  for (const [dateStr, revCents] of sortedDates) {
    const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
    const bucket = dowBuckets.get(dow) ?? { total: 0, count: 0 };
    bucket.total += revCents;
    bucket.count += 1;
    dowBuckets.set(dow, bucket);
  }

  const dowAverages = [0, 1, 2, 3, 4, 5, 6]
    .filter((d) => dowBuckets.has(d))
    .map((d) => {
      const b = dowBuckets.get(d)!;
      return `${dayNames[d]}: ${Math.round(b.total / b.count)} avg`;
    })
    .join(' | ');

  // Sort items by revenue descending
  const byRevDesc = [...items].sort((a, b) => b.revCents - a.revCents);
  const top5 = byRevDesc.slice(0, 5);

  // Sort items by quantity ascending for bottom performers
  const byQtyAsc = [...items].sort((a, b) => a.qty - b.qty);
  const bottom3 = byQtyAsc.slice(0, 3);

  const fmtItem = (
    item: { name: string; qty: number; revCents: number; days: Set<string> }
  ): string => {
    const avgPerDay =
      item.days.size > 0 ? Math.round(item.qty / item.days.size) : 0;
    return `- ${item.name}: ${item.qty} orders, ${item.revCents} cents revenue, avg ${avgPerDay}/day`;
  };

  const last7Lines = last7
    .map(([dateStr, revCents]) => {
      const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
      return `${dayNames[dow]}: ${revCents}`;
    })
    .join(' | ');

  return [
    `RESTAURANT: ${restaurantName}`,
    `DATA WINDOW: last ${windowDays} days (${startDate} to ${endDate})`,
    '',
    'TOP ITEMS BY REVENUE (top 5):',
    ...top5.map(fmtItem),
    '',
    `DAILY REVENUE TREND (revenue_cents per day, last 7 days):`,
    last7Lines,
    '',
    'BOTTOM ITEMS BY QUANTITY (bottom 3):',
    ...bottom3.map(fmtItem),
    '',
    'DAY-OF-WEEK AVERAGES (revenue_cents):',
    dowAverages,
  ].join('\n');
}

export async function generateInsights(params: {
  restaurantName: string;
  summaries: SummaryRow[];
}): Promise<InsightsResponse> {
  const { restaurantName, summaries } = params;

  if (summaries.length < MIN_ROWS_REQUIRED) {
    return {
      recommendations: [
        {
          category: 'operational',
          insight:
            'Insufficient sales data to generate recommendations. Add menu items and record at least 3 days of orders to unlock AI insights.',
          priority: 'low',
        },
      ],
      data_window_days: 0,
      generated_at: new Date().toISOString(),
    };
  }

  const modelId =
    process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

  // Read inside the function — dotenv.config() runs in server.ts after imports,
  // so env vars are undefined at module load time.
  const client = new Anthropic();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25_000);

  try {
    const userMessage = buildPrompt(restaurantName, summaries);

    const response = await client.messages.create(
      {
        model: modelId,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userMessage }],
        // Structured output — guarantees the response is valid JSON matching our schema.
        output_config: {
          format: {
            type: 'json_schema',
            schema: INSIGHTS_JSON_SCHEMA,
          },
        },
      },
      { signal: controller.signal }
    );

    const firstBlock = response.content[0];
    if (!firstBlock || firstBlock.type !== 'text') {
      throw new Error('Unexpected response shape from Anthropic API');
    }

    const parsed = JSON.parse(firstBlock.text) as InsightsResponse;
    return parsed;
  } catch (err: unknown) {
    if (err instanceof APIUserAbortError) {
      throw new Error('AI insights request timed out after 25 seconds');
    }
    if (err instanceof APIError) {
      console.error('[anthropic] API error:', err.message, err.status);
      throw err;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
