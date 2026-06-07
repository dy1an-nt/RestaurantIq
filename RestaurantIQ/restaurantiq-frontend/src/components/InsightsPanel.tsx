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

interface Insight {
  category: InsightCategory;
  title: string;
  recommendation: string;
  metric: string;
}

interface InsightsResult {
  insights: Insight[];
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'data'; insights: Insight[] };

// ─── Priority ─────────────────────────────────────────────────────────────────

type Priority = 'critical' | 'opportunity' | 'positive' | 'info';

function derivePriority(insight: Insight): Priority {
  const text = `${insight.title} ${insight.recommendation} ${insight.metric}`.toLowerCase();
  if (/fell|dropped|failing|underperform|missing|inconsist|volatile|not capturing|below average|slow day|out.of.stock|40%.*below|only.*day/.test(text)) {
    return 'critical';
  }
  if (/spike|jump|best day|highest|strongest|top performer|outperform|up \d+%|increased|record/.test(text)) {
    return 'positive';
  }
  if (/promot|boost|feature|upsell|bundle|opportunit|extend|train staff|increase.*cover|add.*portion/.test(text)) {
    return 'opportunity';
  }
  return 'info';
}

const PRIORITY_CONFIG: Record<Priority, { label: string; chip: string; cardBg: string }> = {
  critical:    { label: 'Needs Attention', chip: 'bg-red-50 text-red-600 border border-red-200',        cardBg: 'bg-red-50/40' },
  opportunity: { label: 'Opportunity',     chip: 'bg-warn-bg text-warn border border-warn/30',          cardBg: 'bg-white' },
  positive:    { label: 'Positive Trend',  chip: 'bg-green-50 text-green-700 border border-green-200',  cardBg: 'bg-green-50/30' },
  info:        { label: 'Informational',   chip: 'bg-navy-50 text-navy-700 border border-navy-100',     cardBg: 'bg-white' },
};

// ─── Category config ──────────────────────────────────────────────────────────

interface CategoryConfig {
  label: string;
  border: string;
  icon: React.ReactNode;
}

const CATEGORY_CONFIG: Record<InsightCategory, CategoryConfig> = {
  staffing:          { label: 'Staffing',           border: 'border-blue-400',   icon: <Icon name="store"     size={15} /> },
  peak_hours:        { label: 'Peak Hours',          border: 'border-amber-400',  icon: <Icon name="analytics" size={15} /> },
  slow_days:         { label: 'Slow Days',           border: 'border-orange-400', icon: <Icon name="arrowDown" size={15} /> },
  sales_anomaly:     { label: 'Sales Anomaly',       border: 'border-red-400',    icon: <Icon name="attention" size={15} /> },
  menu_performance:  { label: 'Menu Performance',    border: 'border-green-400',  icon: <Icon name="star"      size={15} /> },
  operational:       { label: 'Operational',         border: 'border-purple-400', icon: <Icon name="sync"      size={15} /> },
  customer_behavior: { label: 'Customer Behavior',   border: 'border-navy-500',   icon: <Icon name="insights"  size={15} /> },
};

const FALLBACK_CATEGORY: CategoryConfig = {
  label: 'General', border: 'border-gray-300', icon: <Icon name="dot" size={15} />,
};

function getCategoryConfig(category: string): CategoryConfig {
  return CATEGORY_CONFIG[category as InsightCategory] ?? FALLBACK_CATEGORY;
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
    <div className="space-y-2 pt-1">
      <div className="h-3 w-32 bg-gray-100 rounded" />
      <div className="h-4 w-full bg-gray-100 rounded" />
    </div>
  </div>
);

// ─── Executive Summary ────────────────────────────────────────────────────────

const ExecutiveSummary = ({ insights }: { insights: Insight[] }) => {
  const criticalCount = insights.filter(i => derivePriority(i) === 'critical').length;
  const opportunityCount = insights.filter(
    i => derivePriority(i) === 'opportunity' || derivePriority(i) === 'positive'
  ).length;

  const bullets = insights.slice(0, 4).map(i => i.metric);
  const topAction = insights[0]?.recommendation ?? '';

  return (
    <div className="bg-navy-700 text-white rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-bold uppercase tracking-[0.08em] text-white/60">
          This Week's Highlights
        </h2>
        <div className="flex gap-2">
          {criticalCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 text-[11.5px] font-bold border border-red-400/40">
              {criticalCount} need{criticalCount === 1 ? 's' : ''} attention
            </span>
          )}
          {opportunityCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-300 text-[11.5px] font-bold border border-green-400/40">
              {opportunityCount} opportunit{opportunityCount === 1 ? 'y' : 'ies'}
            </span>
          )}
        </div>
      </div>

      <ul className="space-y-1.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] text-white/80 leading-snug">
            <span className="mt-[3px] w-1.5 h-1.5 rounded-full bg-white/40 flex-shrink-0" />
            {b}
          </li>
        ))}
      </ul>

      {topAction && (
        <div className="pt-1 border-t border-white/10">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50 mb-1">
            Top priority today
          </p>
          <p className="text-[13px] text-white leading-snug">{topAction}</p>
        </div>
      )}
    </div>
  );
};

// ─── Insight Card ─────────────────────────────────────────────────────────────

