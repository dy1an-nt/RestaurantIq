/**
 * Unit tests for leader election (Sprint L+).
 *
 * pg is mocked so no real Postgres connection is made. supabase is also mocked
 * so scheduler_state writes don't hit the network. All tests reset module state
 * between runs via jest.isolateModules().
 */

// ── pg mock — must be prefixed `mock` for jest.mock factory ─────────────────

const mockQueryResults: boolean[] = [];
let mockConnectShouldFail = false;
let mockClientEndHandler: (() => void) | null = null;
let mockClientErrorHandler: ((err: Error) => void) | null = null;

const mockClientInstance = {
  connect: jest.fn(async () => {
    if (mockConnectShouldFail) throw new Error('Connection refused');
  }),
  query: jest.fn(async (_text: string, _params?: any[]) => {
    const granted = mockQueryResults.length ? mockQueryResults.shift() : true;
    return { rows: [{ pg_try_advisory_lock: granted }] };
  }),
  end: jest.fn(async () => {}),
  on: jest.fn((event: string, handler: any) => {
    if (event === 'error') mockClientErrorHandler = handler;
    if (event === 'end') mockClientEndHandler = handler;
  }),
};

jest.mock('pg', () => ({
  Client: jest.fn(() => mockClientInstance),
}));

jest.mock('../../../db', () => ({
  supabase: {
    from: () => ({
      upsert: () => ({ error: null }),
    }),
  },
}));

// Silence structured error logs during tests.
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockQueryResults.length = 0;
  mockConnectShouldFail = false;
  mockClientEndHandler = null;
  mockClientErrorHandler = null;
  mockClientInstance.connect.mockClear();
  mockClientInstance.query.mockClear();
  mockClientInstance.end.mockClear();
  mockClientInstance.on.mockClear();
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// We must re-import the module fresh for each test group because the module
// holds _isLeader / _client state at module level.
describe('acquireLeadership — DATABASE_URL set', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test';
  });
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('grants leadership when pg_try_advisory_lock returns true', async () => {
    mockQueryResults.push(true);
    jest.resetModules();
    const { acquireLeadership, isLeader } = await import('../leaderElection');

    const result = await acquireLeadership();

    expect(result).toBe(true);
    expect(isLeader()).toBe(true);
  });

  it('denies leadership when pg_try_advisory_lock returns false', async () => {
    mockQueryResults.push(false);
    jest.resetModules();
    const { acquireLeadership, isLeader } = await import('../leaderElection');

    const result = await acquireLeadership();

    expect(result).toBe(false);
    expect(isLeader()).toBe(false);
  });

  it('returns false and sets isLeader=false when pg connect fails', async () => {
    mockConnectShouldFail = true;
    jest.resetModules();
    const { acquireLeadership, isLeader } = await import('../leaderElection');

    const result = await acquireLeadership();

    expect(result).toBe(false);
    expect(isLeader()).toBe(false);
  });
});

describe('acquireLeadership — no DATABASE_URL (sole-leader fallback)', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('treats the instance as leader without opening a pg connection', async () => {
    jest.resetModules();
    const { acquireLeadership, isLeader } = await import('../leaderElection');

    const result = await acquireLeadership();

    expect(result).toBe(true);
    expect(isLeader()).toBe(true);
    // pg.Client should not have been constructed.
    const { Client } = await import('pg');
    expect(Client).not.toHaveBeenCalled();
  });
});

describe('client end event → leadership lost', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test';
  });
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('sets isLeader=false when the pg client fires end', async () => {
    mockQueryResults.push(true); // grant leadership
    jest.resetModules();
    const { acquireLeadership, isLeader } = await import('../leaderElection');

    await acquireLeadership();
    expect(isLeader()).toBe(true);

    // Simulate the client disconnecting.
    if (mockClientEndHandler) mockClientEndHandler();

    expect(isLeader()).toBe(false);
  });
});

describe('verifyLeadership', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test';
  });
  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns true when already leader and SELECT 1 succeeds', async () => {
    // Grant on acquire, then SELECT 1 on verify.
    mockQueryResults.push(true);
    mockClientInstance.query.mockImplementation(async (text: string) => {
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ pg_try_advisory_lock: true }] };
      return { rows: [{ '?column?': 1 }] }; // SELECT 1
    });
    jest.resetModules();
    const { acquireLeadership, verifyLeadership, isLeader } = await import('../leaderElection');

    await acquireLeadership();
    expect(isLeader()).toBe(true);

    const verified = await verifyLeadership();
    expect(verified).toBe(true);
    expect(isLeader()).toBe(true);
  });
});
