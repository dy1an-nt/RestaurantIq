/**
 * Structured event logger for the distributed sync scheduler (Sprint L+).
 *
 * All scheduler events are emitted as JSON lines to stderr (console.error),
 * which keeps them out of stdout and lets log aggregators (Railway, Datadog,
 * etc.) parse fields without regex. Every line has at minimum an `event` name
 * and an ISO timestamp so logs can be correlated across instances.
 *
 * Using console.error (not console.log) is required by CLAUDE.md conventions.
 */

/** Union of every observable event in the scheduler lifecycle. */
export type SchedulerEvent =
  | 'LEADER_ACQUIRED'
  | 'LEADER_LOST'
  | 'SCHEDULER_TICK'
  | 'SYNC_STARTED'
  | 'SYNC_COMPLETED'
  | 'SYNC_FAILED'
  | 'RETRY_SCHEDULED'
  | 'RETRY_EXECUTED'
  | 'LOCK_ACQUIRED'
  | 'LOCK_RELEASED';

/**
 * Emit a structured JSON log line to stderr.
 *
 * @param event  - one of the defined SchedulerEvent names
 * @param fields - optional extra key/value pairs merged into the JSON object
 */
export const logEvent = (
  event: SchedulerEvent,
  fields?: Record<string, unknown>,
): void => {
  console.error(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
};