const PRIORITY_BORDER: Record<Priority, string> = {
  critical:    'border-red-400',
  positive:    'border-green-500',
  opportunity: '',
  info:        '',
};

const InsightCard = ({ insight, rank }: { insight: Insight; rank: number }) => {
  const priority = derivePriority(insight);
  const priorityCfg = PRIORITY_CONFIG[priority];
  const categoryCfg = getCategoryConfig(insight.category);
  const leftBorder = PRIORITY_BORDER[priority] || categoryCfg.border;

  return (
    <div className={`${priorityCfg.cardBg} rounded-xl border-l-4 ${leftBorder} border border-line flex flex-col`}>
      {/* Card header */}
      <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-bold ${priorityCfg.chip}`}>
          {priorityCfg.label}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold bg-canvas text-ink-2 border border-line">
          {categoryCfg.icon}
          {categoryCfg.label}
        </span>
      </div>

      {/* Title */}
      <div className="px-5 pb-4">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-[11px] font-bold text-ink-3 bg-canvas border border-line rounded px-1.5 py-0.5 flex-shrink-0">
            #{rank}
          </span>
          <h3 className="text-[15px] font-bold text-ink leading-snug">{insight.title}</h3>
        </div>
      </div>

      {/* What happened */}
      <div className="mx-5 mb-4 bg-canvas rounded-lg px-4 py-3 space-y-1">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-3">
          What happened
        </p>
        <p className="text-[13px] font-medium text-ink-2 leading-snug">{insight.metric}</p>
      </div>

      {/* Action */}
      <div className="mx-5 mb-5 border-l-2 border-navy-700 pl-3 space-y-1">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-navy-700">
          Action for tomorrow morning
        </p>
        <p className="text-[13px] text-ink leading-snug">{insight.recommendation}</p>
      </div>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const InsightsPanel = () => {
  const { session } = useAuth();
  const { restaurant } = useRestaurant();
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'idle' });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback((isRefresh = false) => {
    if (!session) {
      setFetchState({ status: 'error', message: 'Not authenticated. Please sign in again.' });
      return;
    }

    const controller = new AbortController();
    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setFetchState({ status: 'loading' });
    }

    (async () => {
      try {
        const res = await apiFetch('/api/insights', { signal: controller.signal });
        const body: { data: InsightsResult | null; error: string | null } = await res.json();

        if (!res.ok || body.error) {
          setFetchState({ status: 'error', message: body.error ?? `Request failed (${res.status})` });
          setIsRefreshing(false);
          return;
        }

        const raw = body.data?.insights;
        if (!Array.isArray(raw)) { setFetchState({ status: 'empty' }); setIsRefreshing(false); return; }

        const valid = raw.filter(
          (item): item is Insight =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.category === 'string' &&
            typeof item.title === 'string' && item.title.length > 0 &&
            typeof item.recommendation === 'string' && item.recommendation.length > 0 &&
            typeof item.metric === 'string',
        );

        setFetchState(valid.length === 0 ? { status: 'empty' } : { status: 'data', insights: valid });
        setIsRefreshing(false);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setFetchState({
          status: 'error',
          message: err instanceof Error ? err.message : 'An unexpected error occurred.',
        });
        setIsRefreshing(false);
      }
    })();

    return () => controller.abort();
  }, [session]);

  useEffect(() => {
    const cleanup = load(false);
    return cleanup;
  }, [load]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[25px] font-extrabold tracking-[-0.02em] text-ink">AI Insights</h1>
          <p className="text-[13.5px] font-medium text-ink-3 mt-[5px]">
            {restaurant ? `${restaurant.name} · ` : ''}Last 30 days
          </p>
        </div>
        {fetchState.status === 'data' && (
          <button
            onClick={() => { load(true); }}
            disabled={isRefreshing}
            className="flex items-center gap-2 h-[38px] px-4 rounded-[9px] border border-line bg-surface text-[13px] font-semibold text-ink-2 hover:bg-canvas transition-colors flex-shrink-0 disabled:opacity-60"
          >
            <Icon name="sync" size={15} className={isRefreshing ? 'animate-spin' : ''} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {/* Loading */}
      {fetchState.status === 'loading' && (
        <div className="space-y-6">
          <div className="bg-navy-700/10 rounded-xl h-[180px] animate-pulse" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
        </div>
      )}

      {/* Error */}
      {fetchState.status === 'error' && (
        <div className="bg-white rounded-xl border border-line p-8 text-center space-y-3">
          <Icon name="attention" size={28} className="text-neg mx-auto" />
          <p className="text-sm font-medium text-neg">{fetchState.message}</p>
          <button
            onClick={() => { load(false); }}
            className="px-4 py-2 bg-navy-700 text-white text-sm font-bold rounded-lg hover:bg-navy-800 transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* Empty */}
      {fetchState.status === 'empty' && (
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
      )}

      {/* Data */}
      {fetchState.status === 'data' && (
        <div className="space-y-6">
          <ExecutiveSummary insights={fetchState.insights} />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {fetchState.insights.map((insight, idx) => (
              <InsightCard key={`${insight.category}-${idx}`} insight={insight} rank={idx + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default InsightsPanel;
