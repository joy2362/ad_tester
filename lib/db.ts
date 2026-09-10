import { Redis } from "@upstash/redis";
import type { RunRecord, RunSummary } from "./types";

/**
 * Run persistence.
 *
 * Serverless (Vercel) has a read-only filesystem, so the old better-sqlite3 file
 * store is gone. If Upstash Redis credentials are present we use those; otherwise
 * we fall back to an in-process Map (fine for local dev / a quick demo, but
 * ephemeral — a warm Vercel instance keeps it, a cold one starts empty).
 *
 * Add persistence on Vercel by attaching the "Upstash for Redis" integration
 * (Storage tab) — it injects UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * (KV_REST_API_URL / KV_REST_API_TOKEN also accepted). No redeploy of code needed.
 */

const KEY_PREFIX = "adtester:run:";
const INDEX_KEY = "adtester:runs:index";
const MAX_RUNS = 200;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_VALUE_BYTES = 1_000_000; // Upstash free-tier per-request ceiling

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

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
    json = JSON.stringify({
      ...record,
      result: { ...record.result, screenshot: null },
    });
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

function createRedisStore(url: string, token: string): Store {
  const redis = new Redis({ url, token });

  return {
    kind: "redis",
    async insert(record) {
      await redis.set(KEY_PREFIX + record.id, serialize(record), { ex: TTL_SECONDS });
      await redis.zadd(INDEX_KEY, { score: record.createdAt, member: record.id });
      // Trim the index to the most recent MAX_RUNS ids.
      await redis.zremrangebyrank(INDEX_KEY, 0, -(MAX_RUNS + 1));
    },
    async get(id) {
      const raw = await redis.get<RunRecord | string>(KEY_PREFIX + id);
      if (!raw) return null;
      return typeof raw === "string" ? (JSON.parse(raw) as RunRecord) : raw;
    },
    async remove(id) {
      const removed = await redis.del(KEY_PREFIX + id);
      await redis.zrem(INDEX_KEY, id);
      return removed > 0;
    },
    async list(limit) {
      const ids = await redis.zrange<string[]>(INDEX_KEY, 0, limit - 1, { rev: true });
      if (!ids.length) return [];
      const raws = await redis.mget<(RunRecord | string)[]>(...ids.map((id) => KEY_PREFIX + id));
      return raws
        .map((raw) => (typeof raw === "string" ? (JSON.parse(raw) as RunRecord) : raw))
        .filter((r): r is RunRecord => Boolean(r));
    },
  };
}

/* -------------------------------- selection ----------------------------- */

let store: Store;
try {
  store = redisUrl && redisToken ? createRedisStore(redisUrl, redisToken) : createMemoryStore();
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
