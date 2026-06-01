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

// Keep the real squareClient except for the network refresh call.
jest.mock('../squareClient', () => ({
  ...jest.requireActual('../squareClient'),
  refreshAccessToken: jest.fn(),
}));

import { ensureFreshSquareToken } from '../ingestSquare';
import { refreshAccessToken } from '../squareClient';
import { encryptToken, decryptToken } from '../../../lib/tokenCrypto';

const refreshMock = refreshAccessToken as jest.Mock;
const KEY = randomBytes(32).toString('hex');

function creds(overrides: Record<string, any> = {}) {
  return {
    id: 'rest-1',
    square_location_id: 'loc-1',
    square_access_token: encryptToken('stored-access'),
    square_refresh_token: encryptToken('stored-refresh'),
    square_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h
    ...overrides,
  };
}

describe('ensureFreshSquareToken', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env = { ...original };
    process.env.ACTIVE_TOKEN_ENCRYPTION_KEY = KEY;
    delete process.env.LEGACY_TOKEN_ENCRYPTION_KEYS;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    mockUpdateCalls.length = 0;
    mockState.error = null;
    refreshMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('returns the stored token without refreshing when not near expiry', async () => {
    const token = await ensureFreshSquareToken(creds());
    expect(token).toBe('stored-access');
    expect(refreshMock).not.toHaveBeenCalled();
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it('refreshes an expired token and persists the new credentials', async () => {
    const newExpiry = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    refreshMock.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: newExpiry,
    });

    const token = await ensureFreshSquareToken(
      creds({ square_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
    );

    expect(refreshMock).toHaveBeenCalledWith('stored-refresh');
    expect(token).toBe('new-access');

    expect(mockUpdateCalls).toHaveLength(1);
    const { payload } = mockUpdateCalls[0];
    expect(payload.pos_connected).toBe(true);
    expect(payload.square_token_expires_at).toBe(newExpiry);
    expect(decryptToken(payload.square_access_token)).toBe('new-access');
    expect(decryptToken(payload.square_refresh_token)).toBe('new-refresh');
  });

  it('refreshes when within the expiry window', async () => {
    refreshMock.mockResolvedValue({
      accessToken: 'windowed-access',
      refreshToken: 'windowed-refresh',
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });

    const token = await ensureFreshSquareToken(
      creds({ square_token_expires_at: new Date(Date.now() + 60 * 1000).toISOString() }), // +60s
    );
    expect(token).toBe('windowed-access');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('preserves the existing refresh token when Square omits a rotated one', async () => {
    refreshMock.mockResolvedValue({
      accessToken: 'rotated-access',
      refreshToken: null,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });

    await ensureFreshSquareToken(
      creds({ square_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
    );

    const { payload } = mockUpdateCalls[0];
    expect(decryptToken(payload.square_refresh_token)).toBe('stored-refresh');
  });

  it('marks the integration disconnected and throws when refresh fails', async () => {
    refreshMock.mockResolvedValue(null);

    await expect(
      ensureFreshSquareToken(
        creds({ square_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
      ),
    ).rejects.toThrow(/disconnected/);

    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0].payload).toEqual({ pos_connected: false });
  });

  it('disconnects when expired but no refresh token is stored', async () => {
    refreshMock.mockResolvedValue(null); // real impl returns null for null token

    await expect(
      ensureFreshSquareToken(
        creds({
          square_token_expires_at: new Date(Date.now() - 1000).toISOString(),
          square_refresh_token: null,
        }),
      ),
    ).rejects.toThrow(/disconnected/);

    expect(refreshMock).toHaveBeenCalledWith(null);
    expect(mockUpdateCalls[0].payload).toEqual({ pos_connected: false });
  });

  it('migrates legacy-key ciphertext forward on a valid-token read', async () => {
    // Encrypt the access token under an OLD key, then rotate.
    const oldKey = randomBytes(32).toString('hex');
    process.env.ACTIVE_TOKEN_ENCRYPTION_KEY = oldKey;
    const legacyAccess = encryptToken('legacy-access');

    process.env.ACTIVE_TOKEN_ENCRYPTION_KEY = KEY;
    process.env.LEGACY_TOKEN_ENCRYPTION_KEYS = oldKey;

    const token = await ensureFreshSquareToken(
      creds({ square_access_token: legacyAccess }),
    );

    expect(token).toBe('legacy-access');
    expect(refreshMock).not.toHaveBeenCalled();
    // Re-encrypted under the active key and persisted.
    expect(mockUpdateCalls).toHaveLength(1);
    expect(decryptToken(mockUpdateCalls[0].payload.square_access_token)).toBe('legacy-access');
  });
});
