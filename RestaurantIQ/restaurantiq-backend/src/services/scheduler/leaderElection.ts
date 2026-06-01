/**
 * Leader election for the distributed sync scheduler (Sprint L+).
 *
 * WHY a dedicated pg.Client instead of supabase-js:
 *   supabase-js talks to Supabase via PostgREST over HTTP. Each query goes
 *   through a connection pool — there is no persistent session. Postgres
 *   session-level advisory locks (pg_try_advisory_lock) are tied to a single
 *   session: if the session returns to the pool the lock is immediately
 *   released. We therefore open ONE long-lived pg.Client and keep it open for
 *   the process lifetime. Only that client holds the advisory lock.
 *
 * Graceful fallback:
 *   If DATABASE_URL is unset (dev/test, USE_MOCK=true), we skip the pg layer,
 *   log a one-time warning, and treat this instance as the sole leader. This
 *   preserves the single-instance dev experience exactly as before.
 *
 * Failover:
 *   The client's 'error' and 'end' events set isLeader=false immediately so
 *   the next scheduler tick calls acquireLeadership() and the surviving
 *   instance can re-elect itself (or a peer beats it to the lock first).
 */

import os from 'os';
import { Client } from 'pg';
import { supabase } from '../../db';
import { logEvent } from './logger';

/** Arbitrary large integer used as the advisory lock key. Must be consistent
 *  across all instances — changing it while a lock is held abandons the old
 *  lock (fine on next boot). */
const LEADER_LOCK_KEY = 987654321;

/** Human-readable identity of this process, visible in scheduler_state. */
export const INSTANCE_ID =
  process.env.INSTANCE_ID ?? `${os.hostname()}-${process.pid}`;

// ── Internal state ──────────────────────────────────────────────────────────

let _isLeader = false;
let _client: Client | null = null;
let _noDbWarningEmitted = false;
/** True when DATABASE_URL is absent — this instance is always the leader. */
let _noDatabaseUrl = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

const hasDatabaseUrl = (): boolean => !!process.env.DATABASE_URL;

const makeClient = (): Client =>
  new Client({ connectionString: process.env.DATABASE_URL });

/** Attach lifecycle handlers so a dropped connection relinquishes leadership
 *  immediately, before the next tick notices. */
const attachClientHandlers = (client: Client): void => {
  client.on('error', (err) => {
    console.error(
      JSON.stringify({ event: 'LEADER_CLIENT_ERROR', ts: new Date().toISOString(), error: err.message }),
    );
    _isLeader = false;
    _client = null;
  });
  client.on('end', () => {
    _isLeader = false;
    _client = null;
  });
};

/** Upsert the scheduler_state singleton to record which instance is the
 *  current leader. Fire-and-forget — failure here is non-fatal. */
const recordLeaderInDb = async (): Promise<void> => {
  const { error } = await supabase.from('scheduler_state').upsert(
    {
      id: 1,
      leader_instance_id: INSTANCE_ID,
      leader_acquired_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) {
    console.error(
      JSON.stringify({ event: 'SCHEDULER_STATE_WRITE_FAILED', ts: new Date().toISOString(), error: error.message }),
    );
  }
};

// ── Public API ───────────────────────────────────────────────────────────────

/** Whether this instance currently holds the leader lock. */
export const isLeader = (): boolean => _isLeader;

/**
 * Try to become the leader. Opens a pg.Client if one doesn't exist, then
 * calls pg_try_advisory_lock. The lock lives as long as the session lives.
 *
 * Returns true if this instance is now the leader (either just acquired or
 * already held from a previous call).
 */
export const acquireLeadership = async (): Promise<boolean> => {
  // ── No-DATABASE_URL fallback ────────────────────────────────────────────
  if (!hasDatabaseUrl()) {
    if (!_noDbWarningEmitted) {
      console.error(
        JSON.stringify({
          event: 'LEADER_FALLBACK',
          ts: new Date().toISOString(),
          warning:
            'DATABASE_URL not set — treating this instance as sole leader. ' +
            'Set DATABASE_URL to enable distributed leader election.',
        }),
      );
      _noDbWarningEmitted = true;
    }
    _noDatabaseUrl = true;
    _isLeader = true;
    return true;
  }

  // ── Normal path: try advisory lock ─────────────────────────────────────
  try {
    if (!_client) {
      _client = makeClient();
      attachClientHandlers(_client);
      await _client.connect();
    }

    const result = await _client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [LEADER_LOCK_KEY],
    );
    const granted = result.rows[0]?.pg_try_advisory_lock === true;

    if (granted) {
      _isLeader = true;
      logEvent('LEADER_ACQUIRED', { instanceId: INSTANCE_ID });
      await recordLeaderInDb();
    }

    return granted;
  } catch (err: any) {
    console.error(
      JSON.stringify({
        event: 'LEADER_ACQUIRE_ERROR',
        ts: new Date().toISOString(),
        error: err?.message,
      }),
    );
    _isLeader = false;
    _client = null;
    return false;
  }
};

/**
 * Verify the existing pg session is still alive (SELECT 1). If the client
 * has gone away, try to reconnect and re-acquire the lock so leadership
 * transfers after a crash/restart.
 *
 * Returns true if this instance is the leader after the check.
 */
export const verifyLeadership = async (): Promise<boolean> => {
  if (_noDatabaseUrl) return true; // fallback — always leader

  if (!_isLeader || !_client) {
    // Either we never had it or the client died — try to acquire.
    return acquireLeadership();
  }

  try {
    await _client.query('SELECT 1');
    return true; // session healthy, lock still held
  } catch {
    // Session dead — clear state and attempt re-election.
    _isLeader = false;
    _client = null;
    return acquireLeadership();
  }
};

/**
 * Release the advisory lock and close the pg session. Called on graceful
 * shutdown so a standby instance can take over immediately instead of waiting
 * for the stale-lock window.
 */
export const releaseLeadership = async (): Promise<void> => {
  if (_noDatabaseUrl) {
    _isLeader = false;
    return;
  }

  if (!_client) {
    _isLeader = false;
    return;
  }

  try {
    await _client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
    logEvent('LEADER_LOST', { instanceId: INSTANCE_ID });
  } catch (err: any) {
    console.error(
      JSON.stringify({
        event: 'LEADER_RELEASE_ERROR',
        ts: new Date().toISOString(),
        error: err?.message,
      }),
    );
  } finally {
    _isLeader = false;
    try { await _client.end(); } catch { /* ignore */ }
    _client = null;
  }
};
