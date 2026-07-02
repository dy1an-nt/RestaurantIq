/**
 * Persistent AI insights (Sprint U).
 *
 * Before this, GET /api/insights called Anthropic on every page view and stored
 * nothing — no history, no completed/dismissed workflow, no way to measure
 * whether owners act on recommendations, and a paid Claude call per render.
 *
 * This service owns the insight lifecycle, mirroring the alerts engine's
 * proven shape (persist + dedup_key idempotency + post-sync regeneration):
 *
 *   generate ──► upsert by (restaurant_id, dedup_key) ──► expire stale ──► read
 *
 * Identity: dedup_key is computed HERE from structured fields
 * (category | normalized item name), never from model wording, so a reworded
 * title updates the existing row instead of minting a duplicate — and a
 * dismissed insight stays dismissed when the model re-reports the pattern.
 *
 * Cost: generation runs at most once per MIN_GENERATION_INTERVAL (default 6 h)
 * per restaurant, regardless of how often syncs complete or pages load. A
 * manual refresh (POST /api/insights/refresh) bypasses the guard but sits
 * behind the AI rate limiter.
 */
import { supabase } from '../db';
import {
  generateInsights,
  Insight,
  InsightPriority,
  PRIORITY_RANK,
  SummaryRow,
} from './anthropicService';

export type InsightStatus = 'active' | 'completed' | 'dismissed' | 'expired';

// menu_item_name feeds dedup_key at generation time and isn't stored as its
// own column, so the stored shape omits it.
export interface StoredInsight extends Omit<Insight, 'menu_item_name'> {
  id: string;
  status: InsightStatus;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export interface InsightsMeta {
  generatedAt: string;
  periodDays: number;
  rangeStart: string;
  rangeEnd: string;
  daysWithData: number;
  itemsAnalyzed: number;
  ordersAnalyzed: number;
  confidence: 'high' | 'medium' | 'low';
  source: string;
}

export interface GenerationOutcome {
  /** True when generation ran (vs. skipped by the frequency guard / thin data). */
  generated: boolean;
  reason?: 'fresh' | 'insufficient_data' | 'error';
  upserted?: number;
  expired?: number;
}

// ── Config (env-overridable, safe defaults; malformed values fall back) ───────

const minGenerationIntervalMs = (): number => {
  const hours = Number(process.env.INSIGHTS_REFRESH_MIN_HOURS);
  const safe = Number.isFinite(hours) && hours > 0 ? hours : 6;
  return safe * 60 * 60 * 1000;
};

const activeTtlMs = (): number => {
  const days = Number(process.env.INSIGHTS_ACTIVE_TTL_DAYS);
  const safe = Number.isFinite(days) && days > 0 ? days : 7;
  return safe * 24 * 60 * 60 * 1000;
};

// ── Identity ──────────────────────────────────────────────────────────────────

/**
 * Insight identity: category + normalized item reference. Deliberately coarse
 * to start (two menu_performance insights about the same item merge); the
 * UNIQUE constraint makes a wrong choice visible as an update, never a silent
 * duplicate. Computed only from structured fields — title wording must not
 * create a new identity.
 */
export const computeDedupKey = (insight: Insight): string => {
  const item = (insight.menu_item_name ?? 'general')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return `${insight.category}|${item || 'general'}`;
};

// ── Data fetch + meta (moved from routes/insights.ts so the read path and the
//    generation path share one implementation) ───────────────────────────────

export const fetchInsightInputs = async (
  restaurantId: string,
): Promise<{ rows: SummaryRow[]; meta: InsightsMeta }> => {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: summaries, error } = await supabase
    .from('daily_summaries')
    .select(
      'menu_item_id, date, total_quantity, total_revenue_cents, total_orders, menu_items(name, category)',
    )
    .eq('restaurant_id', restaurantId)
    .gte('date', sinceStr)
    .order('date', { ascending: true });

  if (error) throw new Error(`Failed to fetch summaries: ${error.message}`);

  const rows = (summaries ?? []) as unknown as SummaryRow[];

