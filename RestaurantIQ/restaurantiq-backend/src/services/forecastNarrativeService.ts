import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { ForecastItem } from './forecastService';

export interface ForecastNarrative {
  summary: string;
  callouts: Array<{ title: string; detail: string }>;
}

export interface NarrativeResult {
  narrative: ForecastNarrative;
  inputTokens: number;
  outputTokens: number;
}

const NARRATIVE_TOOL: Anthropic.Tool = {
  name: 'generate_purchasing_narrative',
  description: 'Generate a plain-English purchasing plan for a restaurant owner based on sales forecast data.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: '2-3 paragraph purchasing plan overview. Mention projected revenue, key trends, and top priorities.',
      },
      callouts: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short action headline, under 8 words' },
            detail: { type: 'string', description: '1-2 sentences of specific guidance' },
          },
          required: ['title', 'detail'],
        },
      },
    },
    required: ['summary', 'callouts'],
  },
};

// Intentionally verbose (>1024 tokens) to qualify for prompt caching.
const SYSTEM_PROMPT = `You are a purchasing advisor for a restaurant owner. Your job is to translate \
weekly sales forecast data into a clear, actionable purchasing plan that saves the owner money and \
prevents stockouts.

You will receive a JSON array of forecast items, each containing:
- name: menu item name
- category: item category
- projected_units_next_7d: how many units we expect to sell next week (computed from historical trends)
- actual_units_last_7d: how many units actually sold last week
- projected_revenue_next_7d_cents: projected revenue in cents (divide by 100 for dollars)
- actual_revenue_last_7d_cents: actual revenue last week in cents
- trend_direction: "up", "down", or "flat"
- percent_change: percentage change from last week to next week's projection
- confidence: "high", "medium", or "low" based on available history

Your task is to produce a purchasing narrative with:

1. A summary section (2-3 paragraphs) that:
   - States the total projected revenue for next week in dollars
   - Highlights 2-3 major trends worth paying attention to (biggest movers up or down)
   - Gives an overall read on inventory risk (e.g., "you're entering a high-demand week for proteins")
   - Is written for a busy restaurant owner reading on their phone — concise and direct

2. A callouts section (3-5 items) that:
   - Each has a short action title ("Stock up on chicken", "Cut back on Garden Salad orders")
   - Each has 1-2 sentences of specific guidance citing actual projected numbers
   - Covers both upsides (stock up) and downsides (reduce orders to avoid waste)
   - Prioritizes the callouts by financial impact — biggest dollar opportunities first

Rules:
- Always convert cents to dollars in your text (e.g., 150000 cents → $1,500)
- Cite specific projected unit counts and revenue figures
- Do not invent information beyond what's in the data
- Be direct — owners need actionable guidance, not general restaurant business advice
- Flag any "low confidence" items as uncertain: "...though this projection is based on limited history"
- If trend_direction is "flat" for most items, say so — a stable week is useful information

You must call the generate_purchasing_narrative tool with your response.`;

export async function generateForecastNarrative(items: ForecastItem[]): Promise<NarrativeResult> {
  const client = new Anthropic();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const userMessage = JSON.stringify(
      items.map((item) => ({
        name: item.name,
        category: item.category,
        projected_units_next_7d: item.projected_units_next_7d,
        actual_units_last_7d: item.actual_units_last_7d,
        projected_revenue_next_7d_cents: item.projected_revenue_next_7d_cents,
        actual_revenue_last_7d_cents: item.actual_revenue_last_7d_cents,
        trend_direction: item.trend_direction,
        percent_change: item.percent_change,
        confidence: item.confidence,
      })),
      null,
      2,
    );

    const response = await client.messages.create(
      {
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [NARRATIVE_TOOL],
        tool_choice: { type: 'tool', name: 'generate_purchasing_narrative' },
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal },
    );

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolBlock) throw new Error('No tool_use block in response');

    return {
      narrative: toolBlock.input as ForecastNarrative,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (err) {
    if (err instanceof APIError) {
      console.error(`[forecast-narrative] Anthropic API error ${err.status}:`, err.message);
    } else {
      console.error('[forecast-narrative] Unexpected error:', err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
