import Anthropic, { APIError } from '@anthropic-ai/sdk';

export interface SummaryRow {
  menu_item_id: string | null;
  date: string;
  total_quantity: number;
  total_revenue_cents: number;
  total_orders: number;
  // PostgREST returns embedded relations as arrays even for many-to-one FKs.
  menu_items: { name: string; category: string }[] | null;
}

export interface Insight {
  category:
    | 'staffing'
    | 'peak_hours'
    | 'slow_days'
    | 'sales_anomaly'
    | 'menu_performance'
    | 'operational'
    | 'customer_behavior';
  title: string;
  recommendation: string;
  metric: string;
}

export interface InsightsResult {
  insights: Insight[];
}

const INSIGHTS_TOOL: Anthropic.Tool = {
  name: 'report_insights',
  description: 'Report 5–8 prioritized operational insights for a restaurant based on sales data.',
  input_schema: {
    type: 'object' as const,
    properties: {
      insights: {
        type: 'array',
        minItems: 5,
        maxItems: 8,
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
            title: {
              type: 'string',
              description: 'Short headline, under 10 words',
            },
            recommendation: {
              type: 'string',
              description: '1–2 sentences of plain-English advice',
            },
            metric: {
              type: 'string',
              description: 'The specific number or trend cited as evidence',
            },
          },
          required: ['category', 'title', 'recommendation', 'metric'],
        },
      },
    },
    required: ['insights'],
  },
};

// Intentionally verbose (>1024 tokens) to satisfy Haiku's minimum cacheable prefix length.
const SYSTEM_PROMPT = `You are an expert restaurant operations analyst. Your job is to analyze daily sales data \
for a restaurant and surface the most actionable insights for the owner or manager.

You will receive a JSON array of daily sales summaries, each containing:
- date: ISO date string (YYYY-MM-DD)
- menu_item_name: the name of the menu item (or "Unknown" if unavailable)
- menu_item_category: the item's menu category (Appetizers, Mains, Desserts, Drinks, etc.)
- total_quantity: number of units sold that day
- total_revenue_cents: total revenue in cents — divide by 100 to get dollars
- total_orders: number of orders that included this item

Your task is to identify 5–8 high-value insights spanning as many distinct categories as possible. \
Aim for at least 4 different categories from this set: \
staffing, peak_hours, slow_days, sales_anomaly, menu_performance, operational, customer_behavior.

Guidelines for high-quality insights:

1. Be specific — cite the actual numbers. Do not say "sales are down"; instead say \
"BBQ Ribs revenue fell 23% over the last 14 days ($1,440 → $1,108)."

2. Be actionable — every insight must tell the owner what to DO, not just what happened. \
Bad: "Truffle Fries are popular." Good: "Truffle Fries are your highest-margin appetizer — \
feature them in your social posts this week to drive attach-rate."

3. Revenue figures — all monetary data is in cents. When citing dollar amounts in your recommendations, \
divide by 100 and format with a dollar sign (e.g., 280000 cents → $2,800).

4. Prioritize by business impact — a $2,000/week revenue opportunity outranks a $50 anomaly. \
Rank your insights accordingly so the most important one is first.

5. Trend analysis — compare the most recent 14 days against the prior 14 days where possible. \
Compute the percentage change and include it in the metric field.

6. Menu performance — identify top performers worth promoting and underperformers worth \
cutting, repricing, or repositioning. Flag items with high margin (price - cost) that are underselling.

7. Volume patterns — detect days of the week or date ranges with unusually high or low total order counts. \
Use these to suggest staffing adjustments or promotional timing.

8. Anomalies — flag any item whose sales fell or rose more than 20% week-over-week. Hypothesize a cause \
(seasonal shift, placement change, out-of-stock) if the pattern is clear.

9. Conciseness — keep recommendations to 1–2 sentences each. Managers read these between services on a phone.

10. Data fidelity — do not invent data. Only reference numbers that appear in the data you were given.

You must call the report_insights tool with your findings. Do not output any text outside the tool call.`;

const FALLBACK: InsightsResult = {
  insights: [
    {
      category: 'menu_performance',
      title: 'Not enough data yet',
      recommendation:
        'Keep recording sales for a few more days — insights appear once at least 3 days of data are available.',
      metric: 'fewer than 3 days of daily summaries found',
    },
  ],
};

export async function generateInsights(summaries: SummaryRow[]): Promise<InsightsResult> {
  if (summaries.length < 3) return FALLBACK;

  // Instantiated here (not at module load) so dotenv has already run by the time we read the key.
  const client = new Anthropic();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const userMessage = JSON.stringify(
      summaries.map((s) => {
        const item = s.menu_items?.[0];
        return {
          date: s.date,
          menu_item_name: item?.name ?? 'Unknown',
          menu_item_category: item?.category ?? 'Unknown',
          total_quantity: s.total_quantity,
          total_revenue_cents: s.total_revenue_cents,
          total_orders: s.total_orders,
        };
      }),
      null,
      2,
    );

    const response = await client.messages.create(
      {
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [INSIGHTS_TOOL],
        tool_choice: { type: 'tool', name: 'report_insights' },
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal },
    );

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolBlock) throw new Error('No tool_use block in response');

    return toolBlock.input as InsightsResult;
  } catch (err) {
    if (err instanceof APIError) {
      console.error(`[insights] Anthropic API error ${err.status}:`, err.message);
    } else {
      console.error('[insights] Unexpected error:', err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
