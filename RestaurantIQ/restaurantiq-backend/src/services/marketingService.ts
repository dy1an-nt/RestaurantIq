import Anthropic, { APIError } from '@anthropic-ai/sdk';

export interface MarketingResult {
  captions: string[];
  hashtags: string[];
  promoIdeas: Array<{ title: string; description: string }>;
}

function getAnthropicClient(): Anthropic {
  return new Anthropic();
}

const MARKETING_TOOL: Anthropic.Tool = {
  name: 'generate_marketing_copy',
  description:
    'Generate social media captions, hashtags, and promo ideas for a restaurant menu item.',
  input_schema: {
    type: 'object' as const,
    properties: {
      captions: {
        type: 'array',
        minItems: 3,
        maxItems: 5,
        items: { type: 'string' },
        description: 'Platform-appropriate social captions',
      },
      hashtags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relevant hashtags without the # symbol',
      },
      promoIdeas: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['title', 'description'],
        },
      },
    },
    required: ['captions', 'hashtags', 'promoIdeas'],
  },
};

const SYSTEM_PROMPT = `You are a social media copywriter for independent restaurant owners. \
Your job is to generate ready-to-post marketing content grounded in real menu item data.

Rules:
- Write content that sounds natural, platform-specific, and on-brand — not generic AI copy.
- Never use tired phrases like "Indulge in...", "Savor the...", or "Treat yourself to...".
- Captions must be ready to post as-is, not templates with [PLACEHOLDER] blanks.
- Match the exact tone and platform provided in the user message — a TikTok caption sounds nothing like a Facebook post.
- Promo ideas must be concrete and executable: specify a discount amount, bundle pairing, day of week, or time window. Never say "run a promotion" without specifying exactly what it is.
- Hashtags should be a mix of broad reach (#foodie) and niche/local tags relevant to the item's category and tone.
- If performance data shows the item is trending up, write with momentum. If trending down, lean into urgency or a relaunch angle.
- Keep captions concise for Twitter/TikTok, longer and storytelling-oriented for Facebook/general.

You must call the generate_marketing_copy tool with your output. Do not output any text outside the tool call.`;

export async function generateMarketingCopy(params: {
  item: { name: string; category: string; price_cents: number };
  tone: string;
  platform: string;
  summaries: Array<{
    date: string;
    total_quantity: number;
    total_revenue_cents: number;
    total_orders: number;
  }>;
  alerts: Array<{ type: string; severity: string; title: string; message: string }>;
}): Promise<MarketingResult> {
  const { item, tone, platform, summaries, alerts } = params;

  // Aggregate totals and compute trend from first half vs second half of the window.
  const totalOrders = summaries.reduce((sum, s) => sum + s.total_orders, 0);
  const totalRevenueCents = summaries.reduce((sum, s) => sum + s.total_revenue_cents, 0);

  let trend = 'flat';
  if (summaries.length >= 2) {
    const mid = Math.floor(summaries.length / 2);
    const firstHalf = summaries.slice(0, mid).reduce((sum, s) => sum + s.total_revenue_cents, 0);
    const secondHalf = summaries.slice(mid).reduce((sum, s) => sum + s.total_revenue_cents, 0);
    if (secondHalf > firstHalf * 1.05) trend = 'trending up';
    else if (secondHalf < firstHalf * 0.95) trend = 'trending down';
  }

  const priceInDollars = (item.price_cents / 100).toFixed(2);
  const revenueInDollars = (totalRevenueCents / 100).toFixed(2);

  const alertLines =
    alerts.length > 0
      ? alerts.map((a) => `- ${a.title}: ${a.message}`).join('\n')
      : '- None';

  const userMessage = `Item: ${item.name} (${item.category})
Price: $${priceInDollars}
Tone: ${tone}
Platform: ${platform}

Performance (last 30 days):
- Total orders: ${totalOrders}
- Total revenue: $${revenueInDollars}
- Sales trend: ${trend}

Recent alerts:
${alertLines}`;

  const client = getAnthropicClient();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
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
        tools: [MARKETING_TOOL],
        tool_choice: { type: 'tool', name: 'generate_marketing_copy' },
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal },
    );

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolBlock) throw new Error('No tool_use block in response');

    return toolBlock.input as MarketingResult;
  } catch (err) {
    if (err instanceof APIError) {
      console.error(`[marketing] Anthropic API error ${err.status}:`, err.message);
    } else {
      console.error('[marketing] Unexpected error:', err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
