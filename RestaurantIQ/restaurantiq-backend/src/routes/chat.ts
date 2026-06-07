import { Router, Request, Response } from 'express';
import { JWTPayload } from 'jose';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { createAiRateLimiter } from '../middleware/rateLimit';
import { chatDailyCap } from '../middleware/chatDailyCap';
import { sendMessage } from '../services/chatService';

interface AuthRequest extends Request {
  user?: JWTPayload;
}

const router = Router();
router.use(authMiddleware);

async function getRestaurant(userId: string) {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, name')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data as { id: string; name: string };
}

// GET /api/chat/usage  — must come before /:id to avoid route shadowing
router.get('/usage', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurant(userId);
  if (!restaurant) return res.status(404).json({ data: null, error: 'Restaurant not found' });

  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const nextMidnight = new Date(midnight);
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);

  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurant.id)
    .eq('role', 'user')
    .gte('created_at', midnight.toISOString());

  const daily_cap = parseInt(process.env.CHAT_DAILY_MESSAGE_CAP ?? '50', 10);

  return res.json({
    data: {
      messages_today: count ?? 0,
      daily_cap,
      resets_at: nextMidnight.toISOString(),
    },
    error: null,
  });
});

// GET /api/chat/conversations
router.get('/conversations', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurant(userId);
  if (!restaurant) return res.status(404).json({ data: null, error: 'Restaurant not found' });

  const { data: conversations, error } = await supabase
    .from('chat_conversations')
    .select('id, title, created_at, updated_at')
    .eq('restaurant_id', restaurant.id)
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
router.post('/conversations', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurant(userId);
  if (!restaurant) return res.status(404).json({ data: null, error: 'Restaurant not found' });

  const title = req.body.title ?? 'New conversation';
  if (typeof title !== 'string' || title.length > 120) {
    return res.status(400).json({ data: null, error: 'Title must be a string under 120 characters' });
  }

  const { data: conversation, error } = await supabase
    .from('chat_conversations')
    .insert({ restaurant_id: restaurant.id, title: title.trim() || 'New conversation' })
    .select('id, title, created_at, updated_at')
    .single();

  if (error || !conversation) {
    return res.status(500).json({ data: null, error: 'Failed to create conversation' });
  }

  return res.json({ data: { conversation }, error: null });
});

// GET /api/chat/conversations/:id/messages
router.get('/conversations/:id/messages', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurant(userId);
  if (!restaurant) return res.status(404).json({ data: null, error: 'Restaurant not found' });

  const { data: conversation, error: convErr } = await supabase
    .from('chat_conversations')
    .select('id, title, created_at, updated_at')
    .eq('id', req.params.id)
    .eq('restaurant_id', restaurant.id)
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
  async (req: AuthRequest, res: Response) => {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

    const restaurant = await getRestaurant(userId);
    if (!restaurant) return res.status(404).json({ data: null, error: 'Restaurant not found' });

    const { content } = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ data: null, error: 'content is required' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ data: null, error: 'content must be 2000 characters or fewer' });
    }

    try {
      const { assistantMessage, usage } = await sendMessage(
        restaurant.id,
        restaurant.name,
        req.params.id,
        content.trim(),
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
router.patch('/conversations/:id', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurant(userId);
  if (!restaurant) return res.status(404).json({ data: null, error: 'Restaurant not found' });

  const { title } = req.body;
  if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 120) {
    return res.status(400).json({ data: null, error: 'title must be 1-120 characters' });
  }

  const { data: conversation, error } = await supabase
    .from('chat_conversations')
    .update({ title: title.trim(), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('restaurant_id', restaurant.id)
    .select('id, title, created_at, updated_at')
    .maybeSingle();

  if (error || !conversation) {
    return res.status(404).json({ data: null, error: 'Conversation not found' });
  }

  return res.json({ data: { conversation }, error: null });
});

// DELETE /api/chat/conversations/:id
router.delete('/conversations/:id', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ data: null, error: 'Unauthorized' });

  const restaurant = await getRestaurant(userId);
  if (!restaurant) return res.status(404).json({ data: null, error: 'Restaurant not found' });

  const { error } = await supabase
    .from('chat_conversations')
    .delete()
    .eq('id', req.params.id)
    .eq('restaurant_id', restaurant.id);

  if (error) return res.status(404).json({ data: null, error: 'Conversation not found' });

  return res.json({ data: { deleted: true }, error: null });
});

export default router;
