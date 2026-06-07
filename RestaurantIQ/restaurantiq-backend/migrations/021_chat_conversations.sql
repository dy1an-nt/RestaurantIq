-- 021_chat_conversations.sql
--
-- Sprint P: persistent multi-turn AI chat over restaurant data.
--
-- Two tables:
--   chat_conversations  — one row per conversation thread
--   chat_messages       — one row per message (user or assistant)
--
-- Tenant scoping: every row carries restaurant_id. All API queries filter by
-- restaurant_id resolved from req.user.sub before joining anything else.
-- restaurant_id is denormalized on chat_messages so tenancy checks never
-- require a join (same pattern alerts uses).
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS chat_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'New conversation',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default list order on the sidebar: newest activity first, per tenant.
CREATE INDEX IF NOT EXISTS chat_conversations_restaurant_updated_idx
  ON chat_conversations (restaurant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- JSON describing which data the backend pulled to ground the assistant reply.
  -- Empty {} for user messages.
  context_meta    JSONB NOT NULL DEFAULT '{}',
  -- Anthropic usage accounting for cost auditing. Null on user messages.
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary access pattern: load all messages for a conversation in order.
CREATE INDEX IF NOT EXISTS chat_messages_conversation_created_idx
  ON chat_messages (conversation_id, created_at ASC);

-- Supports the daily message-cap check (per-restaurant per-day user message count).
CREATE INDEX IF NOT EXISTS chat_messages_restaurant_role_created_idx
  ON chat_messages (restaurant_id, role, created_at DESC);

COMMIT;
