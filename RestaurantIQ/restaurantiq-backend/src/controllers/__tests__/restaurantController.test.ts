// Configurable Supabase results for the two queries createRestaurant runs:
// a pre-insert duplicate check (select→eq→maybeSingle) and the insert
// (insert→select→single).
const mockState = {
  existing: { data: null as any, error: null as any },
  insert: { data: null as any, error: null as any },
};

jest.mock('../../db', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(mockState.existing),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve(mockState.insert),
        }),
      }),
    }),
  },
}));

import { createRestaurant } from '../restaurantController';

function makeRes() {
  const res: any = { statusCode: 200 };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

function makeReq(body: any = {}, sub: string | null = 'user-1') {
  return { body, user: sub ? { sub } : undefined } as any;
}

describe('createRestaurant', () => {
  beforeEach(() => {
    mockState.existing = { data: null, error: null };
    mockState.insert = { data: null, error: null };
  });

  it('creates a restaurant and returns it', async () => {
    mockState.insert = {
      data: { id: 'rest-1', name: 'Bistro', location: 'NYC' },
      error: null,
    };

    const res = makeRes();
    await createRestaurant(makeReq({ name: 'Bistro', location: 'NYC' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      data: { id: 'rest-1', name: 'Bistro', location: 'NYC' },
      error: null,
    });
  });

  it('returns 409 on a Postgres unique violation (23505)', async () => {
    mockState.insert = {
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "restaurants_user_id_key"',
        details: 'Key (user_id)=(user-1) already exists.',
      },
    };

    const res = makeRes();
    await createRestaurant(makeReq({ name: 'Bistro' }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      data: null,
      error: 'A restaurant already exists for this account',
    });
    // No raw Postgres internals leak to the client.
    expect(JSON.stringify(res.body)).not.toContain('unique constraint');
  });

  it('returns 409 when the pre-insert check finds an existing restaurant', async () => {
    mockState.existing = { data: { id: 'existing-1' }, error: null };

    const res = makeRes();
    await createRestaurant(makeReq({ name: 'Bistro' }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('returns a generic 500 for non-unique DB errors without leaking details', async () => {
    mockState.insert = {
      data: null,
      error: { code: '08006', message: 'FATAL: connection failure to db host' },
    };

    const res = makeRes();
    await createRestaurant(makeReq({ name: 'Bistro' }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ data: null, error: 'Failed to create restaurant' });
    expect(JSON.stringify(res.body)).not.toContain('connection failure');
  });

  it('returns 401 when the token has no user id', async () => {
    const res = makeRes();
    await createRestaurant(makeReq({ name: 'Bistro' }, null), res);

    expect(res.statusCode).toBe(401);
  });
});
