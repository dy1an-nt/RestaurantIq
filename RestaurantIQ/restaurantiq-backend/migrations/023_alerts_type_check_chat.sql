-- 023_alerts_type_check_chat.sql
--
-- Extends alerts.type CHECK to allow 'chat_flagged' — emitted when the chat
-- backend's data layer surfaces a material anomaly during a user question.
-- Follows the exact pattern from 011_alerts_type_check.sql.
--
-- Idempotent.

BEGIN;

-- Sanitize any rows with an unrecognized type so the constraint cannot fail
-- on pre-existing data.
UPDATE alerts
SET type = 'no_sales'
WHERE type NOT IN (
  'no_sales', 'trending_down', 'new_top_performer',
  'unusual_spike', 'traffic_drop', 'chat_flagged'
);

-- Drop any existing version of the constraint before re-adding with the new value.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;

ALTER TABLE alerts
  ADD CONSTRAINT alerts_type_check
  CHECK (type IN (
    'no_sales', 'trending_down', 'new_top_performer',
    'unusual_spike', 'traffic_drop', 'chat_flagged'
  ));

COMMIT;
