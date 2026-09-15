import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { DEFAULT_SITE_OPTIONS, type SiteCheckOptions, type SitePageInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The client calls this once per page (see components/SiteChecker.tsx) rather
// than looping server-side over a whole portal list — that keeps each request
// well under Vercel's function timeout regardless of how many pages the user
// queues up, and lets the UI show results as they land instead of all-or-nothing.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const pageInput = input.page as Record<string, unknown> | undefined;
  const url = typeof pageInput?.url === "string" ? pageInput.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "Provide a page URL to check." }, { status: 400 });
  }

  const page: SitePageInput = {
    id: typeof pageInput?.id === "string" && pageInput.id ? pageInput.id : randomUUID().slice(0, 12),
    portal: typeof pageInput?.portal === "string" ? pageInput.portal.trim().slice(0, 120) : "",
    pageLabel: typeof pageInput?.pageLabel === "string" ? pageInput.pageLabel.trim().slice(0, 60) : "Page",
    url,
  };

  const options = normalizeOptions(input.options);

  // Lazy-import so a Playwright load failure returns a JSON error instead of
  // crashing this route's module load (see app/api/runs/route.ts for why).
  try {
    const { checkSitePage } = await import("@/lib/siteRunner");
    const result = await checkSitePage(page, options);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not start the headless browser: ${message(err)}` },
      { status: 500 },
    );
  }
}

function normalizeOptions(raw: unknown): SiteCheckOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const recordVideo = Boolean(o.recordVideo);
  return {
    viewportWidth: num(o.viewportWidth, DEFAULT_SITE_OPTIONS.viewportWidth, 320, 1920),
    viewportHeight: num(o.viewportHeight, DEFAULT_SITE_OPTIONS.viewportHeight, 320, 1920),
    timeoutMs: num(o.timeoutMs, DEFAULT_SITE_OPTIONS.timeoutMs, 5000, 45000),
    // Recording video bounds the file size by bounding how long we settle for.
    settleMs: num(o.settleMs, DEFAULT_SITE_OPTIONS.settleMs, 0, recordVideo ? 8000 : 15000),
    fullPage: o.fullPage === undefined ? DEFAULT_SITE_OPTIONS.fullPage : Boolean(o.fullPage),
    stealth: Boolean(o.stealth),
    recordVideo,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
