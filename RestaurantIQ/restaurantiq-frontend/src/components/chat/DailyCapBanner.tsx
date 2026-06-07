import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getChatUsage, ChatUsage } from '../../lib/chatApi';

export default function DailyCapBanner() {
  const { session } = useAuth();
  const [usage, setUsage] = useState<ChatUsage | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    getChatUsage(session).then((u) => { if (!cancelled) setUsage(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [session]);

  if (!usage) return null;

  const { messages_today, daily_cap } = usage;
  const pct = messages_today / daily_cap;

  if (pct >= 1) {
    return (
      <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
        Daily limit reached — resets at midnight UTC
      </div>
    );
  }

  if (pct >= 0.8) {
    return (
      <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
        {messages_today} of {daily_cap} messages used today
      </div>
    );
  }

  return (
    <p className="mx-4 mt-2 text-xs text-gray-400">
      {messages_today} of {daily_cap} messages used today
    </p>
  );
}
