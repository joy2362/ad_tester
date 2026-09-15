import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { insertSiteBatch, listSiteBatches } from "@/lib/siteDb";
import { DEFAULT_SITE_OPTIONS, type SiteBatchRecord, type SiteCheckOptions, type SitePageResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ batches: await listSiteBatches() });
  } catch (err) {
    return NextResponse.json({ error: message(err) }, { status: 500 });
  }
}

// Saves a finished batch (the client already ran every page via /api/sites/check
// and collected the results) so it shows up in History. Video is stripped here
// regardless of what's posted — see lib/siteDb.ts.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const pagesRaw = Array.isArray(input.pages) ? input.pages : [];
  if (pagesRaw.length === 0) {
    return NextResponse.json({ error: "No page results to save." }, { status: 400 });
  }
  if (pagesRaw.length > 300) {
    return NextResponse.json({ error: "Too many pages in one batch (300 max)." }, { status: 400 });
  }

  const label =
    typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 120) : null;

  const record: SiteBatchRecord = {
    id: randomUUID().slice(0, 12),
    createdAt: Date.now(),
    label,
    options: normalizeOptions(input.options),
    pages: pagesRaw.map(sanitizePage),
  };

  try {
    await insertSiteBatch(record);
  } catch (err) {
    return NextResponse.json(
      { error: `Batch finished but could not be saved: ${message(err)}`, record },
      { status: 500 },
    );
  }

  return NextResponse.json({ record });
}

function sanitizePage(raw: unknown): SitePageResult {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof p.id === "string" ? p.id : randomUUID().slice(0, 12),
    portal: typeof p.portal === "string" ? p.portal : "",
    pageLabel: typeof p.pageLabel === "string" ? p.pageLabel : "Page",
    url: typeof p.url === "string" ? p.url : "",
    status: p.status === "ok" ? "ok" : "error",
    error: typeof p.error === "string" ? p.error : null,
    finalUrl: typeof p.finalUrl === "string" ? p.finalUrl : null,
    pageTitle: typeof p.pageTitle === "string" ? p.pageTitle : null,
    loadTimeMs: typeof p.loadTimeMs === "number" ? p.loadTimeMs : null,
    screenshot: typeof p.screenshot === "string" ? p.screenshot : null,
    screenshotBytes: typeof p.screenshotBytes === "number" ? p.screenshotBytes : null,
    screenshotOmitted: Boolean(p.screenshotOmitted),
    video: null, // never persisted
    videoBytes: typeof p.videoBytes === "number" ? p.videoBytes : null,
    checkedAt: typeof p.checkedAt === "number" ? p.checkedAt : Date.now(),
  };
}

function normalizeOptions(raw: unknown): SiteCheckOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    viewportWidth: typeof o.viewportWidth === "number" ? o.viewportWidth : DEFAULT_SITE_OPTIONS.viewportWidth,
    viewportHeight: typeof o.viewportHeight === "number" ? o.viewportHeight : DEFAULT_SITE_OPTIONS.viewportHeight,
    timeoutMs: typeof o.timeoutMs === "number" ? o.timeoutMs : DEFAULT_SITE_OPTIONS.timeoutMs,
    settleMs: typeof o.settleMs === "number" ? o.settleMs : DEFAULT_SITE_OPTIONS.settleMs,
    fullPage: o.fullPage === undefined ? DEFAULT_SITE_OPTIONS.fullPage : Boolean(o.fullPage),
    stealth: Boolean(o.stealth),
    recordVideo: Boolean(o.recordVideo),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
