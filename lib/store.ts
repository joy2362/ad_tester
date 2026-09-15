import type { RedisClientType } from "redis";

/**
 * Generic Redis-or-memory keyed-record store, shared by lib/db.ts (ad-tag runs)
 * and lib/siteDb.ts (site-check batches). See lib/db.ts's original comment for
 * why: Vercel's filesystem is read-only, so Redis (via node-redis, using
 * REDIS_URL) is the persistent option; an in-process Map is the fallback for
 * local dev or when Redis is unset/unreachable.
 */

export interface KeyedRecord {
  id: string;
  createdAt: number;
}

export interface RecordStore<T extends KeyedRecord> {
  kind: "redis" | "memory";
  insert(record: T): Promise<void>;
  get(id: string): Promise<T | null>;
  remove(id: string): Promise<boolean>;
  list(limit: number): Promise<T[]>;
}

export interface StoreOptions<T extends KeyedRecord> {
  /** Redis key prefix for individual records, e.g. "adtester:run:". */
  keyPrefix: string;
  /** Redis sorted-set key holding the recency index. */
  indexKey: string;
  maxRecords?: number;
  ttlSeconds?: number;
  maxValueBytes?: number;
  /**
   * Applied in order, most-important-data-first, until the serialized record
   * fits maxValueBytes — e.g. drop a screenshot, then drop body previews too.
   */
  shrinkSteps?: Array<(record: T) => T>;
}

const redisUrl = process.env.REDIS_URL || process.env.KV_URL || "";

function createMemoryStore<T extends KeyedRecord>(maxRecords: number): RecordStore<T> {
  const map = new Map<string, T>();
  return {
    kind: "memory",
    async insert(record) {
      map.set(record.id, record);
      if (map.size > maxRecords) {
        const oldest = [...map.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) map.delete(oldest.id);
      }
    },
    async get(id) {
      return map.get(id) ?? null;
    },
    async remove(id) {
      return map.delete(id);
    },
    async list(limit) {
      return [...map.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
  };
}

function createRedisStore<T extends KeyedRecord>(
  url: string,
  opts: Required<Pick<StoreOptions<T>, "keyPrefix" | "indexKey" | "maxRecords" | "ttlSeconds" | "maxValueBytes">> & {
    shrinkSteps: Array<(record: T) => T>;
  },
): RecordStore<T> {
  let clientPromise: Promise<RedisClientType> | null = null;

  async function client(): Promise<RedisClientType> {
    if (!clientPromise) {
      // Dynamic import so the `redis` package is never needed at route
      // module-load time — a bundling/resolution miss degrades to a caught
      // runtime error instead of crashing the whole function.
      clientPromise = import("redis")
        .then(async ({ createClient }) => {
          const c = createClient({
            url,
            // Fail fast: bound the initial connect and give up after a few
            // retries instead of blocking the request until the function times out.
            socket: {
              connectTimeout: 4000,
              reconnectStrategy: (retries) => (retries > 3 ? false : Math.min(retries * 200, 800)),
            },
          }) as RedisClientType;
          c.on("error", (err) => console.error(`redis client error [${opts.keyPrefix}]:`, err));
          const connecting = c.connect();
          connecting.catch(() => {}); // avoid an unhandled rejection if the race times out first
          await Promise.race([
            connecting,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("redis connect timed out")), 5000),
            ),
          ]);
          return c;
        })
        .catch((err) => {
          clientPromise = null;
          throw err;
        });
    }
    return clientPromise;
  }

  function serialize(record: T): string {
    let current = record;
    let json = JSON.stringify(current);
    for (const shrink of opts.shrinkSteps) {
      if (json.length <= opts.maxValueBytes) break;
      current = shrink(current);
      json = JSON.stringify(current);
    }
    return json;
  }

  function parse(raw: string | null): T | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  return {
    kind: "redis",
    async insert(record) {
      const c = await client();
      await c.set(opts.keyPrefix + record.id, serialize(record), { EX: opts.ttlSeconds });
      await c.zAdd(opts.indexKey, { score: record.createdAt, value: record.id });
      await c.zRemRangeByRank(opts.indexKey, 0, -(opts.maxRecords + 1));
    },
    async get(id) {
      const c = await client();
      return parse(await c.get(opts.keyPrefix + id));
    },
    async remove(id) {
      const c = await client();
      const removed = await c.del(opts.keyPrefix + id);
      await c.zRem(opts.indexKey, id);
      return removed > 0;
    },
    async list(limit) {
      const c = await client();
      const ids = await c.zRange(opts.indexKey, 0, limit - 1, { REV: true });
      if (!ids.length) return [];
      const raws = await c.mGet(ids.map((id) => opts.keyPrefix + id));
      return raws.map(parse).filter((r): r is T => Boolean(r));
    },
  };
}

export interface BoundStore<T extends KeyedRecord> {
  kind: "redis" | "memory";
  insert(record: T): Promise<void>;
  get(id: string): Promise<T | null>;
  remove(id: string): Promise<boolean>;
  list(limit?: number): Promise<T[]>;
}

export function createRecordStore<T extends KeyedRecord>(options: StoreOptions<T>): BoundStore<T> {
  const maxRecords = options.maxRecords ?? 200;
  const ttlSeconds = options.ttlSeconds ?? 60 * 60 * 24 * 30;
  const maxValueBytes = options.maxValueBytes ?? 1_000_000;
  const shrinkSteps = options.shrinkSteps ?? [];

  const fallback = createMemoryStore<T>(maxRecords);
  let primary: RecordStore<T>;
  try {
    primary = redisUrl
      ? createRedisStore<T>(redisUrl, {
          keyPrefix: options.keyPrefix,
          indexKey: options.indexKey,
          maxRecords,
          ttlSeconds,
          maxValueBytes,
          shrinkSteps,
        })
      : fallback;
  } catch (err) {
    console.error(`Redis store init failed for ${options.keyPrefix}, using memory:`, err);
    primary = fallback;
  }

  // If a Redis op throws (bad URL, TLS, network, package resolution), don't 500
  // the request — log once and serve from the in-process store instead.
  let redisBroken = false;
  async function run<R>(op: (s: RecordStore<T>) => Promise<R>): Promise<R> {
    if (primary === fallback || redisBroken) return op(fallback);
    try {
      return await op(primary);
    } catch (err) {
      if (!redisBroken) {
        redisBroken = true;
        console.error(`Redis unavailable for ${options.keyPrefix}, falling back to memory:`, err);
      }
      return op(fallback);
    }
  }

  return {
    kind: primary.kind,
    insert: (record: T) => run((s) => s.insert(record)),
    get: (id: string) => run((s) => s.get(id)),
    remove: (id: string) => run((s) => s.remove(id)),
    list: (limit = 50) => run((s) => s.list(limit)),
  };
}
