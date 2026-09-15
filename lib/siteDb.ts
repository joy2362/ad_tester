import { createRecordStore } from "./store";
import type { SiteBatchRecord, SiteBatchSummary } from "./types";

/**
 * Site-check batch persistence. Video is never stored here (it's only ever
 * returned in the live /api/sites/check response) — screenshots can still push
 * a batch of many pages over the value-size budget, so that's the one shrink
 * step: drop screenshots, oldest-looking-page-first isn't worth the complexity,
 * so it just drops all of them together and marks each `screenshotOmitted`.
 */

const store = createRecordStore<SiteBatchRecord>({
  keyPrefix: "adtester:sitebatch:",
  indexKey: "adtester:sitebatches:index",
  maxRecords: 100,
  shrinkSteps: [
    (b) => ({
      ...b,
      pages: b.pages.map((p) => ({ ...p, screenshot: null, screenshotOmitted: true })),
    }),
  ],
});

export const siteStoreKind = store.kind;

export async function insertSiteBatch(record: SiteBatchRecord): Promise<void> {
  // Defensive: video must never be persisted, regardless of what the caller sent.
  const stripped: SiteBatchRecord = {
    ...record,
    pages: record.pages.map((p) => ({ ...p, video: null, videoBytes: p.videoBytes })),
  };
  await store.insert(stripped);
}

export async function getSiteBatch(id: string): Promise<SiteBatchRecord | null> {
  return store.get(id);
}

export async function deleteSiteBatch(id: string): Promise<boolean> {
  return store.remove(id);
}

export async function listSiteBatches(limit = 50): Promise<SiteBatchSummary[]> {
  const records = await store.list(limit);
  return records.map(summarize);
}

function summarize(batch: SiteBatchRecord): SiteBatchSummary {
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    label: batch.label,
    pageCount: batch.pages.length,
    okCount: batch.pages.filter((p) => p.status === "ok").length,
    errorCount: batch.pages.filter((p) => p.status === "error").length,
  };
}
