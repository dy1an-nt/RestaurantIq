/**
 * Tests for DoorDash's proactive token-refresh path (ensureFreshToken).
 *
 * Sprint K goal #1 — parity with Square's ensureFreshSquareToken coverage, plus
 * goal #1's "error handling and retry behavior". Note a DELIBERATE behavioral
 * difference from Square, pinned here so it can't regress unnoticed:
 *
 *   Square: a failed refresh marks the integration disconnected and THROWS.
 *   DoorDash: a failed refresh logs and FALLS BACK to the existing token, letting
 *             the subsequent API call surface a clean 401 instead of failing the
 *             sync opaquely at the token step.
 *
 * See docs/weekly-summary/week-K-findings.md for why these differ.
 */
import { randomBytes } from 'crypto';

// Capture every restaurants update so tests can assert what gets persisted.
const mockUpdateCalls: Array<{ payload: any; id: string }> = [];
const mockState = { error: null as any };

jest.mock('../../../db', () => ({
  supabase: {
    from: (_table: string) => ({
      update: (payload: any) => ({
        eq: (_col: string, id: string) => {
          mockUpdateCalls.push({ payload, id });
          return Promise.resolve({ error: mockState.error });
        },
      }),
    }),
  },
}));

// Keep the real doordashClient except for the network refresh call.
jest.mock('../doordashClient', () => ({
  ...jest.requireActual('../doordashClient'),
  refreshAccessToken: jest.fn(),
}));

import { ensureFreshToken } from '../ingestDoorDash';
import { refreshAccessToken } from '../doordashClient';
import { encryptToken, decryptToken } from '../../../lib/tokenCrypto';

const refreshMock = refreshAccessToken as jest.Mock;
const KEY = randomBytes(32).toString('hex');

function creds(overrides: Record<string, any> = {}) {
  return {
    id: 'rest-1',
    doordash_store_id: 'st-1',
    doordash_access_token: encryptToken('stored-access'),
    doordash_refresh_token: encryptToken('stored-refresh'),
    doordash_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h
    ...overrides,
  };
}

describe('ensureFreshToken (DoorDash)', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env = { ...original };
    process.env.ACTIVE_TOKEN_ENCRYPTION_KEY = KEY;
    delete process.env.LEGACY_TOKEN_ENCRYPTION_KEYS;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.USE_MOCK;
    mockUpdateCalls.length = 0;
    mockState.error = null;
    refreshMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('returns the stored token without refreshing when not near expiry', async () => {
    const token = await ensureFreshToken(creds());
    expect(token).toBe('stored-access');
    expect(refreshMock).not.toHaveBeenCalled();
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it('returns the stored token when no expiry is recorded (cannot prove staleness)', async () => {
    const token = await ensureFreshToken(creds({ doordash_token_expires_at: null }));
    expect(token).toBe('stored-access');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the new access token + expiry', async () => {
    const newExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
    refreshMock.mockResolvedValue({ accessToken: 'new-access', expiresAt: newExpiry });

    const token = await ensureFreshToken(
      creds({ doordash_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
    );

    expect(refreshMock).toHaveBeenCalledWith('stored-refresh');
    expect(token).toBe('new-access');

    expect(mockUpdateCalls).toHaveLength(1);
    const { payload, id } = mockUpdateCalls[0];
    expect(id).toBe('rest-1');
    expect(payload.doordash_token_expires_at).toBe(newExpiry);
    expect(decryptToken(payload.doordash_access_token)).toBe('new-access');
  });

  it('refreshes when within the 60s expiry skew window', async () => {
    refreshMock.mockResolvedValue({
      accessToken: 'windowed-access',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    const token = await ensureFreshToken(
      creds({ doordash_token_expires_at: new Date(Date.now() + 30 * 1000).toISOString() }), // +30s
    );
    expect(token).toBe('windowed-access');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('falls back to the existing token (no throw, no persist) when refresh is unavailable', async () => {
    refreshMock.mockResolvedValue(null);

    const token = await ensureFreshToken(
      creds({ doordash_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
    );

    // DoorDash deliberately does NOT throw/disconnect here — it returns the stale
    // token so the API call can surface a clean 401.
    expect(token).toBe('stored-access');
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it('passes a null refresh token through when none is stored', async () => {
    refreshMock.mockResolvedValue(null);

    const token = await ensureFreshToken(
      creds({
        doordash_token_expires_at: new Date(Date.now() - 1000).toISOString(),
        doordash_refresh_token: null,
      }),
    );

    expect(refreshMock).toHaveBeenCalledWith(null);
    expect(token).toBe('stored-access');
  });

  it('still returns the refreshed token even if persisting it fails', async () => {
    mockState.error = { message: 'db write failed' };
    refreshMock.mockResolvedValue({
      accessToken: 'new-access',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    const token = await ensureFreshToken(
      creds({ doordash_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
    );

    expect(token).toBe('new-access'); // persistence failure must not break the sync
    expect(mockUpdateCalls).toHaveLength(1);
  });
});
