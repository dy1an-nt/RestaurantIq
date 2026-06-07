import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../components/auth/AuthContext';
import {
  listConversations, createConversation, getMessages,
  sendMessage, renameConversation, deleteConversation,
  Conversation, ChatMessage,
} from '../lib/chatApi';
import MessageThread from '../components/chat/MessageThread';
import Composer from '../components/chat/Composer';
import DailyCapBanner from '../components/chat/DailyCapBanner';
import Icon from '../components/Icons';

export default function Chat() {
  const { session } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleInput, setTitleInput] = useState('');
  const [capHit, setCapHit] = useState(false);

  const loadConversations = useCallback(async () => {
    if (!session) return;
    try {
      const convs = await listConversations(session);
      setConversations(convs);
    } catch {
      // silent
    } finally {
      setLoadingConvs(false);
    }
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    if (session) {
      listConversations(session)
        .then((c) => { if (!cancelled) { setConversations(c); setLoadingConvs(false); } })
        .catch(() => { if (!cancelled) setLoadingConvs(false); });
    }
    return () => { cancelled = true; };
  }, [session]);

  async function selectConversation(id: string) {
    if (!session) return;
    setActiveId(id);
    setLoadingMsgs(true);
    setError(null);
    try {
      const { messages: msgs } = await getMessages(session, id);
      setMessages(msgs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load messages');
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function handleNewChat() {
    if (!session) return;
    try {
      const conv = await createConversation(session);
      await loadConversations();
      await selectConversation(conv.id);
    } catch {
      setError('Failed to create conversation');
    }
  }

  async function handleSend(content: string) {
    if (!session || !activeId) return;
    setSending(true);
    setError(null);
    try {
      const { message, usage } = await sendMessage(session, activeId, content);
      setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content, context_meta: {}, created_at: new Date().toISOString() }, message]);
      if (usage.messages_today >= usage.daily_cap) setCapHit(true);
      await loadConversations();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  async function handleDelete(id: string) {
    if (!session || !confirm('Delete this conversation?')) return;
    try {
      await deleteConversation(session, id);
      if (activeId === id) { setActiveId(null); setMessages([]); }
      await loadConversations();
    } catch {
      setError('Failed to delete conversation');
    }
  }

  async function saveTitle(id: string) {
    if (!session || !titleInput.trim()) { setEditingTitle(null); return; }
    try {
      await renameConversation(session, id, titleInput.trim());
      await loadConversations();
    } catch {
      // ignore
    } finally {
      setEditingTitle(null);
    }
  }

  const activeConv = conversations.find((c) => c.id === activeId);

  function relativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  return (
    <div className="flex h-[calc(100vh-120px)] gap-4">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 flex flex-col bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-3 border-b border-gray-100">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            <Icon name="chat" size={15} />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingConvs ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="p-4 text-xs text-gray-400 text-center">
              No conversations yet — start a new chat
            </p>
          ) : (
            <ul className="p-2 space-y-0.5">
              {conversations.map((conv) => (
                <li key={conv.id}>
                  <button
                    onClick={() => selectConversation(conv.id)}
                    className={`group w-full flex items-start gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                      activeId === conv.id ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium truncate">{conv.title}</span>
                      <span className="block text-[11px] text-gray-400 mt-0.5">{relativeTime(conv.updated_at)}</span>
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(conv.id); }}
                      className="opacity-0 group-hover:opacity-100 mt-0.5 text-gray-300 hover:text-red-400 transition-all flex-shrink-0"
                      aria-label="Delete"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                      </svg>
                    </button>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col bg-white rounded-xl border border-gray-200 overflow-hidden min-w-0">
        {!activeId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <Icon name="chat" size={40} className="text-gray-200 mb-3" />
            <p className="text-sm text-gray-500 font-medium">Select a conversation or start a new one</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
              {editingTitle === activeId ? (
                <input
                  autoFocus
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onBlur={() => saveTitle(activeId)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(activeId); if (e.key === 'Escape') setEditingTitle(null); }}
                  className="flex-1 text-sm font-semibold border-b border-indigo-400 focus:outline-none bg-transparent"
                  maxLength={120}
                />
              ) : (
                <button
                  onClick={() => { setEditingTitle(activeId); setTitleInput(activeConv?.title ?? ''); }}
                  className="flex-1 text-left text-sm font-semibold text-gray-800 truncate hover:text-indigo-600 transition-colors"
                >
                  {activeConv?.title ?? 'Conversation'}
                </button>
              )}
            </div>

            <DailyCapBanner />

            {error && (
              <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-red-50 text-xs text-red-600">{error}</div>
            )}

            {loadingMsgs ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-gray-400">Loading…</p>
              </div>
            ) : (
              <MessageThread messages={messages} isLoading={sending} />
            )}

            <Composer onSend={handleSend} disabled={sending || capHit || loadingMsgs} />
          </>
        )}
      </div>
    </div>
  );
}
