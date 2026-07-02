import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useAuth } from './auth/AuthContext';
import { useRestaurant } from './restaurant/RestaurantContext';
import Icon from './Icons';

// ─── Types ────────────────────────────────────────────────────────────────────

type InsightCategory =
  | 'staffing'
  | 'peak_hours'
  | 'slow_days'
  | 'sales_anomaly'
  | 'menu_performance'
  | 'operational'
  | 'customer_behavior';

type Priority = 'high' | 'medium' | 'low';
type InsightLink = 'analytics' | 'forecast' | 'margins' | 'menu' | 'alerts';
type InsightStatus = 'active' | 'completed' | 'dismissed';

interface Insight {
  // Persisted insights (Sprint U) carry an id + lifecycle fields; the
  // non-persisted "not enough data yet" fallback does not, so all are optional
  // and cards without an id simply don't get workflow buttons.
  id?: string;
  category: InsightCategory;
  priority: Priority;
  title: string;
  explanation: string;
  metric: string;
  impact: string;
  action: string;
  link: InsightLink;
  status?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  resolved_at?: string | null;
}

interface InsightsMeta {
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

interface InsightsResult {
  insights: Insight[];
  meta?: InsightsMeta | null;
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty'; meta?: InsightsMeta | null }
  | { status: 'data'; insights: Insight[]; meta?: InsightsMeta | null };

// ─── Priority config ──────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

const PRIORITY_CONFIG: Record<Priority, { label: string; chip: string; border: string; cardBg: string }> = {
  high:   { label: 'High priority',   chip: 'bg-red-50 text-red-600 border border-red-200',       border: 'border-red-400',    cardBg: 'bg-red-50/40' },
  medium: { label: 'Medium priority', chip: 'bg-warn-bg text-warn border border-warn/30',          border: 'border-amber-400',  cardBg: 'bg-white' },
  low:    { label: 'Low priority',    chip: 'bg-navy-50 text-navy-700 border border-navy-100',     border: 'border-navy-200',   cardBg: 'bg-white' },
};

// ─── Link config ──────────────────────────────────────────────────────────────
// Each insight points at exactly one real route so the owner can investigate it
// in one click (Sprint T3). Keep the enum in sync with the backend InsightLink.

const LINK_CONFIG: Record<InsightLink, { label: string; to: string }> = {
  analytics: { label: 'See Analytics',         to: '/analytics' },
  forecast:  { label: 'Open Forecast',         to: '/advisor' },
  margins:   { label: 'Review Margins',        to: '/margins' },
  menu:      { label: 'View Menu Performance', to: '/' },
  alerts:    { label: 'View Alerts',           to: '/alerts' },
};

function getLinkConfig(link: string): { label: string; to: string } {
  return LINK_CONFIG[link as InsightLink] ?? LINK_CONFIG.menu;
}

// ─── Category config ──────────────────────────────────────────────────────────

interface CategoryConfig {
  label: string;
  icon: React.ReactNode;
}

const CATEGORY_CONFIG: Record<InsightCategory, CategoryConfig> = {
  staffing:          { label: 'Staffing',         icon: <Icon name="store"     size={14} /> },
  peak_hours:        { label: 'Peak Hours',        icon: <Icon name="analytics" size={14} /> },
  slow_days:         { label: 'Slow Days',         icon: <Icon name="arrowDown" size={14} /> },
  sales_anomaly:     { label: 'Sales Anomaly',     icon: <Icon name="attention" size={14} /> },
  menu_performance:  { label: 'Menu Performance',  icon: <Icon name="star"      size={14} /> },
  operational:       { label: 'Operational',       icon: <Icon name="sync"      size={14} /> },
  customer_behavior: { label: 'Customer Behavior', icon: <Icon name="insights"  size={14} /> },
};

const FALLBACK_CATEGORY: CategoryConfig = { label: 'General', icon: <Icon name="dot" size={14} /> };

function getCategoryConfig(category: string): CategoryConfig {
  return CATEGORY_CONFIG[category as InsightCategory] ?? FALLBACK_CATEGORY;
}

// ─── Status tabs (Sprint U Phase 2) ───────────────────────────────────────────

const STATUS_TABS: { key: InsightStatus; label: string }[] = [
  { key: 'active',    label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'dismissed', label: 'Dismissed' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Validate + normalise the raw insights array from any of the API responses. */
function parseInsights(raw: unknown): Insight[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Insight =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.category === 'string' &&
        typeof item.title === 'string' && item.title.length > 0 &&
        typeof item.explanation === 'string' && item.explanation.length > 0 &&
        typeof item.metric === 'string' &&
        typeof item.action === 'string' && item.action.length > 0,
    )
    // Normalise optional fields so older/partial payloads still render.
    .map((i) => ({
      ...i,
      priority: (['high', 'medium', 'low'] as Priority[]).includes(i.priority) ? i.priority : 'medium',
      impact: i.impact ?? '',
      link: (i.link in LINK_CONFIG ? i.link : 'menu') as InsightLink,
    }))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

const SkeletonCard = () => (
  <div className="bg-white rounded-xl border border-line p-5 space-y-4 animate-pulse">
    <div className="flex gap-2">
      <div className="h-5 w-28 bg-gray-100 rounded-full" />
      <div className="h-5 w-24 bg-gray-100 rounded-full" />
    </div>
    <div className="h-5 w-3/4 bg-gray-200 rounded" />
    <div className="space-y-2 pt-1">
      <div className="h-3 w-20 bg-gray-100 rounded" />
      <div className="h-4 w-full bg-gray-100 rounded" />
      <div className="h-4 w-5/6 bg-gray-100 rounded" />
    </div>
    <div className="h-9 w-40 bg-gray-100 rounded-lg" />
  </div>
);

// ─── Explainability bar (Sprint T4) ─────────────────────────────────────────────

const CONFIDENCE_CHIP: Record<InsightsMeta['confidence'], string> = {
  high:   'bg-green-50 text-green-700 border border-green-200',
  medium: 'bg-warn-bg text-warn border border-warn/30',
  low:    'bg-navy-50 text-navy-700 border border-navy-100',
};

const ExplainabilityBar = ({ meta }: { meta: InsightsMeta }) => {
  const facts = [
    `${meta.source}`,
    `${meta.daysWithData} day${meta.daysWithData === 1 ? '' : 's'} of data`,
    `${meta.ordersAnalyzed.toLocaleString('en-US')} orders`,
    `${meta.itemsAnalyzed} item${meta.itemsAnalyzed === 1 ? '' : 's'}`,
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-ink-3">
      <span className="font-semibold text-ink-2">Analyzed:</span>
      {facts.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span className="text-line">·</span>}
          {f}
        </span>
      ))}
      <span className={`ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold ${CONFIDENCE_CHIP[meta.confidence]}`}>
        {meta.confidence} confidence
      </span>
      <span className="ml-auto text-ink-3">
        Generated {formatGeneratedAt(meta.generatedAt)}
      </span>
    </div>
  );
};

// ─── Executive Summary ──────────────────────────────────────────────────────────

const ExecutiveSummary = ({ insights }: { insights: Insight[] }) => {
  const highCount = insights.filter((i) => i.priority === 'high').length;
  const mediumCount = insights.filter((i) => i.priority === 'medium').length;
  const top = insights[0];

  return (
    <div className="bg-navy-700 text-white rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-[13px] font-bold uppercase tracking-[0.08em] text-white/60">
          What to do next
        </h2>
        <div className="flex gap-2">
          {highCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 text-[11.5px] font-bold border border-red-400/40">
              {highCount} high priority
            </span>
          )}
          {mediumCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 text-[11.5px] font-bold border border-amber-400/40">
              {mediumCount} this week
            </span>
          )}
        </div>
      </div>

