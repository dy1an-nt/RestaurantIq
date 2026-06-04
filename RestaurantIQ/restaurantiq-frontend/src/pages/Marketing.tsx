import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useRestaurant } from '../components/restaurant/RestaurantContext';

interface MenuItem {
  id: string;
  name: string;
  category: string;
  price_cents: number;
  revenue_30d_cents: number;
  orders_30d: number;
  trend: 'up' | 'down' | 'flat';
}

interface PromoIdea {
  title: string;
  description: string;
}

interface MarketingResult {
  captions: string[];
  hashtags: string[];
  promoIdeas: PromoIdea[];
}

const TONES = ['casual', 'hype', 'premium', 'family-friendly', 'trendy', 'late-night'] as const;
const PLATFORMS = ['instagram', 'twitter', 'facebook', 'tiktok', 'general'] as const;

// ---------------------------------------------------------------------------
// Skeleton shown while AI is generating
// ---------------------------------------------------------------------------
const ResultsSkeleton = () => (
  <div className="space-y-4 animate-pulse">
    {[0, 1, 2].map((i) => (
      <div key={i} className="border border-gray-100 rounded-lg p-4 space-y-2">
        <div className="h-3 bg-gray-200 rounded w-full" />
        <div className="h-3 bg-gray-200 rounded w-5/6" />
        <div className="h-3 bg-gray-200 rounded w-4/6" />
      </div>
    ))}
    <div className="flex flex-wrap gap-2 pt-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-5 w-16 bg-gray-200 rounded-full" />
      ))}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Results panel content