  const distinctDays = new Set(rows.map((r) => r.date)).size;
  const distinctItems = new Set(rows.map((r) => r.menu_item_id).filter(Boolean)).size;
  const ordersAnalyzed = rows.reduce((sum, r) => sum + (r.total_orders ?? 0), 0);
  const confidence: InsightsMeta['confidence'] =
    distinctDays >= 21 ? 'high' : distinctDays >= 10 ? 'medium' : 'low';

  const meta: InsightsMeta = {
    generatedAt: new Date().toISOString(),
    periodDays: 30,
    rangeStart: sinceStr,
    rangeEnd: new Date().toISOString().split('T')[0],
    daysWithData: distinctDays,
    itemsAnalyzed: distinctItems,
    ordersAnalyzed,
    confidence,
    source: 'Square + DoorDash sales',
  };

  return { rows, meta };
};

// ── Generation state ─────────────────────────────────────────────────────────

interface GenerationState {
  last_generated_at: string;
  last_meta: InsightsMeta | Record<string, never>;
}

export const getGenerationState = async (
  restaurantId: string,
): Promise<GenerationState | null> => {
  const { data, error } = await supabase
    .from('insights_generation_state')
    .select('last_generated_at, last_meta')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (error) {
    console.error('[insights] generation state lookup failed:', error.message);
    return null;
  }
  return (data as GenerationState | null) ?? null;
};

const saveGenerationState = async (
  restaurantId: string,
  meta: InsightsMeta,
): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await supabase.from('insights_generation_state').upsert(
    {
      restaurant_id: restaurantId,
      last_generated_at: now,
      last_meta: meta,
      updated_at: now,
    },
    { onConflict: 'restaurant_id' },
  );
  if (error) console.error('[insights] failed to save generation state:', error.message);
};

// ── Generation + persistence ─────────────────────────────────────────────────

interface ExistingRow {
  id: string;
  dedup_key: string;
  status: InsightStatus;
  priority: InsightPriority;
}

const recordEvent = async (
  restaurantId: string,
  insightId: string,
  event: 'completed' | 'dismissed' | 'reactivated' | 'escalated',
): Promise<void> => {
  const { error } = await supabase
    .from('insight_events')
    .insert({ restaurant_id: restaurantId, insight_id: insightId, event });
  if (error) console.error('[insights] failed to record event:', error.message);
};

/**
 * Generate insights and reconcile them into the insights table.
 *
 * Upsert rules per (restaurant_id, dedup_key):
 *  - no row              → INSERT as active.
 *  - active / expired    → UPDATE fields + last_seen_at (fresh numbers win);
 *                          expired rows reactivate (the pattern is back).
 *  - completed/dismissed → touch last_seen_at ONLY. Never resurrect a decision
 *                          the owner made — EXCEPT escalation: a dismissed
 *                          insight whose priority rose (e.g. medium→high)
 *                          reactivates, with an 'escalated' event for audit.
 *
 * Then: active rows the model stopped reporting for ACTIVE_TTL (default 7 d)
 * flip to expired, so the list self-cleans.
 */
