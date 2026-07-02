import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { requireRestaurant } from '../middleware/requireRestaurant';
import { validateBody } from '../middleware/validate';
import { createAiRateLimiter } from '../middleware/rateLimit';
import { chatDailyCap, getChatUsage } from '../middleware/chatDailyCap';
import { sendMessage } from '../services/chatService';

const router = Router();
router.use(authMiddleware);
// Resolve the caller's restaurant (id + name; name is used in the chat prompt)
// once for every route below.
router.use(requireRestaurant('id, name'));

// New conversations default their title when omitted; an explicit title is a
// string of at most 120 chars.
const createConversationSchema = z.object({
  title: z.string().max(120, 'Title must be a string under 120 characters').optional(),
});

// Renaming a conversation requires a non-empty title (after trimming) ≤120 chars.
const renameConversationSchema = z.object({
  title: z.string().trim().min(1, 'title must be 1-120 characters').max(120, 'title must be 1-120 characters'),
});

// A chat message is a non-empty (after trimming), ≤2000-char string. The handler
// receives the already-trimmed value.
const sendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'content is required')
    .max(2000, 'content must be 2000 characters or fewer'),
});

// GET /api/chat/usage  — must come before /:id to avoid route shadowing.
// Reads the same numbers chatDailyCap enforces, so display and enforcement
// can't drift.
router.get('/usage', async (req: Request, res: Response) => {
  const usage = await getChatUsage(req.restaurantId!);

  return res.json({
    data: {
      messages_today: usage.messagesToday,
      daily_cap: usage.dailyCap,
      resets_at: usage.resetsAt,
    },
    error: null,
  });
});

// GET /api/chat/conversations
router.get('/conversations', async (req: Request, res: Response) => {
  const { data: conversations, error } = await supabase
    .from('chat_conversations')
    .select('id, title, created_at, updated_at')
    .eq('restaurant_id', req.restaurantId!)
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ data: null, error: 'Failed to fetch conversations' });

  // Get message counts
  const ids = (conversations ?? []).map((c) => c.id);
  const countMap = new Map<string, number>();
  if (ids.length > 0) {
    const { data: counts } = await supabase
      .from('chat_messages')
      .select('conversation_id')
      .in('conversation_id', ids);
    for (const row of counts ?? []) {
      countMap.set(row.conversation_id, (countMap.get(row.conversation_id) ?? 0) + 1);
    }
  }

  return res.json({
    data: {
      conversations: (conversations ?? []).map((c) => ({
        ...c,
        message_count: countMap.get(c.id) ?? 0,
      })),
    },
    error: null,
  });
});

// POST /api/chat/conversations
router.post(
  '/conversations',
  validateBody(createConversationSchema),
  async (req: Request, res: Response) => {
  const title = req.body.title ?? 'New conversation';

  const { data: conversation, error } = await supabase
    .from('chat_conversations')
    .insert({ restaurant_id: req.restaurantId!, title: title.trim() || 'New conversation' })
    .select('id, title, created_at, updated_at')
    .single();

  if (error || !conversation) {
    return res.status(500).json({ data: null, error: 'Failed to create conversation' });
  }

  return res.json({ data: { conversation }, error: null });
  },
);

// GET /api/chat/conversations/:id/messages
router.get('/conversations/:id/messages', async (req: Request, res: Response) => {
  const { data: conversation, error: convErr } = await supabase
    .from('chat_conversations')
    .select('id, title, created_at, updated_at')
    .eq('id', req.params.id)
    .eq('restaurant_id', req.restaurantId!)
    .maybeSingle();

  if (convErr || !conversation) {
    return res.status(404).json({ data: null, error: 'Conversation not found' });
  }

  const { data: messages, error: msgErr } = await supabase
    .from('chat_messages')
    .select('id, role, content, context_meta, created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: true });

  if (msgErr) return res.status(500).json({ data: null, error: 'Failed to fetch messages' });

  return res.json({ data: { conversation, messages: messages ?? [] }, error: null });
});

// POST /api/chat/conversations/:id/messages
router.post(
  '/conversations/:id/messages',
  createAiRateLimiter(),
  chatDailyCap,
  validateBody(sendMessageSchema),
  async (req: Request, res: Response) => {
    const { content } = req.body as z.infer<typeof sendMessageSchema>;

    try {
      const { assistantMessage, usage } = await sendMessage(
        req.restaurantId!,
        req.restaurant!.name as string,
        req.params.id,
        content,
      );
      return res.json({ data: { message: assistantMessage, usage }, error: null });
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException & { status?: number }).status === 404) {
        return res.status(404).json({ data: null, error: 'Conversation not found' });
      }
      console.error('[chat] sendMessage failed:', err);
      return res.status(502).json({ data: null, error: 'AI chat unavailable — try again shortly' });
    }
  },
);

// PATCH /api/chat/conversations/:id
router.patch(
  '/conversations/:id',
  validateBody(renameConversationSchema),
  async (req: Request, res: Response) => {
  const { title } = req.body as z.infer<typeof renameConversationSchema>;

  const { data: conversation, error } = await supabase
    .from('chat_conversations')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('restaurant_id', req.restaurantId!)
    .select('id, title, created_at, updated_at')
    .maybeSingle();

  if (error || !conversation) {
    return res.status(404).json({ data: null, error: 'Conversation not found' });
  }

  return res.json({ data: { conversation }, error: null });
  },
);

// DELETE /api/chat/conversations/:id
router.delete('/conversations/:id', async (req: Request, res: Response) => {
  // .select() makes the delete return the removed rows, so a wrong-tenant or
  // nonexistent id is a 404 instead of a false-success 200 (zero rows matched
  // is not an error to PostgREST).
  const { data: deleted, error } = await supabase
    .from('chat_conversations')
    .delete()
    .eq('id', req.params.id)
    .eq('restaurant_id', req.restaurantId!)
    .select('id');

  if (error || !deleted || deleted.length === 0) {
    return res.status(404).json({ data: null, error: 'Conversation not found' });
  }

  return res.json({ data: { deleted: true }, error: null });
});

export default router;
