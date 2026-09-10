import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { insertRun, listRuns } from "@/lib/db";
import { resolveInputType } from "@/lib/input";
import { DEFAULT_OPTIONS, type InputMode, type RunOptions, type RunRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_MODES: InputMode[] = ["auto", "script-tag", "raw-html", "script-url", "iframe-url"];

export async function GET() {
  try {
    return NextResponse.json({ runs: await listRuns() });
  } catch (err) {
    return NextResponse.json({ error: message(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const script = typeof input.script === "string" ? input.script : "";
  if (!script.trim()) {
    return NextResponse.json({ error: "Provide an ad tag / script to test." }, { status: 400 });
  }
  if (script.length > 200_000) {
    return NextResponse.json({ error: "Script is too large (200 KB max)." }, { status: 400 });
  }

  const mode: InputMode = VALID_MODES.includes(input.mode as InputMode)
    ? (input.mode as InputMode)
    : "auto";
  const label =
    typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 120) : null;

  const options: RunOptions = normalizeOptions(input.options);

  // Import the Playwright runner lazily so a failure to load it (missing browser
  // binary, bundling issue) surfaces as a JSON error rather than crashing the
  // route module and 500ing every request including GET.
  let outcome: Awaited<ReturnType<typeof import("@/lib/runner").executeRun>>;
  try {
    const { executeRun } = await import("@/lib/runner");
    outcome = await executeRun(script, mode, options);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not start the headless browser: ${message(err)}` },
      { status: 500 },
    );
  }

  const record: RunRecord = {
    id: randomUUID().slice(0, 12),
    createdAt: Date.now(),
    label,
    script,
    inputMode: mode,
    resolvedType: resolveInputType(script, mode),
    options,
    status: outcome.status,
    error: outcome.error,
    result: outcome.result,
  };

  try {
    await insertRun(record);
  } catch (err) {
    return NextResponse.json({ error: `Run completed but could not be saved: ${message(err)}`, record }, { status: 500 });
  }

  return NextResponse.json({ record });
}

function normalizeOptions(raw: unknown): RunOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    viewportWidth: num(o.viewportWidth, DEFAULT_OPTIONS.viewportWidth, 120, 1920),
    viewportHeight: num(o.viewportHeight, DEFAULT_OPTIONS.viewportHeight, 120, 1920),
    timeoutMs: num(o.timeoutMs, DEFAULT_OPTIONS.timeoutMs, 5000, 45000),
    settleMs: num(o.settleMs, DEFAULT_OPTIONS.settleMs, 0, 15000),
    blockThirdParty: Boolean(o.blockThirdParty),
    captureBodies: o.captureBodies === undefined ? DEFAULT_OPTIONS.captureBodies : Boolean(o.captureBodies),
    stealth: Boolean(o.stealth),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
