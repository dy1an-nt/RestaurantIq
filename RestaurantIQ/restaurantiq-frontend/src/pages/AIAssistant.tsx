import { useState } from 'react';
import InsightsPanel from '../components/InsightsPanel';
import Chat from './Chat';

type Tab = 'insights' | 'chat';

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 -mb-px text-sm font-semibold border-b-2 transition-colors ${
        active
          ? 'border-navy-700 text-navy-700'
          : 'border-transparent text-ink-3 hover:text-ink-2'
      }`}
    >
      {label}
    </button>
  );
}

export default function AIAssistant() {
  const [tab, setTab] = useState<Tab>('insights');

  return (
    <>
      <div className="flex gap-1 mb-5 border-b border-line">
        <TabButton label="AI Insights" active={tab === 'insights'} onClick={() => setTab('insights')} />
        <TabButton label="AI Chat" active={tab === 'chat'} onClick={() => setTab('chat')} />
      </div>
      {tab === 'insights' ? <InsightsPanel /> : <Chat />}
    </>
  );
}
