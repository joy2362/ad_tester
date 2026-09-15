import { createRecordStore } from "./store";
import type { RunRecord, RunSummary } from "./types";

/**
 * Ad-tag run persistence. See lib/store.ts for the Redis/memory mechanics.
 * To enable persistence on Vercel: Storage → create/connect a Redis store to the
 * project's Production + Preview environments, then redeploy. No code change.
 */

const store = createRecordStore<RunRecord>({
  keyPrefix: "adtester:run:",
  indexKey: "adtester:runs:index",
  maxRecords: 200,
  shrinkSteps: [
    // Drop the (large) screenshot rather than fail the whole write.
    (r) => (r.result ? { ...r, result: { ...r.result, screenshot: null } } : r),
    // Still too big — drop captured response bodies too.
    (r) =>
      r.result
        ? {
            ...r,
            result: {
              ...r.result,
              requests: r.result.requests.map((req) => ({
                ...req,
                bodyPreview: null,
                bodyTruncated: req.bodyTruncated || Boolean(req.bodyPreview),
              })),
            },
          }
        : r,
  ],
});

export const storeKind = store.kind;

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
