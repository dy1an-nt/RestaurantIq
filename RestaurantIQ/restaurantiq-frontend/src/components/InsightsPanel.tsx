import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { useRestaurant } from './restaurant/RestaurantContext';

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
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'data'; insights: Insight[] };

// ─── Category styling ─────────────────────────────────────────────────────────

interface CategoryStyle {
  badge: string;
  border: string;
  label: string;
}

const CATEGORY_STYLES: Record<InsightCategory, CategoryStyle> = {
  staffing: {
    badge: 'bg-blue-100 text-blue-800',
    border: 'border-blue-400',
    label: 'Staffing',
  },
  peak_hours: {
    badge: 'bg-amber-100 text-amber-800',
    border: 'border-amber-400',
    label: 'Peak Hours',
  },
  slow_days: {
    badge: 'bg-orange-100 text-orange-800',
    border: 'border-orange-400',
    label: 'Slow Days',
  },
  sales_anomaly: {
    badge: 'bg-red-100 text-red-800',
    border: 'border-red-400',
    label: 'Sales Anomaly',
  },
  menu_performance: {
    badge: 'bg-green-100 text-green-800',
    border: 'border-green-400',
    label: 'Menu Performance',
  },
  operational: {
    badge: 'bg-purple-100 text-purple-800',
    border: 'border-purple-400',
    label: 'Operational',
  },
  customer_behavior: {
    badge: 'bg-indigo-100 text-indigo-800',
    border: 'border-indigo-400',
    label: 'Customer Behavior',
  },
};

const FALLBACK_STYLE: CategoryStyle = {
  badge: 'bg-gray-100 text-gray-700',
  border: 'border-gray-400',
  label: 'General',
};

function getCategoryStyle(category: string): CategoryStyle {
  return CATEGORY_STYLES[category as InsightCategory] ?? FALLBACK_STYLE;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const SkeletonCard = () => (
  <div className="bg-white rounded-xl shadow-sm border-l-4 border-gray-200 p-5 space-y-3 animate-pulse">
    <div className="h-4 w-24 bg-gray-200 rounded" />
    <div className="h-5 w-3/4 bg-gray-200 rounded" />
    <div className="space-y-2">
      <div className="h-3 w-full bg-gray-200 rounded" />
      <div className="h-3 w-5/6 bg-gray-200 rounded" />
    </div>
    <div className="h-4 w-1/3 bg-gray-200 rounded" />
  </div>
);

interface InsightCardProps {
  insight: Insight;
}

const InsightCard = ({ insight }: InsightCardProps) => {
  const style = getCategoryStyle(insight.category);
  return (
    <div className={`bg-white rounded-xl shadow-sm border-l-4 ${style.border} p-5 space-y-3`}>
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${style.badge}`}
      >
        {style.label}
      </span>
      <h3 className="text-base font-semibold text-gray-900 leading-snug">{insight.title}</h3>
      <p className="text-sm text-gray-700 leading-relaxed">{insight.recommendation}</p>
      <div className="pt-1">
        <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-600 text-xs font-mono rounded">
          {insight.metric}
        </span>
      </div>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const InsightsPanel = () => {
  const { session } = useAuth();
  const { restaurant } = useRestaurant();
  const [retryCount, setRetryCount] = useState(0);
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });

  const handleRetry = useCallback(() => {
    setFetchState({ status: 'loading' });
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!session) {
      setFetchState({ status: 'error', message: 'Not authenticated. Please sign in again.' });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setFetchState({ status: 'loading' });

    (async () => {
      try {
        const res = await fetch('/api/insights', {
          headers: { Authorization: `Bearer ${session.access_token}` },
          signal: controller.signal,
        });

        if (cancelled) return;

        const body: { data: InsightsResult | null; error: string | null } = await res.json();

        if (cancelled) return;

        if (!res.ok || body.error) {
          setFetchState({ status: 'error', message: body.error ?? `Request failed (${res.status})` });
          return;
        }

        if (!body.data || typeof body.data !== 'object') {
          setFetchState({ status: 'error', message: 'Unexpected response from server.' });
          return;
        }

        const raw = body.data.insights;
        if (!Array.isArray(raw)) {
          setFetchState({ status: 'empty' });
          return;
        }

        const valid = raw.filter(
          (item): item is Insight =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.category === 'string' &&
            typeof item.title === 'string' &&
            item.title.length > 0 &&
            typeof item.recommendation === 'string' &&
            item.recommendation.length > 0 &&
            typeof item.metric === 'string',
        );

        if (valid.length === 0) {
          setFetchState({ status: 'empty' });
        } else {
          setFetchState({ status: 'data', insights: valid });
        }
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setFetchState({
          status: 'error',
          message: err instanceof Error ? err.message : 'An unexpected error occurred.',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [session, retryCount]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">AI Insights</h1>
        <p className="text-sm text-gray-500 mt-1">
          {restaurant ? `${restaurant.name} · ` : ''}Last 30 days
        </p>
      </div>

      {/* Loading state */}
      {fetchState.status === 'loading' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {/* Error state */}
      {fetchState.status === 'error' && (
        <div className="bg-white rounded-xl shadow-sm p-8 text-center space-y-3">
          <p className="text-sm font-medium text-red-600">{fetchState.message}</p>
          <button
            onClick={handleRetry}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            Try again
          </button>
        </div>
      )}

      {/* Empty state */}
      {fetchState.status === 'empty' && (
        <div className="bg-white rounded-xl shadow-sm p-8 text-center">
          <p className="text-base font-semibold text-gray-700">No insights yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Connect your Square POS and sync at least 3 days of sales data — AI recommendations will appear once there's enough to analyze.
          </p>
          <Link
            to="/integrations"
            className="inline-flex items-center mt-4 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
          >
            Connect Square
          </Link>
        </div>
      )}

      {/* Data state */}
      {fetchState.status === 'data' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {fetchState.insights.map((insight, idx) => (
            <InsightCard key={`${insight.category}-${idx}`} insight={insight} />
          ))}
        </div>
      )}
    </div>
  );
};

export default InsightsPanel;
