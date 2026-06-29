import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useAuth } from './auth/AuthContext';
import Icon, { IconName } from './Icons';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Alert {
  id: string;
  menu_item_id: string | null;
  type: 'no_sales' | 'trending_down' | 'new_top_performer' | 'unusual_spike' | 'traffic_drop';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

// ─── Mapping: alert → priority + investigate action ─────────────────────────────
// The dashboard strip answers "what needs attention today?" from the cheap,
// real-time alerts feed rather than re-calling the rate-limited AI endpoint on
// every dashboard load. Each alert type points at the page that explains it.

const SEVERITY_RANK: Record<Alert['severity'], number> = { critical: 0, warning: 1, info: 2 };

const SEVERITY_STYLE: Record<Alert['severity'], { chip: string; label: string; icon: IconName; iconColor: string }> = {
  critical: { chip: 'bg-red-50 text-red-600 border border-red-200',     label: 'High priority',   icon: 'attention', iconColor: 'text-red-500' },
  warning:  { chip: 'bg-warn-bg text-warn border border-warn/30',       label: 'Medium priority', icon: 'attention', iconColor: 'text-warn' },
  info:     { chip: 'bg-green-50 text-green-700 border border-green-200', label: 'Good news',       icon: 'star',      iconColor: 'text-green-600' },
};

const ACTION_BY_TYPE: Record<Alert['type'], { label: string; to: string }> = {
  no_sales:          { label: 'See Analytics',  to: '/analytics' },
  trending_down:     { label: 'See Analytics',  to: '/analytics' },
  traffic_drop:      { label: 'Open Forecast',  to: '/advisor' },
  unusual_spike:     { label: 'See Analytics',  to: '/analytics' },
  new_top_performer: { label: 'Promote It',     to: '/marketing' },
};

// ─── Component ──────────────────────────────────────────────────────────────────

/**
 * "Needs attention today" strip for the top of the dashboard (Sprint T5).
 * Surfaces the single most urgent unread alert with a one-click way to
 * investigate it, plus a calm "all clear" state when nothing is pending.
 * Peripheral UI: any fetch failure simply renders nothing.
 */
const DashboardPriority = () => {
  const { session } = useAuth();
  const [top, setTop] = useState<Alert | null | undefined>(undefined); // undefined = loading
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await apiFetch('/api/alerts', { signal: controller.signal });
        if (cancelled) return;
        const body: { data: Alert[] | null; error: string | null } = await res.json();
        if (cancelled || !res.ok || body.error || !body.data) { setTop(null); return; }

        const unread = body.data.filter((a) => !a.is_read);
        setUnreadCount(unread.length);

        // Most urgent first: severity, then most recent.
        const ranked = [...unread].sort((a, b) => {
          const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
          return s !== 0 ? s : b.created_at.localeCompare(a.created_at);
        });
        setTop(ranked[0] ?? null);
      } catch {
        if (!cancelled) setTop(null); // peripheral — fail quietly
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [session]);

  // Loading — reserve space to avoid layout shift.
  if (top === undefined) {
    return <div className="mb-[22px] h-[84px] rounded-xl border border-line bg-white animate-pulse" />;
  }

  // All clear — calm, positive state.
  if (top === null) {
    return (
      <div className="mb-[22px] flex items-center gap-3 rounded-xl border border-green-200 bg-green-50/50 px-5 py-4">
        <Icon name="check" size={18} className="text-green-600 flex-shrink-0" />
        <div>
          <p className="text-[13px] font-bold text-ink">All clear today</p>
          <p className="text-[12.5px] text-ink-3">No alerts need your attention right now.</p>
        </div>
      </div>
    );
  }

  const style = SEVERITY_STYLE[top.severity];
  const action = ACTION_BY_TYPE[top.type] ?? { label: 'View Alerts', to: '/alerts' };

  return (
    <div className="mb-[22px] rounded-xl border border-line bg-white px-5 py-4">
      <div className="flex items-start gap-3.5">
        <Icon name={style.icon} size={20} className={`${style.iconColor} mt-0.5 flex-shrink-0`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-3">
              Needs attention today
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold ${style.chip}`}>
              {style.label}
            </span>
          </div>
          <p className="text-[14px] font-bold text-ink leading-snug">{top.title}</p>
          <p className="text-[12.5px] text-ink-2 leading-snug mt-0.5">{top.message}</p>
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <Link
            to={action.to}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-navy-700 text-white text-[12.5px] font-bold hover:bg-navy-800 transition-colors whitespace-nowrap"
          >
            {action.label}
            <Icon name="chevron" size={14} className="-rotate-90" />
          </Link>
          {unreadCount > 1 && (
            <Link to="/alerts" className="text-[11.5px] font-semibold text-ink-3 hover:text-navy-700 whitespace-nowrap">
              +{unreadCount - 1} more alert{unreadCount - 1 === 1 ? '' : 's'}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default DashboardPriority;
