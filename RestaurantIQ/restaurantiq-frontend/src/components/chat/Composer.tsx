import { useState, useRef, KeyboardEvent } from 'react';

interface Props {
  onSend: (content: string) => void;
  disabled: boolean;
}

export default function Composer({ onSend, disabled }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = !disabled && value.trim().length > 0;

  function submit() {
    if (!canSend) return;
    onSend(value.trim());
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleInput() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  const nearLimit = value.length > 1800;

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3">
      {nearLimit && (
        <p className="text-xs text-amber-600 mb-1">{value.length}/2000 characters</p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Ask anything about your restaurant…"
          maxLength={2000}
          className="flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 disabled:bg-gray-50"
          style={{ minHeight: '40px', maxHeight: '120px' }}
        />
        <button
          onClick={submit}
          disabled={!canSend}
          className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Send"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
