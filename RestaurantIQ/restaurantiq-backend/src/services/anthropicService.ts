import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { z } from 'zod';

export interface SummaryRow {
  menu_item_id: string | null;
  date: string;
  total_quantity: number;
  total_revenue_cents: number;
  total_orders: number;
  menu_items: { name: string; category: string } | null;
}

// Where an owner should go to investigate an insight. Maps 1:1 to a real route
// in the frontend (see InsightsPanel LINK_CONFIG) — keep these in sync.
export type InsightLink = 'analytics' | 'forecast' | 'margins' | 'menu' | 'alerts';

// Priority drives both ordering and the chip colour. The AI assigns it directly
// (Sprint T) instead of the frontend guessing it from keywords.
export type InsightPriority = 'high' | 'medium' | 'low';

export interface Insight {
  category:
    | 'staffing'
    | 'peak_hours'
    | 'slow_days'
    | 'sales_anomaly'
    | 'menu_performance'
    | 'operational'
    | 'customer_behavior';
  /** How urgently the owner should act. high = today, low = monitor. */
  priority: InsightPriority;
  /** Short headline, under 10 words. */
  title: string;
  /** One sentence: what is happening and why it matters. */
  explanation: string;
  /** The specific numbers cited as evidence. */
  metric: string;
  /** Expected business impact in concrete terms (dollars/week, % of revenue). */
  impact: string;
  /** The single recommended next action. */
  action: string;
  /** Which product area to open to investigate this insight. */
  link: InsightLink;
}

export interface InsightsResult {
  insights: Insight[];
}

// Ordering weight for sorting; lower sorts first.
const PRIORITY_RANK: Record<InsightPriority, number> = { high: 0, medium: 1, low: 2 };

// Runtime contract for one insight coming back from the model. tool_choice
// forces the model to call report_insights, but the API does not guarantee the
// arguments conform to the tool's input_schema — so every insight is validated
// here before it ships through GET /api/insights to any consumer (the SPA
// re-normalizes defensively, but the API contract is enforced server-side).
const insightSchema = z.object({
  category: z.enum([
    'staffing',
    'peak_hours',
    'slow_days',
    'sales_anomaly',
    'menu_performance',
    'operational',
    'customer_behavior',
  ]),
  priority: z.enum(['high', 'medium', 'low']),
  title: z.string().min(1),
  explanation: z.string().min(1),
  metric: z.string(),
  impact: z.string(),
  action: z.string().min(1),
  link: z.enum(['analytics', 'forecast', 'margins', 'menu', 'alerts']),
});

