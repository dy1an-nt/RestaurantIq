import type { ForecastNarrative } from '../../lib/advisorApi';

interface Props {
  narrative: ForecastNarrative | null;
  isLoading: boolean;
}

export default function NarrativePanel({ narrative, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
        <div className="h-4 bg-gray-100 rounded animate-pulse w-3/4" />
        <div className="h-4 bg-gray-100 rounded animate-pulse w-full" />
        <div className="h-4 bg-gray-100 rounded animate-pulse w-5/6" />
      </div>
    );
  }

  if (!narrative) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">This week's plan</h3>
        <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{narrative.summary}</p>
      </div>
      {narrative.callouts.length > 0 && (
        <div className="space-y-3">
          {narrative.callouts.map((c, i) => (
            <div key={i} className="flex gap-3 p-3 rounded-lg bg-gray-50 border border-gray-100">
              <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-xs font-bold flex items-center justify-center">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-800">{c.title}</p>
                <p className="text-sm text-gray-600 mt-0.5">{c.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