// ---------------------------------------------------------------------------
const ResultsPanel = ({ result }: { result: MarketingResult }) => {
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const handleCopy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(idx);
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => {
      // clipboard API unavailable — silently ignore
    });
  };

  const captions = result.captions ?? [];
  const hashtags = result.hashtags ?? [];
  const promoIdeas = result.promoIdeas ?? [];

  return (
    <div className="space-y-6">
      {/* Captions */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          Captions
        </h3>
        {captions.length === 0 ? (
          <p className="text-sm text-gray-400">No captions generated.</p>
        ) : (
          <div className="space-y-3">
            {captions.map((caption, idx) => (
              <div key={idx} className="border border-gray-100 rounded-lg p-4 text-sm text-gray-800 leading-relaxed">
                <p>{caption}</p>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleCopy(caption, idx)}
                    className="text-xs text-gray-400 hover:text-navy-700 transition-colors flex items-center gap-1"
                  >
                    {/* Clipboard icon */}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-3.5 w-3.5"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                      <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                    </svg>
                    {copiedId === idx ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hashtags — omit section entirely when empty */}
      {hashtags.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
            Hashtags
          </h3>
          <div className="flex flex-wrap gap-2">
            {hashtags.map((tag, idx) => (
              <span
                key={idx}
                className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-navy-50 text-navy-800"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Promo Ideas */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          Promo Ideas
        </h3>
        {promoIdeas.length === 0 ? (
          <p className="text-sm text-gray-400">No promo ideas generated.</p>
        ) : (
          <div className="space-y-3">
            {promoIdeas.map((idea, idx) => (
              <div key={idx} className="border border-gray-100 rounded-lg p-4">
                <p className="text-sm font-semibold text-gray-800">{idea.title}</p>
                <p className="mt-1 text-sm text-gray-600 leading-relaxed">{idea.description}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const Marketing = () => {
  const { restaurant } = useRestaurant();

  const [menuItems, setMenuItems] = useState<MenuItem[] | null>(null);
  const [menuItemsError, setMenuItemsError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [tone, setTone] = useState<string>('casual');
  const [platform, setPlatform] = useState<string>('instagram');
  const [result, setResult] = useState<MarketingResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Fetch menu items on mount / when restaurant changes
  useEffect(() => {
    if (!restaurant) return;
    let cancelled = false;
    const controller = new AbortController();
    setMenuItems(null);
    setMenuItemsError(null);

    (async () => {
      try {
        const res = await apiFetch(`/api/restaurants/${restaurant.id}/menu-items`, {
          signal: controller.signal,
        });
        const body = await res.json() as { data: MenuItem[]; error: string | null };
        if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`);
        if (!cancelled) {
          setMenuItems(body.data);
          if (body.data.length > 0) {
            setSelectedItemId(body.data[0].id);
          }
        }
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        if (!cancelled) {
          setMenuItemsError(err instanceof Error ? err.message : 'Failed to load menu items');
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [restaurant]);

  const handleGenerate = async () => {
    if (!selectedItemId || generating) return;
    setGenerating(true);
    setGenError(null);
    setResult(null);

    try {
      const res = await apiFetch('/api/marketing/generate', {
        method: 'POST',
        body: JSON.stringify({ menuItemId: selectedItemId, tone, platform }),
      });
      const body = await res.json() as { data: MarketingResult; error: string | null };
      if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`);
      setResult(body.data);
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const labelClass = 'block text-sm font-medium text-gray-700 mb-1';
  const selectClass =
    'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-navy-500';
  const primaryBtn =
    'w-full bg-navy-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-navy-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2';
  const outlineBtn =
    'w-full border border-navy-700 text-navy-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-navy-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2';

  return (
    <div className="max-w-5xl space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Marketing Copy</h1>
        <p className="text-sm text-gray-500 mt-1">
          Generate platform-ready captions and promo ideas
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* ---------------------------------------------------------------- */}
        {/* Left panel — generation form                                     */}
        {/* ---------------------------------------------------------------- */}
        <div className="bg-white rounded-xl shadow p-6 space-y-4">
          {/* Menu item selector */}
          <div>
            <label htmlFor="menu-item" className={labelClass}>
              Menu Item
            </label>
            {menuItemsError ? (
              <p className="text-sm text-red-600">{menuItemsError}</p>
            ) : (
              <select
                id="menu-item"
                className={selectClass}
                value={selectedItemId}
                onChange={(e) => setSelectedItemId(e.target.value)}
                disabled={menuItems === null}
              >
                {menuItems === null ? (
                  <option value="">Loading items…</option>
                ) : menuItems.length === 0 ? (
                  <option value="">No menu items found</option>
                ) : (
                  menuItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} — {item.category}
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          {/* Tone selector */}
          <div>
            <label htmlFor="tone" className={labelClass}>
              Tone
            </label>
            <select
              id="tone"
              className={selectClass}
              value={tone}
              onChange={(e) => setTone(e.target.value)}
            >
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {/* Platform selector */}
          <div>
            <label htmlFor="platform" className={labelClass}>
              Platform
            </label>
            <select
              id="platform"
              className={selectClass}
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {/* Generate button */}
          <button
            type="button"
            className={primaryBtn}
            disabled={generating || !selectedItemId}
            onClick={handleGenerate}
          >
            {generating && (
              <svg
                className="h-4 w-4 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v8H4z"
                />
              </svg>
            )}
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Right panel — results                                            */}
        {/* ---------------------------------------------------------------- */}
        <div className="bg-white rounded-xl shadow p-6">
          {/* Error banner */}
          {genError && (
            <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {genError}
            </div>
          )}

          {/* Skeleton while generating (first run — no result yet) */}
          {generating && result === null && <ResultsSkeleton />}

          {/* Empty state — nothing generated yet */}
          {!generating && result === null && !genError && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-10 w-10 text-gray-300 mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
              <p className="text-sm text-gray-400">
                Select an item and tone, then generate.
              </p>
            </div>
          )}

          {/* Results */}
          {result !== null && (
            <>
              {/* If currently regenerating, show skeleton on top of stale results */}
              {generating ? (
                <ResultsSkeleton />
              ) : (
                <ResultsPanel result={result} />
              )}

              {/* Regenerate button — always shown once there's a result */}
              {!generating && (
                <div className="mt-6">
                  <button
                    type="button"
                    className={outlineBtn}
                    disabled={generating || !selectedItemId}
                    onClick={handleGenerate}
                  >
                    Regenerate
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default Marketing;