const INSIGHTS_TOOL: Anthropic.Tool = {
  name: 'report_insights',
  description:
    'Report 3–6 prioritized, actionable insights for a restaurant owner based on sales data. ' +
    'Fewer, higher-impact insights are better than many generic ones.',
  input_schema: {
    type: 'object' as const,
    properties: {
      insights: {
        type: 'array',
        minItems: 3,
        maxItems: 6,
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
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description:
                'high = act today (large revenue at stake / urgent); medium = act this week; ' +
                'low = monitor, no action needed yet. Reserve "high" for at most 1–2 insights.',
            },
            title: {
              type: 'string',
              description: 'Short headline, under 10 words. No numbers — that goes in metric.',
            },
            explanation: {
              type: 'string',
              description: 'ONE plain-English sentence: what is happening and why it matters.',
            },
            metric: {
              type: 'string',
              description: 'The specific number(s) or trend cited as evidence, e.g. "$1,440 → $1,108 (-23%)".',
            },
            impact: {
              type: 'string',
              description:
                'Expected business impact in concrete terms, e.g. "~$2,000/week at risk" or "+8% attach rate".',
            },
            action: {
              type: 'string',
              description: 'ONE recommended next action, phrased as an imperative the owner can do.',
            },
            link: {
              type: 'string',
              enum: ['analytics', 'forecast', 'margins', 'menu', 'alerts'],
              description:
                'Where to investigate: "analytics" for trends/peak-hours, "margins" for pricing/cost, ' +
                '"forecast" for demand/staffing, "menu" for item performance, "alerts" for anomalies.',
            },
          },
          required: ['category', 'priority', 'title', 'explanation', 'metric', 'impact', 'action', 'link'],
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

Your task is to identify 3–6 of the MOST VALUABLE insights. Fewer, sharper insights beat a long list \
of equally-weighted observations — a busy owner should be able to read every one between services. \
Prefer distinct categories, but never pad the list to hit a count.

Each insight has SIX fields the owner reads in order. Keep each one short:
- title: the headline, under 10 words, no numbers.
- explanation: ONE sentence — what is happening and why it matters.
- metric: the supporting number(s), e.g. "$1,440 → $1,108 (-23%) over 14 days".
- impact: the expected business impact in concrete terms, e.g. "~$2,000/week at risk".
- action: ONE next step the owner can take, phrased as an imperative.
- priority + link: see below.

Guidelines for high-quality insights:

1. Be specific — cite actual numbers in the metric field. Never say "sales are down"; say \
"BBQ Ribs revenue fell 23% over 14 days ($1,440 → $1,108)."

2. Be actionable — the action field must tell the owner what to DO. \
Bad: "Truffle Fries are popular." Good: "Feature Truffle Fries in this week's social posts."

3. Revenue figures — all monetary data is in cents. Divide by 100 and format with a dollar sign \
(280000 cents → $2,800) wherever you cite money.

4. Prioritize by business impact — assign priority "high" only to the 1–2 insights with the largest \
dollars at stake or true urgency; "medium" for act-this-week items; "low" for monitor-only. \
Order the array most-important first.

5. Trend analysis — compare the most recent 14 days against the prior 14 days where possible, and put \
the percentage change in the metric field.

6. Menu performance — identify top performers worth promoting and underperformers worth cutting, \
repricing, or repositioning. Flag high-margin items that are underselling.

7. Volume patterns — detect days or date ranges with unusually high or low order counts and use them \
to suggest staffing or promotional timing.

8. Anomalies — flag any item whose sales moved more than 20% week-over-week and hypothesize a cause \
(seasonal shift, placement change, out-of-stock) when the pattern is clear.

9. Link — choose where the owner should investigate: "analytics" for trends and peak hours, "margins" \
for pricing and cost questions, "forecast" for demand and staffing, "menu" for item-level performance, \
"alerts" for anomalies that need watching.

10. Data fidelity — do not invent data. Only reference numbers that appear in the data you were given.

You must call the report_insights tool with your findings. Do not output any text outside the tool call.`;

const FALLBACK: InsightsResult = {
  insights: [
    {
      category: 'menu_performance',
      priority: 'low',
      title: 'Not enough data yet',
      explanation:
        'There are fewer than three days of sales on record, so there is not yet enough signal to analyze.',
      metric: 'Fewer than 3 days of daily summaries found.',
      impact: 'Insights unlock once a few days of sales are recorded.',
      action: 'Keep your POS synced for a few more days, then refresh.',
      link: 'menu',
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
        const item = s.menu_items;
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
        // Six insights × six short fields; 1536 leaves headroom over the old
        // 1024 cap so the tool call is never truncated mid-array.
        max_tokens: 1536,
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

    const rawInsights = (toolBlock.input as { insights?: unknown }).insights;
    if (!Array.isArray(rawInsights)) throw new Error('Tool output has no insights array');

    // Validate per-insight and drop the bad ones rather than failing the whole
    // call: one hallucinated enum value shouldn't cost the owner the other five.
    const valid: Insight[] = [];
    for (const item of rawInsights) {
      const parsed = insightSchema.safeParse(item);
      if (parsed.success) {
        valid.push(parsed.data);
      } else {
        console.error('[insights] dropped malformed insight:', parsed.error.issues[0]?.message);
      }
    }
    if (valid.length === 0) throw new Error('No insight in tool output passed schema validation');

    // Defensive re-sort by priority: the prompt asks for most-important-first,
    // but we guarantee the ordering here so the frontend can render top-down
    // without re-deriving it. Stable sort preserves the model's intra-tier order.
    const insights = valid.sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    );

    return { insights };
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
