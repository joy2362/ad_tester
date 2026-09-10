import { createClient, type RedisClientType } from "redis";
import type { RunRecord, RunSummary } from "./types";

/**
 * Run persistence.
 *
 * Serverless (Vercel) has a read-only filesystem, so there is no on-disk store.
 * If a Redis connection string is present (Vercel-managed Redis injects
 * `REDIS_URL`; the old Vercel KV used `KV_URL`) we persist there via node-redis;
 * otherwise we fall back to an in-process Map — fine for local dev / a quick
 * demo, but ephemeral (a warm instance keeps it, a cold one starts empty).
 *
 * To enable persistence on Vercel: Storage → create/connect a Redis store to the
 * project's Production + Preview environments, then redeploy. No code change.
 */

const KEY_PREFIX = "adtester:run:";
const INDEX_KEY = "adtester:runs:index";
const MAX_RUNS = 200;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_VALUE_BYTES = 1_000_000; // keep individual records lean

const redisUrl = process.env.REDIS_URL || process.env.KV_URL || "";

interface Store {
  kind: "redis" | "memory";
  insert(record: RunRecord): Promise<void>;
  get(id: string): Promise<RunRecord | null>;
  remove(id: string): Promise<boolean>;
  list(limit: number): Promise<RunRecord[]>;
}

/* ----------------------------- in-memory store ---------------------------- */

function createMemoryStore(): Store {
  const map = new Map<string, RunRecord>();
  return {
    kind: "memory",
    async insert(record) {
      map.set(record.id, record);
      if (map.size > MAX_RUNS) {
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

/* ------------------------------- redis store ----------------------------- */

function serialize(record: RunRecord): string {
  let json = JSON.stringify(record);
  if (json.length > MAX_VALUE_BYTES && record.result) {
    // Drop the (large) screenshot rather than fail the whole write.
    json = JSON.stringify({ ...record, result: { ...record.result, screenshot: null } });
  }
  if (json.length > MAX_VALUE_BYTES && record.result) {
    // Still too big — drop captured response bodies too.
    json = JSON.stringify({
      ...record,
      result: {
        ...record.result,
        screenshot: null,
        requests: record.result.requests.map((r) => ({
          ...r,
          bodyPreview: null,
          bodyTruncated: r.bodyTruncated || Boolean(r.bodyPreview),
        })),
      },
    });
  }
  return json;
}

function parse(raw: string | null): RunRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunRecord;
  } catch {
    return null;
  }
}

function createRedisStore(url: string): Store {
  let clientPromise: Promise<RedisClientType> | null = null;

  async function client(): Promise<RedisClientType> {
    if (!clientPromise) {
      const c: RedisClientType = createClient({ url });
      c.on("error", (err) => console.error("redis client error:", err));
      clientPromise = c.connect().then(() => c).catch((err) => {
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  }

  return {
    kind: "redis",
    async insert(record) {
      const c = await client();
      await c.set(KEY_PREFIX + record.id, serialize(record), { EX: TTL_SECONDS });
      await c.zAdd(INDEX_KEY, { score: record.createdAt, value: record.id });
      await c.zRemRangeByRank(INDEX_KEY, 0, -(MAX_RUNS + 1));
    },
    async get(id) {
      const c = await client();
      return parse(await c.get(KEY_PREFIX + id));
    },
    async remove(id) {
      const c = await client();
      const removed = await c.del(KEY_PREFIX + id);
      await c.zRem(INDEX_KEY, id);
      return removed > 0;
    },
    async list(limit) {
      const c = await client();
      const ids = await c.zRange(INDEX_KEY, 0, limit - 1, { REV: true });
      if (!ids.length) return [];
      const raws = await c.mGet(ids.map((id) => KEY_PREFIX + id));
      return raws.map(parse).filter((r): r is RunRecord => Boolean(r));
    },
  };
}

/* -------------------------------- selection ----------------------------- */

let store: Store;
try {
  store = redisUrl ? createRedisStore(redisUrl) : createMemoryStore();
} catch (err) {
  console.error("Redis store init failed, falling back to memory:", err);
  store = createMemoryStore();
}

export const storeKind = store.kind;

/* --------------------------------- API --------------------------------- */

export async function insertRun(record: RunRecord): Promise<void> {
  await store.insert(record);
}

export async function getRun(id: string): Promise<RunRecord | null> {
  return store.get(id);
}

export async function deleteRun(id: string): Promise<boolean> {
  return store.remove(id);
}

export async function listRuns(limit = 50): Promise<RunSummary[]> {
  const records = await store.list(limit);
  return records.map(summarize);
}

function summarize(record: RunRecord): RunSummary {
  const r = record.result;
  return {
    id: record.id,
    createdAt: record.createdAt,
    label: record.label,
    resolvedType: record.resolvedType,
    status: record.status,
    requestCount: r?.metrics.requestCount ?? 0,
    totalBytes: r?.metrics.totalBytes ?? 0,
    thirdPartyDomainCount: r?.metrics.thirdPartyDomains.length ?? 0,
    consoleErrorCount: r?.metrics.consoleErrorCount ?? 0,
    failCheckCount: r?.checks.filter((c) => c.status === "fail").length ?? 0,
    warnCheckCount: r?.checks.filter((c) => c.status === "warn").length ?? 0,
    durationMs: r?.durationMs ?? 0,
    passbackDetected: r?.passback?.detected ?? false,
  } satisfies RunSummary;
}