      {top && (
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">
            Top priority
          </p>
          <p className="text-[15px] font-bold text-white leading-snug">{top.title}</p>
          <p className="text-[13px] text-white/80 leading-snug">{top.action}</p>
          <Link
            to={getLinkConfig(top.link).to}
            className="inline-flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-lg bg-white text-navy-700 text-[12.5px] font-bold hover:bg-white/90 transition-colors"
          >
            {getLinkConfig(top.link).label}
            <Icon name="chevron" size={14} className="-rotate-90" />
          </Link>
        </div>
      )}
    </div>
  );
};

// ─── Insight Card ────────────────────────────────────────────────────────────────

interface InsightCardProps {
  insight: Insight;
  rank: number;
  tab: InsightStatus;
  isNew: boolean;
  pending: boolean;
  onSetStatus: (next: InsightStatus) => void;
}

const InsightCard = ({ insight, rank, tab, isNew, pending, onSetStatus }: InsightCardProps) => {
  const priorityCfg = PRIORITY_CONFIG[insight.priority] ?? PRIORITY_CONFIG.medium;
  const categoryCfg = getCategoryConfig(insight.category);
  const linkCfg = getLinkConfig(insight.link);

  return (
    <div className={`${priorityCfg.cardBg} rounded-xl border-l-4 ${priorityCfg.border} border border-line flex flex-col`}>
      {/* Card header — priority + new-since-last-visit + category */}
      <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-bold ${priorityCfg.chip}`}>
            {priorityCfg.label}
          </span>
          {isNew && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-bold bg-green-50 text-green-700 border border-green-200">
              New
            </span>
          )}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold bg-canvas text-ink-2 border border-line">
          {categoryCfg.icon}
          {categoryCfg.label}
        </span>
      </div>

      {/* Title + one-sentence explanation */}
      <div className="px-5 pb-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-[11px] font-bold text-ink-3 bg-canvas border border-line rounded px-1.5 py-0.5 flex-shrink-0">
            #{rank}
          </span>
          <h3 className="text-[15px] font-bold text-ink leading-snug">{insight.title}</h3>
        </div>
        <p className="text-[13px] text-ink-2 leading-snug mt-2">{insight.explanation}</p>
      </div>

      {/* Supporting numbers */}
      <div className="mx-5 mb-3 bg-canvas rounded-lg px-4 py-3 space-y-1">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-3">
          Supporting numbers
        </p>
        <p className="text-[13px] font-semibold text-ink leading-snug tnum">{insight.metric}</p>
      </div>

      {/* Expected impact */}
      <div className="mx-5 mb-3 flex items-baseline gap-2">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-3 flex-shrink-0">
          Impact
        </p>
        <p className="text-[13px] font-semibold text-navy-700 leading-snug">{insight.impact}</p>
      </div>

      {/* Recommended action + investigate link */}
      <div className="mt-auto mx-5 mb-4 border-l-2 border-navy-700 pl-3 space-y-2">
        <div className="space-y-1">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-navy-700">
            Recommended action
          </p>
          <p className="text-[13px] text-ink leading-snug">{insight.action}</p>
        </div>
        <Link
          to={linkCfg.to}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface text-[12.5px] font-bold text-navy-700 hover:bg-navy-50 transition-colors"
        >
          {linkCfg.label}
          <Icon name="chevron" size={14} className="-rotate-90" />
        </Link>
      </div>

      {/* Workflow actions (Sprint U Phase 2) — persisted insights only */}
      {insight.id && (
        <div className="border-t border-line px-5 py-3 flex items-center gap-2">
          {tab === 'active' ? (
            <>
              <button
                onClick={() => onSetStatus('completed')}
                disabled={pending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface text-[12px] font-bold text-green-700 hover:bg-green-50 transition-colors disabled:opacity-60"
              >
                <Icon name="check" size={14} />
                Mark done
              </button>
              <button
                onClick={() => onSetStatus('dismissed')}
                disabled={pending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface text-[12px] font-bold text-ink-3 hover:bg-canvas transition-colors disabled:opacity-60"
              >
                <Icon name="close" size={14} />
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span className="text-[11.5px] font-medium text-ink-3">
                {tab === 'completed' ? 'Completed' : 'Dismissed'}
                {insight.resolved_at ? ` ${formatGeneratedAt(insight.resolved_at)}` : ''}
              </span>
              <button
                onClick={() => onSetStatus('active')}
                disabled={pending}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface text-[12px] font-bold text-navy-700 hover:bg-navy-50 transition-colors disabled:opacity-60"
              >
                <Icon name="undo" size={14} />
                Reactivate
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const InsightsPanel = () => {
  const { session } = useAuth();
  const { restaurant } = useRestaurant();
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'idle' });
  const [tab, setTab] = useState<InsightStatus>('active');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // ISO timestamp of the PREVIOUS visit to this panel — insights first seen
  // after it get the "New" badge. null on the very first visit (badging every
  // card would be noise, so nothing is marked).
  const [newSince, setNewSince] = useState<string | null>(null);

  useEffect(() => {
    if (!restaurant?.id) return;
    const key = `riq:insights-last-visit:${restaurant.id}`;
    setNewSince(localStorage.getItem(key));
    localStorage.setItem(key, new Date().toISOString());
  }, [restaurant?.id]);

  const load = useCallback((status: InsightStatus) => {
    if (!session) {
      setFetchState({ status: 'error', message: 'Not authenticated. Please sign in again.' });
      return;
    }

    const controller = new AbortController();
    setFetchState({ status: 'loading' });
    setActionError(null);

    (async () => {
      try {
        const res = await apiFetch(`/api/insights?status=${status}`, { signal: controller.signal });
        const body: { data: InsightsResult | null; error: string | null } = await res.json();

        if (!res.ok || body.error) {
          setFetchState({ status: 'error', message: body.error ?? `Request failed (${res.status})` });
          return;
        }

        const valid = parseInsights(body.data?.insights);
        setFetchState(
          valid.length === 0
            ? { status: 'empty', meta: body.data?.meta }
            : { status: 'data', insights: valid, meta: body.data?.meta },
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setFetchState({
          status: 'error',
          message: err instanceof Error ? err.message : 'An unexpected error occurred.',
        });
      }
    })();

    return () => controller.abort();
  }, [session]);

  useEffect(() => {
    const cleanup = load(tab);
    return cleanup;
  }, [load, tab]);

  // On-demand regeneration (Sprint U): POST /refresh is the only call here that
  // spends Claude money — a plain GET is just a table read now. Failures keep
  // the current list on screen instead of nuking it to an error state.
  const refresh = async () => {
    setIsRefreshing(true);
    setActionError(null);
    try {
      const res = await apiFetch('/api/insights/refresh', { method: 'POST' });
      const body: { data: InsightsResult | null; error: string | null } | null =
        await res.json().catch(() => null);
      if (!res.ok || !body || body.error) {
        throw new Error(body?.error ?? `Refresh failed (${res.status})`);
      }
      const valid = parseInsights(body.data?.insights);
      setFetchState(
        valid.length === 0
          ? { status: 'empty', meta: body.data?.meta }
          : { status: 'data', insights: valid, meta: body.data?.meta },
      );
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Refresh failed — try again shortly.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const setInsightStatus = async (insight: Insight, next: InsightStatus) => {
    if (!insight.id || actioningId) return;
    setActioningId(insight.id);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/insights/${insight.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      const body: { data: unknown; error: string | null } | null = await res.json().catch(() => null);
      if (!res.ok || !body || body.error) {
        throw new Error(body?.error ?? `Update failed (${res.status})`);
      }
      // The insight left this tab's status — drop its card.
      setFetchState((prev) => {
        if (prev.status !== 'data') return prev;
        const remaining = prev.insights.filter((i) => i.id !== insight.id);
        return remaining.length === 0
          ? { status: 'empty', meta: prev.meta }
          : { ...prev, insights: remaining };
      });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to update insight.');
    } finally {
      setActioningId(null);
    }
  };

  const isNewInsight = (insight: Insight): boolean =>
    Boolean(
      tab === 'active' &&
      newSince &&
      insight.first_seen_at &&
      new Date(insight.first_seen_at).getTime() > new Date(newSince).getTime(),
    );

  // The active tab's empty state depends on WHY it's empty: not enough synced
  // data yet (onboarding nudge) vs. every insight actioned (all caught up).
  const emptyMeta = fetchState.status === 'empty' ? fetchState.meta : undefined;
  const hasEnoughData = (emptyMeta?.daysWithData ?? 0) >= 3;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">AI Insights</h1>
          <p className="text-[13.5px] font-medium text-ink-3 mt-[5px]">
            {restaurant ? `${restaurant.name} · ` : ''}Prioritized actions from your last 30 days
          </p>
        </div>
        {tab === 'active' && (fetchState.status === 'data' || fetchState.status === 'empty') && (
          <button
            onClick={() => { void refresh(); }}
            disabled={isRefreshing}
            className="flex items-center gap-2 h-[38px] px-4 rounded-[9px] border border-line bg-surface text-[13px] font-semibold text-ink-2 hover:bg-canvas transition-colors flex-shrink-0 disabled:opacity-60"
          >
            <Icon name="sync" size={15} className={isRefreshing ? 'animate-spin' : ''} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {/* Status tabs (Sprint U Phase 2) */}
      <div className="flex gap-1 bg-canvas border border-line rounded-lg p-1 w-fit">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-1.5 rounded-md text-[12.5px] font-bold transition-colors ${
              tab === t.key
                ? 'bg-surface text-navy-700 shadow-sm border border-line'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Action error — kept out of the main fetch state so a failed button
          click or refresh doesn't wipe the list off the screen. */}
      {actionError && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-[12.5px] font-medium text-red-600">
          <Icon name="attention" size={15} className="flex-shrink-0" />
          {actionError}
        </div>
      )}

      {/* Loading */}
      {fetchState.status === 'loading' && (
        <div className="space-y-6">
          {tab === 'active' && <div className="bg-navy-700/10 rounded-xl h-[160px] animate-pulse" />}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
        </div>
      )}

      {/* Error */}
      {fetchState.status === 'error' && (
        <div className="bg-white rounded-xl border border-line p-8 text-center space-y-3">
          <Icon name="attention" size={28} className="text-neg mx-auto" />
          <p className="text-sm font-medium text-neg">{fetchState.message}</p>
          <button
            onClick={() => { load(tab); }}
            className="px-4 py-2 bg-navy-700 text-white text-sm font-bold rounded-lg hover:bg-navy-800 transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* Empty */}
      {fetchState.status === 'empty' && (
        tab !== 'active' ? (
          <div className="bg-white rounded-xl border border-line p-10 text-center space-y-3">
            <Icon name={tab === 'completed' ? 'check' : 'close'} size={32} className="text-ink-3 mx-auto" />
            <p className="text-base font-bold text-gray-700">
              No {tab} insights
            </p>
            <p className="text-sm text-ink-3 max-w-xs mx-auto">
              {tab === 'completed'
                ? 'Insights you mark done will show up here.'
                : 'Insights you dismiss will show up here.'}
            </p>
          </div>
        ) : hasEnoughData ? (
          <div className="bg-white rounded-xl border border-line p-10 text-center space-y-3">
            <Icon name="check" size={32} className="text-green-700 mx-auto" />
            <p className="text-base font-bold text-gray-700">You're all caught up</p>
            <p className="text-sm text-ink-3 max-w-xs mx-auto">
              Every recommendation has been actioned. New insights appear automatically after your
              next sync, or hit Refresh to regenerate now.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-line p-10 text-center space-y-3">
            <Icon name="insights" size={32} className="text-ink-3 mx-auto" />
            <p className="text-base font-bold text-gray-700">No insights yet</p>
            <p className="text-sm text-ink-3 max-w-xs mx-auto">
              Connect your Square POS and sync at least 3 days of sales — AI recommendations appear once there's enough data to analyze.
            </p>
            <Link
              to="/integrations"
              className="inline-flex items-center mt-2 px-4 py-2 bg-navy-700 text-white text-sm font-bold rounded-lg hover:bg-navy-800 transition-colors"
            >
              Connect Square
            </Link>
          </div>
        )
      )}

      {/* Data */}
      {fetchState.status === 'data' && (
        <div className="space-y-5">
          {tab === 'active' && <ExecutiveSummary insights={fetchState.insights} />}
          {tab === 'active' && fetchState.meta && <ExplainabilityBar meta={fetchState.meta} />}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {fetchState.insights.map((insight, idx) => (
              <InsightCard
                key={insight.id ?? `${insight.category}-${idx}`}
                insight={insight}
                rank={idx + 1}
                tab={tab}
                isNew={isNewInsight(insight)}
                pending={actioningId === insight.id}
                onSetStatus={(next) => { void setInsightStatus(insight, next); }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default InsightsPanel;
