/**
 * In-memory Supabase fake for ingestion tests.
 *
 * This is NOT a generic Supabase mock — it faithfully models exactly the query
 * chains that the shared persistence layer (../persistence.ts) and the DoorDash
 * ingest entry point (../../doordash/ingestDoorDash.ts) actually call, with the
 * real semantics that matter for correctness:
 *
 *   - insert([...]).select('...')            → returns inserted rows w/ generated id
 *   - insert({...}).select('...').single()   → returns the single inserted row
 *   - upsert(rows, { onConflict: 'a,b,c' })  → updates rows that collide on the
 *                                              conflict tuple, inserts the rest
 *                                              (this is what makes re-sync idempotent)
 *   - select('...').eq().eq().in()           → filtered read (awaitable → {data,error})
 *   - select('...').eq().maybeSingle()/single()
 *   - update({...}).eq()                     → mutate matching rows
 *   - delete().eq().gte() / .in()            → remove matching rows
 *
 * Because re-sync idempotency hinges on upsert-conflict + insert-dedup behaving
 * like Postgres, those are modeled precisely. Filters supported: eq, in, gte.
 *
 * The fake is attached as the `supabase` export via jest.mock; tests reach into
 * it through the helpers hung off the returned client:
 *   (supabase as any).__reset()
 *   (supabase as any).__seed('restaurants', [ {...} ])
 *   (supabase as any).__rows('orders')
 */

type Row = Record<string, any>;

interface Filter {
  kind: 'eq' | 'in' | 'gte';
  col: string;
  val: any;
}

interface Store {
  tables: Record<string, Row[]>;
  seq: number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const matches = (row: Row, filters: Filter[]): boolean =>
  filters.every((f) => {
    if (f.kind === 'eq') return row[f.col] === f.val;
    if (f.kind === 'in') return (f.val as any[]).includes(row[f.col]);
    if (f.kind === 'gte') return row[f.col] >= f.val;
    return true;
  });

class QueryBuilder implements PromiseLike<{ data: any; error: any }> {
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | null = null;
  private payload: any = undefined;
  private onConflict: string | undefined;
  private filters: Filter[] = [];
  private returning = false;
  private limitN: number | undefined;

  constructor(private store: Store, private table: string) {}

  private rows(): Row[] {
    return (this.store.tables[this.table] ??= []);
  }

  private nextId(prefix: string): string {
    this.store.seq += 1;
    return `${prefix}-${this.store.seq}`;
  }

  // ── op setters ────────────────────────────────────────────────────────────
  select(_cols?: string) {
    if (this.op === null) this.op = 'select';
    else this.returning = true; // .insert(...).select(...) / .update(...).select(...)
    return this;
  }
  insert(payload: any) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  upsert(payload: any, opts?: { onConflict?: string }) {
    this.op = 'upsert';
    this.payload = payload;
    this.onConflict = opts?.onConflict;
    return this;
  }
  update(payload: any) {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }

  // ── filters / modifiers ───────────────────────────────────────────────────
  eq(col: string, val: any) {
    this.filters.push({ kind: 'eq', col, val });
    return this;
  }
  in(col: string, val: any[]) {
    this.filters.push({ kind: 'in', col, val });
    return this;
  }
  gte(col: string, val: any) {
    this.filters.push({ kind: 'gte', col, val });
    return this;
  }
  order(_col: string, _opts?: any) {
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  // ── terminators ───────────────────────────────────────────────────────────
  maybeSingle() {
    return this.execute('maybeSingle');
  }
  single() {
    return this.execute('single');
  }
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute('many').then(onfulfilled, onrejected);
  }

  // ── execution ─────────────────────────────────────────────────────────────
  private async execute(
    cardinality: 'many' | 'single' | 'maybeSingle',
  ): Promise<{ data: any; error: any }> {
    let result: Row[] = [];

    switch (this.op) {
      case 'select': {
        result = this.rows().filter((r) => matches(r, this.filters)).map(clone);
        if (this.limitN !== undefined) result = result.slice(0, this.limitN);
        break;
      }
      case 'insert': {
        const incoming: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted = incoming.map((r) => {
          const withId = { id: r.id ?? this.nextId(this.table), ...clone(r) };
          this.rows().push(withId);
          return clone(withId);
        });
        result = inserted;
        break;
      }
      case 'upsert': {
        const incoming: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
        const conflictCols = (this.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
        const upserted: Row[] = [];
        for (const r of incoming) {
          let existing: Row | undefined;
          if (conflictCols.length > 0) {
            existing = this.rows().find((row) =>
              conflictCols.every((c) => row[c] === r[c]),
            );
          }
          if (existing) {
            Object.assign(existing, clone(r)); // update-in-place: keeps the original id
            upserted.push(clone(existing));
          } else {
            const withId = { id: r.id ?? this.nextId(this.table), ...clone(r) };
            this.rows().push(withId);
            upserted.push(clone(withId));
          }
        }
        result = upserted;
        break;
      }
      case 'update': {
        const updated: Row[] = [];
        for (const row of this.rows()) {
          if (matches(row, this.filters)) {
            Object.assign(row, clone(this.payload));
            updated.push(clone(row));
          }
        }
        result = updated;
        break;
      }
      case 'delete': {
        const keep: Row[] = [];
        for (const row of this.rows()) {
          if (matches(row, this.filters)) result.push(clone(row));
          else keep.push(row);
        }
        this.store.tables[this.table] = keep;
        break;
      }
      default:
        result = [];
    }

    // Mutations that didn't request `.select(...)` resolve to { data: null }.
    const exposeData =
      this.op === 'select' || this.returning || cardinality !== 'many';

    if (!exposeData) return { data: null, error: null };

    if (cardinality === 'single') {
      if (result.length === 0) {
        return { data: null, error: { message: 'no rows returned', code: 'PGRST116' } };
      }
      return { data: result[0], error: null };
    }
    if (cardinality === 'maybeSingle') {
      return { data: result[0] ?? null, error: null };
    }
    return { data: result, error: null };
  }
}

export interface FakeSupabase {
  from(table: string): QueryBuilder;
  __reset(): void;
  __seed(table: string, rows: Row[]): void;
  __rows(table: string): Row[];
  __tables: Record<string, Row[]>;
}

/** Build a fresh in-memory Supabase fake. */
export const createFakeSupabase = (): FakeSupabase => {
  const store: Store = { tables: {}, seq: 0 };

  const api: FakeSupabase = {
    from: (table: string) => new QueryBuilder(store, table),
    __reset: () => {
      store.tables = {};
      store.seq = 0;
    },
    __seed: (table: string, rows: Row[]) => {
      (store.tables[table] ??= []).push(...rows.map(clone));
    },
    __rows: (table: string) => (store.tables[table] ?? []).map(clone),
    get __tables() {
      return store.tables;
    },
  };

  return api;
};
