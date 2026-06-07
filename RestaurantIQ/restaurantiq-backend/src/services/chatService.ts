import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { supabase } from '../db';
import { buildChatContext, ChatContextMeta } from './chatDataContextBuilder';
import { CHAT_SYSTEM_PROMPT, ANSWER_QUESTION_TOOL } from './chatPrompt';

interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  context_meta: ChatContextMeta;
  created_at: string;
}

interface SendMessageResult {
  assistantMessage: AssistantMessage;
  usage: { messages_today: number; daily_cap: number };
}

export async function sendMessage(
  restaurantId: string,
  restaurantName: string,
  conversationId: string,
  userContent: string,
): Promise<SendMessageResult> {
  // Load last 8 messages for context (verify conversation belongs to this restaurant)
  const { data: conv, error: convErr } = await supabase
    .from('chat_conversations')
    .select('id, restaurant_id')
    .eq('id', conversationId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (convErr || !conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });

  const { data: history } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(8);

  const recentHistory = (history ?? []).reverse();

  // Build data context
  const { context, meta } = await buildChatContext(restaurantId, restaurantName);

  // Compose Claude messages: history + new user message with data context
  const claudeMessages: Anthropic.MessageParam[] = [
    ...recentHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    {
      role: 'user' as const,
      content: `Restaurant data:\n${JSON.stringify(context, null, 2)}\n\nQuestion: ${userContent}`,
    },
  ];

  const client = new Anthropic();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  let answerText: string;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await client.messages.create(
      {
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: [{ type: 'text', text: CHAT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [ANSWER_QUESTION_TOOL],
        tool_choice: { type: 'tool', name: 'answer_question' },
        messages: claudeMessages,
      },
      { signal: controller.signal },
    );

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolBlock) throw new Error('No tool_use block in response');

    answerText = (toolBlock.input as { answer: string }).answer;
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  } catch (err) {
    if (err instanceof APIError) {
      console.error(`[chat] Anthropic API error ${err.status}:`, err.message);
    } else {
      console.error('[chat] Unexpected error:', err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Persist user message
  await supabase.from('chat_messages').insert({
    conversation_id: conversationId,
    restaurant_id: restaurantId,
    role: 'user',
    content: userContent,
    context_meta: {},
  });

  // Persist assistant message
  const { data: assistantRow, error: insertErr } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversationId,
      restaurant_id: restaurantId,
      role: 'assistant',
      content: answerText,
      context_meta: meta,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    })
    .select('id, role, content, context_meta, created_at')
    .single();

  if (insertErr || !assistantRow) throw new Error('Failed to save assistant message');

  // Update conversation updated_at
  await supabase
    .from('chat_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  // Count today's user messages for usage
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('role', 'user')
    .gte('created_at', midnight.toISOString());

  const daily_cap = parseInt(process.env.CHAT_DAILY_MESSAGE_CAP ?? '50', 10);

  return {
    assistantMessage: assistantRow as AssistantMessage,
    usage: { messages_today: count ?? 0, daily_cap },
  };
}
