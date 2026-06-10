/**
 * RestaurantIQ icon set — replaces ALL emoji in the old UI.
 * Outline style, 24×24 grid, inherits `currentColor` + sizing via props.
 *
 * Usage:
 *   <Icon name="dashboard" className="text-navy-700" />
 *   <Icon name="arrowUp" size={14} strokeWidth={2} />
 *
 * Old emoji → new icon mapping:
 *   📊 Dashboard → "dashboard"      📈 Analytics → "analytics"
 *   💰 Margins   → "margins"        🤖 AI Insights → "insights"
 *   🔔 Alerts    → "alerts"         📣 Marketing → "marketing"
 *   🔌 Integrations → "integrations"  🔄 Sync → "sync"
 *   ⭐ Top Performers → "star"       ⚠️ Needs Attention → "attention"
 *   ⬆️ up → "arrowUp"   ⬇️ down → "arrowDown"   ✅ → "check"
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'dashboard' | 'analytics' | 'margins' | 'insights' | 'alerts' | 'marketing'
  | 'integrations' | 'sync' | 'signout' | 'star' | 'attention' | 'arrowUp'
  | 'arrowDown' | 'flat' | 'search' | 'chevron' | 'calendar' | 'bell'
  | 'filter' | 'download' | 'check' | 'dot' | 'mail' | 'lock' | 'store'
  | 'chat' | 'advisor' | 'channels';

const PATHS: Record<IconName, JSX.Element> = {
  dashboard: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M8 15.5v-3M12 15.5v-6M16 15.5v-4.5" /></>,
  analytics: <><path d="M3.5 18.5h17" /><path d="M5 14.5l4-4.5 3.5 3L20 5.5" /><path d="M16.5 5.5H20v3.5" /></>,
  margins: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5v9M14.2 9.3c-.5-.6-1.4-.9-2.4-.9-1.3 0-2.3.7-2.3 1.8 0 2.4 4.9 1.3 4.9 3.7 0 1.1-1 1.9-2.5 1.9-1.1 0-2-.4-2.5-1" /></>,
  insights: <><path d="M9 17.5h6M9.5 20h5" /><path d="M12 3.5a6 6 0 0 0-3.6 10.8c.5.4.8 1 .8 1.6h5.6c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3.5Z" /></>,
  alerts: <><path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 5 2 6.5 2 6.5h-15s2-1.5 2-6.5Z" /><path d="M10.5 19.5a1.8 1.8 0 0 0 3 0" /></>,
  marketing: <><path d="M4.5 10v4l2.5.5c.4 2 1 4 2 4 .8 0 1-1.5.9-3" /><path d="M4.5 10 16 5.5v13L4.5 14" /><path d="M19 9.5c1 .8 1 3.2 0 4" /></>,
  integrations: <><path d="M9 4.5v4M15 4.5v4" /><path d="M7 8.5h10v3a5 5 0 0 1-10 0v-3Z" /><path d="M12 16.5v3" /></>,
  sync: <><path d="M6 8.5a8 8 0 0 1 13-2.2M19 5v3.5h-3.5" /><path d="M18 15.5a8 8 0 0 1-13 2.2M5 19v-3.5h3.5" /></>,
  signout: <><path d="M13.5 5.5H6.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7" /><path d="M16 8.5 19.5 12 16 15.5M9.5 12h10" /></>,
  star: <><path d="M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L6.8 9.8l5-.7L12 4.5Z" /></>,
  attention: <><path d="M12 4.8 20.5 19h-17L12 4.8Z" /><path d="M12 10v4.5M12 17h.01" /></>,
  arrowUp: <><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" /></>,
  arrowDown: <><path d="M12 5v13M17.5 12.5 12 18l-5.5-5.5" /></>,
  flat: <><path d="M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-3.5-3.5" /></>,
  chevron: <><path d="m6 9.5 6 6 6-6" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M4 9.5h16M8 3.5v4M16 3.5v4" /></>,
  bell: <><path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 5 2 6.5 2 6.5h-15s2-1.5 2-6.5Z" /><path d="M10.5 19.5a1.8 1.8 0 0 0 3 0" /></>,
  filter: <><path d="M4.5 6h15M7 12h10M10 18h4" /></>,
  download: <><path d="M12 4.5v9M8 10l4 3.5 4-3.5M5 18.5h14" /></>,
  check: <><path d="m5 12.5 4.5 4.5L19 7" /></>,
  dot: <><circle cx="12" cy="12" r="3.5" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4.5 7 7.5 5.5L19.5 7" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  store: <><path d="M4.5 9.5 6 4.5h12l1.5 5M5 9.5v9h14v-9M4.5 9.5h15" /><path d="M9.5 18.5v-4h5v4" /></>,
  chat: <><path d="M4.5 6.5h15a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8l-4 3V7.5a1 1 0 0 1 1-1Z" /></>,
  advisor: <><path d="M9 5.5h11M9 9.5h8M9 13.5h5" /><path d="M5.5 5.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM5.5 9.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM5.5 13.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" /><path d="M4.5 18.5h6l3 2.5V18.5H20a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v13.5a1 1 0 0 0 1 1Z" /></>,
  channels: <><path d="M3.5 18.5h8v-6h-8v6ZM3.5 9.5h8v-5h-8v5Z" /><path d="M15.5 18.5h5v-14h-5v14Z" /><path d="M8.5 12.5v-3" /></>,
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, strokeWidth = 1.7, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

export default Icon;