export const generateAndPersistInsights = async (
  restaurantId: string,
  opts: { force?: boolean } = {},
): Promise<GenerationOutcome> => {
  const state = await getGenerationState(restaurantId);
  if (!opts.force && state) {
    const age = Date.now() - new Date(state.last_generated_at).getTime();
    if (age < minGenerationIntervalMs()) return { generated: false, reason: 'fresh' };
  }

  const { rows, meta } = await fetchInsightInputs(restaurantId);

  // Under 3 days of data: don't call Claude and don't store placeholder rows.
  // The read path synthesizes the "not enough data yet" fallback. State is
  // still saved so the frequency guard applies and meta is servable.
  if (rows.length < 3) {
    await saveGenerationState(restaurantId, meta);
    return { generated: false, reason: 'insufficient_data' };
  }

  const { insights } = await generateInsights(rows);

  const dedupKeys = insights.map(computeDedupKey);
  const { data: existingRows, error: existErr } = await supabase
    .from('insights')
    .select('id, dedup_key, status, priority')
    .eq('restaurant_id', restaurantId)
    .in('dedup_key', dedupKeys);
  if (existErr) throw new Error(`insights lookup failed: ${existErr.message}`);

  const existingByKey = new Map(
    ((existingRows ?? []) as ExistingRow[]).map((r) => [r.dedup_key, r]),
  );

  const now = new Date().toISOString();
  let upserted = 0;

  for (const insight of insights) {
    const dedupKey = computeDedupKey(insight);
    const existing = existingByKey.get(dedupKey);

    const fields = {
      category: insight.category,
      priority: insight.priority,
      title: insight.title,
      explanation: insight.explanation,
      metric: insight.metric,
      impact: insight.impact,
      action: insight.action,
      link: insight.link,
      last_seen_at: now,
    };

    if (!existing) {
      const { error } = await supabase.from('insights').insert({
        restaurant_id: restaurantId,
        dedup_key: dedupKey,
        ...fields,
        status: 'active',
        first_seen_at: now,
      });
      // A concurrent generation can win the insert race; the UNIQUE constraint
      // turns that into a duplicate-key error we treat as "already handled".
      if (error && error.code !== '23505') {
        console.error('[insights] insert failed:', error.message);
      } else {
        upserted++;
      }
      continue;
    }

    if (existing.status === 'active' || existing.status === 'expired') {
      const { error } = await supabase
        .from('insights')
        .update({ ...fields, status: 'active', resolved_at: null })
        .eq('id', existing.id)
        .eq('restaurant_id', restaurantId);
      if (error) console.error('[insights] update failed:', error.message);
      else upserted++;
      continue;
    }

    // completed / dismissed — respect the owner's decision…
    const escalated =
      existing.status === 'dismissed' &&
      PRIORITY_RANK[insight.priority] < PRIORITY_RANK[existing.priority];

    if (escalated) {
      // …unless the situation got WORSE since they dismissed it.
      const { error } = await supabase
        .from('insights')
        .update({ ...fields, status: 'active', resolved_at: null })
        .eq('id', existing.id)
        .eq('restaurant_id', restaurantId);
      if (error) {
        console.error('[insights] escalation update failed:', error.message);
      } else {
        upserted++;
        await recordEvent(restaurantId, existing.id, 'escalated');
      }
    } else {
      const { error } = await supabase
        .from('insights')
        .update({ last_seen_at: now })
        .eq('id', existing.id)
        .eq('restaurant_id', restaurantId);
      if (error) console.error('[insights] touch failed:', error.message);
    }
  }

  // Expire active insights the model has stopped reporting.
  const cutoff = new Date(Date.now() - activeTtlMs()).toISOString();
  const { data: expiredRows, error: expireErr } = await supabase
    .from('insights')
    .update({ status: 'expired', resolved_at: now })
    .eq('restaurant_id', restaurantId)
    .eq('status', 'active')
    .lt('last_seen_at', cutoff)
    .select('id');
  if (expireErr) console.error('[insights] expiry pass failed:', expireErr.message);

  await saveGenerationState(restaurantId, meta);

  return { generated: true, upserted, expired: (expiredRows ?? []).length };
};

/**
 * Post-sync hook. Fire-and-forget by design: insight generation must never
 * fail (or extend) a sync, mirroring runAlerts. The frequency guard inside
 * generateAndPersistInsights keeps 15-minute sync cadence from meaning
 * 15-minute Claude spend.
 */
export const runInsightsGeneration = (restaurantId: string): void => {
  void generateAndPersistInsights(restaurantId).catch((err) => {
    console.error(
      '[insights] post-sync generation failed:',
      err instanceof Error ? err.message : err,
    );
  });
};

// ── Read path ─────────────────────────────────────────────────────────────────

export const getStoredInsights = async (
  restaurantId: string,
  status: InsightStatus = 'active',
): Promise<StoredInsight[]> => {
  const { data, error } = await supabase
    .from('insights')
    .select(
      'id, category, priority, title, explanation, metric, impact, action, link, status, first_seen_at, last_seen_at, resolved_at',
    )
    .eq('restaurant_id', restaurantId)
    .eq('status', status)
    .order('last_seen_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`insights fetch failed: ${error.message}`);

  // Priority ordering is a server guarantee (same as the pre-persistence
  // contract): high → medium → low, recency within a tier.
  return ((data ?? []) as unknown as StoredInsight[]).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  );
};
