import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface MenuItemPatch {
  id: string;
  name: string;
  category: string | null;
  price_cents: number;
  cost_cents: number | null;
  source?: string;
}

interface Props {
  item: MenuItemPatch;
  restaurantId: string;
  onClose: () => void;
  onSaved: (updated: MenuItemPatch) => void;
}

/**
 * Converts a user-facing dollar string to integer cents.
 * Returns { cents, error } — error is a message string when validation fails.
 * Empty string → cents === null (clear cost).
 */
function parseDollars(raw: string): { cents: number | null; error: string | null } {
  // Strip a leading currency symbol and thousands separators so both "4.25"
  // and "$4.25" (and "$1,500.00") are accepted, per spec.
  const trimmed = raw.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (trimmed === '') return { cents: null, error: null };

  // Allow an optional leading sign so negatives parse and hit the dedicated
  // "zero or greater" message; reject any other non-numeric text and more than
  // two decimal places (sub-cent values).
  if (!/^-?\d*\.?\d{0,2}$/.test(trimmed) || trimmed === '.' || trimmed === '-') {
    return { cents: null, error: 'Enter a valid amount.' };
  }

  const dollars = parseFloat(trimmed);
  if (!Number.isFinite(dollars)) {
    return { cents: null, error: 'Enter a valid amount.' };
  }
  if (dollars < 0) {
    return { cents: null, error: 'Cost must be zero or greater.' };
  }
  if (dollars > 1_000_000) {
    return { cents: null, error: 'Cost cannot exceed $1,000,000.' };
  }

  // Two-decimal cap above keeps this multiplication exact for valid input;
  // round to defend against binary float drift (e.g. 4.25 * 100).
  const cents = Math.round(dollars * 100);
  return { cents, error: null };
}

/** Format integer cents to a dollar string for the input (e.g. "12.50"). */
function centsToDollarString(cents: number | null): string {
  if (cents === null) return '';
  return (cents / 100).toFixed(2);
}

const EditMenuItemModal = ({ item, restaurantId, onClose, onSaved }: Props) => {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category ?? '');
  const [costInput, setCostInput] = useState(centsToDollarString(item.cost_cents));

  const [costError, setCostError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [saving, onClose]);

  // Focus the name input on mount
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Abort an in-flight save if the modal unmounts mid-request
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !saving) onClose();
  };

  const handleSave = async () => {
    // Client-side validation
    let valid = true;

    if (name.trim() === '') {
      setNameError('Name is required.');
      valid = false;
    } else {
      setNameError(null);
    }

    const { cents, error: costParseError } = parseDollars(costInput);
    if (costParseError) {
      setCostError(costParseError);
      valid = false;
    } else {
      setCostError(null);
    }

    if (!valid) return;

    // Build patch body — only changed fields
    const patch: { name?: string; category?: string | null; cost_cents?: number | null } = {};
    if (name.trim() !== item.name) patch.name = name.trim();
    const normalizedCategory = category.trim() === '' ? null : category.trim();
    if (normalizedCategory !== item.category) patch.category = normalizedCategory;
    if (cents !== item.cost_cents) patch.cost_cents = cents;

    // Nothing changed — just close
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    setServerError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const res = await fetch(
        `/api/restaurants/${restaurantId}/menu-items/${item.id}`,
        {
          method: 'PATCH',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(patch),
        }
      );
      const body = await res.json() as { data: MenuItemPatch; error: string | null };
      if (!res.ok || body.error) throw new Error(body.error ?? `Request failed (${res.status})`);

      onSaved(body.data);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setServerError(err instanceof Error ? err.message : 'Save failed. Please try again.');
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
    >
      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-item-title"
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-item-title" className="text-lg font-semibold text-gray-900">
          Edit Menu Item
        </h2>

        {/* Name */}
        <div>
          <label htmlFor="edit-name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input
            ref={nameRef}
            id="edit-name"
            type="text"
            value={name}
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
          />
          {nameError && <p className="mt-1 text-xs text-red-600">{nameError}</p>}
        </div>

        {/* Category */}
        <div>
          <label htmlFor="edit-category" className="block text-sm font-medium text-gray-700">
            Category
          </label>
          <input
            id="edit-category"
            type="text"
            value={category}
            disabled={saving}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. Appetizers"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
          />
        </div>

        {/* Price (read-only — shown for context while entering cost) */}
        <div>
          <label className="block text-sm font-medium text-gray-700">Price</label>
          <p className="mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-700">
            {centsToDollarString(item.price_cents) ? `$${centsToDollarString(item.price_cents)}` : '—'}
          </p>
        </div>

        {/* Cost */}
        <div>
          <label htmlFor="edit-cost" className="block text-sm font-medium text-gray-700">
            Cost
          </label>
          <div className="mt-1 relative">
            <span className="absolute inset-y-0 left-3 flex items-center text-sm text-gray-500 pointer-events-none">
              $
            </span>
            <input
              id="edit-cost"
              type="text"
              inputMode="decimal"
              value={costInput}
              disabled={saving}
              onChange={(e) => setCostInput(e.target.value)}
              placeholder="0.00"
              className="block w-full pl-7 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">Leave blank to mark cost as unknown.</p>
          {costError && <p className="mt-1 text-xs text-red-600">{costError}</p>}
        </div>

        {/* Server error */}
        {serverError && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {serverError}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 bg-white border border-gray-300 text-sm font-medium rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && (
              <svg
                className="animate-spin h-4 w-4 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 12 0 12 0v4a8 8 0 00-8 8H0z"
                />
              </svg>
            )}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EditMenuItemModal;
