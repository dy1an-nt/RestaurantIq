/**
 * Unit tests for the scheduler tick logic (Sprint L+).
 *
 * leaderElection, syncScheduler, and syncJobs are fully mocked so no pg
 * connection or Supabase calls are made. Tests verify:
 *   - Non-leader instances return early without dispatching.
 *   - Leader calls discoverActiveIntegrations and dispatches syncs.
 *   - Due retry jobs are fetched each tick.
 */

// ── Module-level mocks (must be defined before imports) ──────────────────────

const mockIsLeader = jest.fn(() => false);
const mockVerifyLeadership = jest.fn(async () => false);
const mockAcquireLeadership = jest.fn(async () => false);
const mockReleaseLeadership = jest.fn(async () => {});
const MOCK_INSTANCE_ID = 'test-instance-1';

jest.mock('../leaderElection', () => ({
  isLeader: () => mockIsLeader(),
  verifyLeadership: (...a: any[]) => mockVerifyLeadership(...a),
  acquireLeadership: (...a: any[]) => mockAcquireLeadership(...a),
  releaseLeadership: (...a: any[]) => mockReleaseLeadership(...a),
  INSTANCE_ID: MOCK_INSTANCE_ID,
}));

const mockSyncIntegration = jest.fn(async () => ({ ok: true, status: 'success' }));
const mockDiscoverActiveIntegrations = jest.fn(async () => []);

jest.mock('../../syncScheduler', () => ({
  syncIntegration: (...a: any[]) => mockSyncIntegration(...a),
  discoverActiveIntegrations: (...a: any[]) => mockDiscoverActiveIntegrations(...a),
}));

const mockFindDueRetryJobs = jest.fn(async () => []);

jest.mock('../syncJobs', () => ({
  findDueRetryJobs: (...a: any[]) => mockFindDueRetryJobs(...a),
}));

// Supabase mock: supports the scheduler_state upsert AND the restaurants .select().in() chain
// used when processing retry jobs.
jest.mock('../../../db', () => {
  const makeChainable = (finalValue: any): any => {
    const proxy: any = {
      upsert: () => Promise.resolve({ error: null }),
      select: () => proxy,
      eq: () => proxy,
      in: () => Promise.resolve(finalValue),
      then: (resolve: any, reject: any) => Promise.resolve(finalValue).then(resolve, reject),
    };
    return proxy;
  };
  return {
    supabase: {
      from: (_table: string) => makeChainable({ data: [], error: null }),
    },
  };
});

import { runSchedulerTick } from '../index';

beforeEach(() => {
  mockIsLeader.mockReturnValue(false);
  mockVerifyLeadership.mockResolvedValue(false);
  mockAcquireLeadership.mockResolvedValue(false);
  mockSyncIntegration.mockResolvedValue({ ok: true, status: 'success' } as any);
  mockDiscoverActiveIntegrations.mockResolvedValue([]);
  mockFindDueRetryJobs.mockResolvedValue([]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ── Non-leader ────────────────────────────────────────────────────────────────

describe('runSchedulerTick — non-leader', () => {
  it('returns 0 and does not dispatch any syncs when not the leader', async () => {
    mockIsLeader.mockReturnValue(false);
    mockAcquireLeadership.mockResolvedValue(false);

    const processed = await runSchedulerTick();

    expect(processed).toBe(0);
    expect(mockSyncIntegration).not.toHaveBeenCalled();
    expect(mockDiscoverActiveIntegrations).not.toHaveBeenCalled();
  });
});

// ── Leader ────────────────────────────────────────────────────────────────────

describe('runSchedulerTick — leader', () => {
  beforeEach(() => {
    // Already the leader — verifyLeadership is called (not acquireLeadership).
    mockIsLeader.mockReturnValue(true);
    mockVerifyLeadership.mockResolvedValue(true);
  });

  it('calls findDueRetryJobs on every tick', async () => {
    await runSchedulerTick();
    expect(mockFindDueRetryJobs).toHaveBeenCalled();
  });

  it('discovers integrations and dispatches syncs', async () => {
    mockFindDueRetryJobs.mockResolvedValue([]);
    const fakeRow = {
      id: 'r1', pos_connected: true, square_location_id: 'loc1',
      square_access_token: 'tok', square_refresh_token: null,
      square_token_expires_at: null, delivery_connected: false,
      doordash_store_id: null, doordash_access_token: null,
      doordash_refresh_token: null, doordash_token_expires_at: null,
    };
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: fakeRow as any, provider: 'square' as any },
    ]);

    await runSchedulerTick();

    expect(mockDiscoverActiveIntegrations).toHaveBeenCalled();
    expect(mockSyncIntegration).toHaveBeenCalledWith(fakeRow, 'square', 'scheduled');
  });

  it('returns the number of jobs processed (one integration dispatched)', async () => {
    mockFindDueRetryJobs.mockResolvedValue([]);
    const fakeRow = { id: 'r1', pos_connected: true, square_location_id: 'loc1',
      square_access_token: 'tok', square_refresh_token: null, square_token_expires_at: null,
      delivery_connected: false, doordash_store_id: null, doordash_access_token: null,
      doordash_refresh_token: null, doordash_token_expires_at: null };
    mockDiscoverActiveIntegrations.mockResolvedValue([
      { row: fakeRow as any, provider: 'square' as any },
    ]);

    const count = await runSchedulerTick();

    expect(count).toBe(1);
  });

  it('calls discoverActiveIntegrations even when retries are present', async () => {
    // Even with retry jobs, fresh discovery should still run.
    const retryJob = {
      id: 'job-1', restaurant_id: 'r1', provider: 'square', retry_count: 1,
      next_retry_at: new Date().toISOString(), status: 'pending_retry',
    };
    mockFindDueRetryJobs.mockResolvedValue([retryJob as any]);
    mockDiscoverActiveIntegrations.mockResolvedValue([]);

    await runSchedulerTick();

    expect(mockDiscoverActiveIntegrations).toHaveBeenCalled();
  });
});
