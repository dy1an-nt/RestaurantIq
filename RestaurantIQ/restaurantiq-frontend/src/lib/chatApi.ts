import { Session } from '@supabase/supabase-js';
import { apiFetch } from './api';

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  context_meta: {
    summaries_count?: number;
    orders_count?: number;
    menu_items_count?: number;
    date_range?: { from: string; to: string };
  };
  created_at: string;
}

export interface ChatUsage {
  messages_today: number;
  daily_cap: number;
  resets_at: string;
}

async function parseBody<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data as T;
}

export async function listConversations(_session: Session): Promise<Conversation[]> {
  const res = await apiFetch('/api/chat/conversations');
  const data = await parseBody<{ conversations: Conversation[] }>(res);
  return data.conversations;
}

export async function createConversation(_session: Session, title?: string): Promise<Conversation> {
  const res = await apiFetch('/api/chat/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  const data = await parseBody<{ conversation: Conversation }>(res);
  return data.conversation;
}

export async function getMessages(
  _session: Session,
  conversationId: string,
): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
  const res = await apiFetch(`/api/chat/conversations/${conversationId}/messages`);
  return parseBody<{ conversation: Conversation; messages: ChatMessage[] }>(res);
}

export async function sendMessage(
  _session: Session,
  conversationId: string,
  content: string,
): Promise<{ message: ChatMessage; usage: ChatUsage }> {
  const res = await apiFetch(`/api/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  return parseBody<{ message: ChatMessage; usage: ChatUsage }>(res);
}

export async function renameConversation(
  _session: Session,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  const res = await apiFetch(`/api/chat/conversations/${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  const data = await parseBody<{ conversation: Conversation }>(res);
  return data.conversation;
}

export async function deleteConversation(_session: Session, conversationId: string): Promise<void> {
  const res = await apiFetch(`/api/chat/conversations/${conversationId}`, { method: 'DELETE' });
  await parseBody<{ deleted: boolean }>(res);
}

export async function getChatUsage(_session: Session): Promise<ChatUsage> {
  const res = await apiFetch('/api/chat/usage');
  return parseBody<ChatUsage>(res);
}
