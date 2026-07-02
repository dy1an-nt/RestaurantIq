import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { requireRestaurant } from '../middleware/requireRestaurant';
import { validateBody } from '../middleware/validate';
import { createAiRateLimiter } from '../middleware/rateLimit';
import { FALLBACK } from '../services/anthropicService';
import {
  generateAndPersistInsights,
  getGenerationState,
  getStoredInsights,
  InsightStatus,
  InsightsMeta,
} from '../services/insightsService';

const router = Router();
router.use(authMiddleware);
router.use(requireRestaurant());

// Only the endpoints that can trigger a Claude call sit behind the AI rate
// limiter. GET is a table read since Sprint U — limiting it would throttle
// plain page loads for no cost benefit.
const aiLimiter = createAiRateLimiter();

const patchInsightSchema = z.object({
  status: z.enum(['active', 'completed', 'dismissed']),
});

const listQuerySchema = z.enum(['active', 'completed', 'dismissed', 'expired']);

/**
 * GET /api/insights[?status=active|completed|dismissed|expired]
 *
 * Reads persisted insights (Sprint U) — no Claude call, so p95 is a DB lookup
 * instead of a 25 s model round-trip. `meta` is the stored explainability
 * block from the last generation. Lazy backfill: a restaurant that has never
 * generated (fresh deploy, new signup) generates once inline so the first
 * page view isn't empty.
 */
router.get('/', async (req: Request, res: Response) => {
  const rawStatus = req.query.status;
  let status: InsightStatus = 'active';
  if (rawStatus !== undefined) {
    const parsed = listQuerySchema.safeParse(rawStatus);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ data: null, error: 'status must be one of active, completed, dismissed, expired' });
    }
    status = parsed.data;
  }

  try {
    let state = await getGenerationState(req.restaurantId!);
    if (!state) {
      // First read ever for this restaurant — generate now (frequency guard
      // doesn't apply to a restaurant with no state). Failures degrade to an
      // empty list rather than a 5xx; the next sync retries generation.
      try {
        await generateAndPersistInsights(req.restaurantId!, { force: true });
      } catch (err) {
        console.error(
          '[insights] lazy first generation failed:',
          err instanceof Error ? err.message : err,
        );
      }
      state = await getGenerationState(req.restaurantId!);
    }

    const insights = await getStoredInsights(req.restaurantId!, status);
    const meta = (state?.last_meta ?? null) as InsightsMeta | null;

    // Thin-data empty state: preserve the pre-persistence contract of always
    // returning at least the "not enough data yet" insight (not persisted).
    if (status === 'active' && insights.length === 0 && (meta?.daysWithData ?? 0) < 3) {
      return res.json({ data: { insights: FALLBACK.insights, meta }, error: null });
    }

    return res.json({ data: { insights, meta }, error: null });
  } catch (err) {
    console.error('[insights] read failed:', err instanceof Error ? err.message : err);
    return res.status(500).json({ data: null, error: 'Failed to load insights' });
  }
});

/**
 * POST /api/insights/refresh
 *
 * On-demand regeneration. Bypasses the 6-hour frequency guard (force) but pays
 * the AI rate limit — this is the only user-triggerable Claude call on this
 * router. Returns the fresh active list so the UI can swap in one round trip.
 */
router.post('/refresh', aiLimiter, async (req: Request, res: Response) => {
  try {
    const outcome = await generateAndPersistInsights(req.restaurantId!, { force: true });
    const insights = await getStoredInsights(req.restaurantId!, 'active');
    const state = await getGenerationState(req.restaurantId!);
    return res.json({
      data: {
        insights: insights.length === 0 && outcome.reason === 'insufficient_data'
          ? FALLBACK.insights
          : insights,
        meta: (state?.last_meta ?? null) as InsightsMeta | null,
        refreshed: outcome.generated,
      },
      error: null,
    });
  } catch (err) {
    console.error('[insights] refresh failed:', err instanceof Error ? err.message : err);
    return res
      .status(502)
      .json({ data: null, error: 'AI insights unavailable — try again shortly' });
  }
});

/**
 * PATCH /api/insights/:id
 * Body: { status: "completed" | "dismissed" | "active" }
 *
 * The owner's workflow action — and the product-analytics signal. Tenant
 * scoping lives in the UPDATE itself (single statement, 404 when the row isn't
 * theirs — no cross-tenant existence oracle). Every transition is appended to
 * insight_events.
 */
router.patch(
  '/:id',
  validateBody(patchInsightSchema),
  async (req: Request, res: Response) => {
    const { status } = req.body as z.infer<typeof patchInsightSchema>;
    const now = new Date().toISOString();

    const { data: updated, error } = await supabase
      .from('insights')
      .update({
        status,
        resolved_at: status === 'active' ? null : now,
      })
      .eq('id', req.params.id)
      .eq('restaurant_id', req.restaurantId!)
      .select('id, status, priority, title, resolved_at')
      .maybeSingle();

    if (error) {
      // 22P02 = invalid uuid syntax — a malformed :id is a 404, not a 500.
      if ((error as { code?: string }).code === '22P02') {
        return res.status(404).json({ data: null, error: 'Insight not found' });
      }
      console.error('[insights] status update failed:', error.message);
      return res.status(500).json({ data: null, error: 'Failed to update insight' });
    }
    if (!updated) {
      return res.status(404).json({ data: null, error: 'Insight not found' });
    }

    const event =
      status === 'active' ? 'reactivated' : (status as 'completed' | 'dismissed');
    const { error: evErr } = await supabase.from('insight_events').insert({
      restaurant_id: req.restaurantId!,
      insight_id: updated.id,
      event,
    });
    if (evErr) console.error('[insights] event insert failed:', evErr.message);

    return res.json({ data: updated, error: null });
  },
);

export default router;
