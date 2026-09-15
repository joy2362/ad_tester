"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SITE_OPTIONS,
  PAGE_LABEL_SUGGESTIONS,
  type SiteBatchRecord,
  type SiteBatchSummary,
  type SiteCheckOptions,
  type SitePageInput,
  type SitePageResult,
} from "@/lib/types";
import { formatBytes } from "@/lib/heuristics";

const CONCURRENCY = 2;

function newId(): string {
  // crypto.randomUUID is available in every browser this app targets.
  return (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36)
  ).slice(0, 12);
}

function blankRow(): SitePageInput {
  return { id: newId(), portal: "", pageLabel: "Home page", url: "" };
}

function parseBulk(text: string): SitePageInput[] {
  const rows: SitePageInput[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parts = line.split("|").map((p) => p.trim());
    // Trailing "| auto" / "| home" flags the row as "visit this as a home
    // page and pick an article off it" instead of a direct URL.
    let autoDiscoverArticle = false;
    if (parts.length > 1 && /^(auto|home)$/i.test(parts[parts.length - 1])) {
      autoDiscoverArticle = true;
      parts = parts.slice(0, -1);
    }
    let portal = "";
    let pageLabel = "Page";
    let url = "";
    if (parts.length >= 3) {
      [portal, pageLabel, url] = [parts[0], parts[1], parts.slice(2).join("|")];
    } else if (parts.length === 2) {
      [portal, url] = parts;
    } else {
      url = parts[0];
      try {
        portal = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        portal = url;
      }
    }
    if (!url) continue;
    if (autoDiscoverArticle && pageLabel === "Page") pageLabel = "Article page";
    rows.push({ id: newId(), portal, pageLabel: pageLabel || "Page", url, autoDiscoverArticle });
  }
  return rows;
}

function errorResult(input: SitePageInput, error: string): SitePageResult {
  return {
    ...input,
    status: "error",
    error,
    finalUrl: null,
    pageTitle: null,
    loadTimeMs: null,
    screenshot: null,
    screenshotBytes: null,
    screenshotOmitted: false,
    video: null,
    videoBytes: null,
    adStatus: "unknown",
    adReason: "Request failed before the ad could be checked.",
    adRequestCount: 0,
    adElementDetected: false,
    checkedAt: Date.now(),
  };
}

export default function SiteChecker() {
  const [rows, setRows] = useState<SitePageInput[]>([blankRow()]);
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [label, setLabel] = useState("");
  const [options, setOptions] = useState<SiteCheckOptions>(DEFAULT_SITE_OPTIONS);

  const [running, setRunning] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, SitePageResult>>({});
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const [history, setHistory] = useState<SiteBatchSummary[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/sites/batches", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data.batches)) setHistory(data.batches);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, [loadHistory]);

  function updateRow(id: string, patch: Partial<SitePageInput>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    setResults((r) => {
      const rest = { ...r };
      delete rest[id];
      return rest;
    });
  }

  function addBulk() {
    const parsed = parseBulk(bulkText);
    if (!parsed.length) return;
    setRows((rs) => [...rs.filter((r) => r.portal || r.url), ...parsed]);
    setBulkText("");
    setShowBulk(false);
  }

  async function checkOne(row: SitePageInput): Promise<SitePageResult> {
    try {
      const res = await fetch("/api/sites/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: row, options }),
      });
      const data = await res.json();
      if (!res.ok || !data.result) return errorResult(row, data.error ?? `Request failed (${res.status}).`);
      return data.result as SitePageResult;
    } catch (err) {
      return errorResult(row, err instanceof Error ? err.message : String(err));
    }
  }

  async function runAll() {
    const queue = rows.filter((r) => r.url.trim());
    if (!queue.length || running) return;
    setRunning(true);
    setError(null);
    setResults({});
    setActiveBatchId(null);
    cancelRef.current = false;

    const pending = [...queue];
    const collected: Record<string, SitePageResult> = {};

    async function worker() {
      while (pending.length && !cancelRef.current) {
        const row = pending.shift();
        if (!row) return;
        setRunningIds((s) => new Set(s).add(row.id));
        const result = await checkOne(row);
        collected[row.id] = result;
        setResults((r) => ({ ...r, [row.id]: result }));
        setRunningIds((s) => {
          const next = new Set(s);
          next.delete(row.id);
          return next;
        });
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setRunning(false);

    // Auto-save the finished batch (video stripped server-side).
    try {
      const res = await fetch("/api/sites/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label || null, options, pages: Object.values(collected) }),
      });
      const data = await res.json();
      if (res.ok && data.record) setActiveBatchId(data.record.id);
      else setError(data.error ?? "Could not save this batch to history.");
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openBatch(id: string) {
    setLoadingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/sites/batches/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not load batch.");
        return;
      }
      const record = data.record as SiteBatchRecord;
      setRows(record.pages.map((p) => ({ id: p.id, portal: p.portal, pageLabel: p.pageLabel, url: p.url })));
      setOptions(record.options);
      setLabel(record.label ?? "");
      setResults(Object.fromEntries(record.pages.map((p) => [p.id, p])));
      setActiveBatchId(record.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingId(null);
    }
  }

  async function removeBatch(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await fetch(`/api/sites/batches/${id}`, { method: "DELETE" });
      if (activeBatchId === id) setActiveBatchId(null);
      await loadHistory();
    } catch {
      /* ignore */
    }
  }

  const [resultFilter, setResultFilter] = useState<"all" | "serving" | "problem">("all");

  const orderedResults = useMemo(
    () => rows.map((r) => ({ row: r, result: results[r.id] })),
    [rows, results],
  );
  const doneCount = Object.keys(results).length;
  const queuedCount = rows.filter((r) => r.url.trim()).length;

  const adChecked = Object.values(results).some((r) => r.adStatus !== "unknown");
  const servingCount = Object.values(results).filter((r) => r.adStatus === "serving").length;
  const problemCount = Object.values(results).filter(
    (r) => r.adStatus === "no_fill" || r.adStatus === "not_detected" || r.status === "error",
  ).length;
  const visibleResults = orderedResults.filter(({ result }) => {
    if (resultFilter === "all" || !result) return true;
    if (resultFilter === "serving") return result.adStatus === "serving";
    return result.adStatus === "no_fill" || result.adStatus === "not_detected" || result.status === "error";
  });

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[440px_minmax(0,1fr)]">
      {/* ---------- Left: page list + options ---------- */}
      <div className="flex flex-col gap-4">
        <section className="rounded-lg border bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted">
              Pages to check
            </label>
            <button
              type="button"
              onClick={() => setShowBulk((v) => !v)}
              className="text-[11px] text-muted hover:text-foreground"
            >
              {showBulk ? "hide bulk add" : "bulk add"}
            </button>
          </div>
          <p className="mb-2 text-[11px] text-muted">
            🔗 = direct URL · 🏠→📄 = visit as a home page and check whichever article it
            picks (click the icon to switch a row).
          </p>

          {showBulk && (
            <div className="mb-3 rounded-md border bg-panel-2 p-2">
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={
                  "One per line — Portal | Page label | URL (add \"| auto\" to pick an article off a home page URL)\n" +
                  "The Daily Times | Home page | https://example.com/\n" +
                  "The Daily Times | Article page | https://example.com/some-article\n" +
                  "The Daily Times | Article page | https://example.com/ | auto"
                }
                spellCheck={false}
                className="h-24 w-full resize-y rounded border bg-panel p-2 font-mono text-[11.5px] leading-relaxed outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={addBulk}
                className="mt-2 rounded border border-accent px-2 py-1 text-[11px] text-accent hover:bg-accent/10"
              >
                Parse &amp; add rows
              </button>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const isRunning = runningIds.has(row.id);
              const result = results[row.id];
              return (
                <li key={row.id} className="rounded-md border bg-panel-2 p-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        isRunning
                          ? "animate-pulse bg-accent"
                          : result?.status === "error"
                            ? "bg-fail"
                            : result?.status === "ok"
                              ? "bg-ok"
                              : "bg-border"
                      }`}
                    />
                    <input
                      value={row.portal}
                      onChange={(e) => updateRow(row.id, { portal: e.target.value })}
                      placeholder="Portal name"
                      className="w-28 shrink-0 rounded border bg-panel px-1.5 py-1 text-xs outline-none focus:border-accent"
                    />
                    <input
                      value={row.pageLabel}
                      onChange={(e) => updateRow(row.id, { pageLabel: e.target.value })}
                      placeholder="Page label"
                      list="page-label-suggestions"
                      className="w-28 shrink-0 rounded border bg-panel px-1.5 py-1 text-xs outline-none focus:border-accent"
                    />
                    <input
                      value={row.url}
                      onChange={(e) => updateRow(row.id, { url: e.target.value })}
                      placeholder={row.autoDiscoverArticle ? "https://example.com/ (home page)" : "https://example.com/…"}
                      className="min-w-0 flex-1 rounded border bg-panel px-1.5 py-1 text-xs outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => updateRow(row.id, { autoDiscoverArticle: !row.autoDiscoverArticle })}
                      title={
                        row.autoDiscoverArticle
                          ? "Visiting the URL as a home page and picking an article off it — click for a direct URL instead"
                          : "Click to visit the URL as a home page and pick an article off it, instead of going there directly"
                      }
                      className={`shrink-0 rounded border px-1.5 py-1 text-[10px] ${
                        row.autoDiscoverArticle
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      {row.autoDiscoverArticle ? "🏠→📄" : "🔗"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      className="shrink-0 px-1 text-muted hover:text-fail"
                      aria-label="Remove row"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <datalist id="page-label-suggestions">
            {PAGE_LABEL_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>

          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, blankRow()])}
            className="mt-2 rounded border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground"
          >
            + add row
          </button>

          <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-2.5">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-accent">
              What identifies your ad?
            </label>
            <input
              value={options.adMatch}
              onChange={(e) => setOptions((o) => ({ ...o, adMatch: e.target.value }))}
              placeholder="e.g. delivery.viewsense.ai (comma-separate several)"
              className="w-full rounded-md border bg-panel px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <p className="mt-1 text-[11px] leading-snug text-muted">
              Domain(s) or URL keyword(s) your ad calls out to. Each page check watches network
              traffic for a match and tells you whether it filled or no-filled — leave blank to just
              screenshot without a serving verdict.
            </p>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted">
              Batch label (optional)
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Coca-Cola campaign — Sept placement check"
              className="w-full rounded-md border bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            className="mt-3 text-xs text-muted hover:text-foreground"
          >
            {showOptions ? "▾" : "▸"} Advanced options
          </button>
          {showOptions && (
            <div className="mt-2 grid grid-cols-2 gap-2 rounded-md border bg-panel-2 p-3 text-xs">
              <NumField
                label="Viewport width"
                value={options.viewportWidth}
                onChange={(v) => setOptions((o) => ({ ...o, viewportWidth: v }))}
              />
              <NumField
                label="Viewport height"
                value={options.viewportHeight}
                onChange={(v) => setOptions((o) => ({ ...o, viewportHeight: v }))}
              />
              <NumField
                label="Timeout (ms)"
                value={options.timeoutMs}
                onChange={(v) => setOptions((o) => ({ ...o, timeoutMs: v }))}
              />
              <NumField
                label="Settle wait (ms)"
                value={options.settleMs}
                onChange={(v) => setOptions((o) => ({ ...o, settleMs: v }))}
              />
              <label className="col-span-2 flex items-center gap-2 text-muted">
                <input
                  type="checkbox"
                  checked={options.fullPage}
                  onChange={(e) => setOptions((o) => ({ ...o, fullPage: e.target.checked }))}
                />
                Full-page screenshot (off = just the viewport)
              </label>
              <label className="col-span-2 flex items-start gap-2 text-muted">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={options.stealth}
                  onChange={(e) => setOptions((o) => ({ ...o, stealth: e.target.checked }))}
                />
                <span>Stealth mode — mask headless/automation signals</span>
              </label>
              <label className="col-span-2 flex items-start gap-2 text-muted">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={options.recordVideo}
                  onChange={(e) => setOptions((o) => ({ ...o, recordVideo: e.target.checked }))}
                />
                <span>
                  Record video of the page load — shown right after the run, not saved to history
                  (keeps storage small). Adds time per page.
                </span>
              </label>
              <label className="col-span-2 flex items-start gap-2 text-muted">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={options.onlyScreenshotIfServing}
                  onChange={(e) => setOptions((o) => ({ ...o, onlyScreenshotIfServing: e.target.checked }))}
                />
                <span>
                  Only keep the screenshot when the ad is confirmed serving (requires the field above).
                </span>
              </label>
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={runAll}
              disabled={!queuedCount || running}
              className="brand-gradient-bg flex-1 rounded-md px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running
                ? `Checking pages… (${doneCount}/${queuedCount})`
                : `Run ${queuedCount || ""} page check${queuedCount === 1 ? "" : "s"}`}
            </button>
            {running && (
              <button
                type="button"
                onClick={() => {
                  cancelRef.current = true;
                }}
                className="rounded-md border border-border px-3 text-sm text-muted hover:text-fail"
              >
                Stop
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted">
            Each page is visited directly (not sandboxed) in an isolated browser context — only run
            this against pages you&rsquo;re allowed to check.
          </p>
        </section>

        <section className="rounded-lg border bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">History</h2>
            <button onClick={loadHistory} className="text-[11px] text-muted hover:text-foreground">
              refresh
            </button>
          </div>
          {history.length === 0 && <p className="text-xs text-muted">No saved batches yet.</p>}
          <ul className="flex flex-col gap-1">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  onClick={() => openBatch(h.id)}
                  className={`group flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs ${
                    activeBatchId === h.id
                      ? "border-accent bg-panel-2"
                      : "border-transparent bg-panel-2/50 hover:border-border"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      h.noFillCount ? "bg-fail" : h.errorCount ? "bg-warn" : "bg-ok"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">
                      {h.label || `${h.pageCount} page batch`}
                      {loadingId === h.id && " …"}
                    </span>
                    <span className="block truncate text-muted">
                      {new Date(h.createdAt).toLocaleString()} ·{" "}
                      {h.servingCount + h.noFillCount > 0
                        ? `${h.servingCount}/${h.pageCount} serving`
                        : `${h.okCount}/${h.pageCount} ok`}
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => removeBatch(h.id, e)}
                    className="hidden shrink-0 text-muted hover:text-fail group-hover:block"
                  >
                    ✕
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ---------- Right: results ---------- */}
      <div className="min-w-0">
        {error && (
          <div className="mb-4 rounded-lg border border-fail/40 bg-fail/10 p-3 text-sm text-fail">
            {error}
          </div>
        )}
        {orderedResults.every(({ result }) => !result) && !running ? (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed text-sm text-muted">
            Add pages and run the check to see screenshots here.
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {adChecked && (
                <span className="text-xs text-muted">
                  <span className="text-ok">{servingCount} serving</span>
                  {" · "}
                  <span className="text-fail">{problemCount} not serving</span>
                  {" · "}
                  {doneCount} checked
                </span>
              )}
              <div className="ml-auto flex gap-1 text-[11px]">
                <FilterChip active={resultFilter === "all"} onClick={() => setResultFilter("all")}>
                  all
                </FilterChip>
                <FilterChip active={resultFilter === "serving"} onClick={() => setResultFilter("serving")}>
                  serving
                </FilterChip>
                <FilterChip active={resultFilter === "problem"} onClick={() => setResultFilter("problem")}>
                  problems
                </FilterChip>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visibleResults.map(({ row, result }) => (
                <PageResultCard key={row.id} row={row} result={result} isRunning={runningIds.has(row.id)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PageResultCard({
  row,
  result,
  isRunning,
}: {
  row: SitePageInput;
  result: SitePageResult | undefined;
  isRunning: boolean;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-panel">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            isRunning
              ? "animate-pulse bg-accent"
              : result?.status === "error"
                ? "bg-fail"
                : result?.status === "ok"
                  ? "bg-ok"
                  : "bg-border"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">
            {row.portal || "Untitled portal"}
          </div>
          <div className="truncate text-[11px] text-muted">{row.pageLabel}</div>
        </div>
        {result?.loadTimeMs != null && (
          <span className="shrink-0 text-[11px] text-muted">{(result.loadTimeMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      {!isRunning && result && result.adStatus !== "unknown" && (
        <div
          className={`flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] font-semibold ${
            result.adStatus === "serving"
              ? "bg-ok/10 text-ok"
              : result.adStatus === "no_fill"
                ? "bg-fail/10 text-fail"
                : "bg-warn/10 text-warn"
          }`}
        >
          <span>
            {result.adStatus === "serving"
              ? "● AD SERVING"
              : result.adStatus === "no_fill"
                ? "● AD NOT SERVING (no-fill)"
                : "● AD NOT DETECTED"}
          </span>
          {result.adElementDetected && <span className="font-normal opacity-80">· highlighted below</span>}
        </div>
      )}

      <div className="flex min-h-32 flex-1 items-center justify-center bg-panel-2 p-2">
        {isRunning && <span className="text-xs text-muted">Visiting page…</span>}
        {!isRunning && result?.screenshot && (
          <a href={result.screenshot} target="_blank" rel="noreferrer" className="block w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={result.screenshot}
              alt={`${row.portal} — ${row.pageLabel}`}
              className="max-h-72 w-full rounded border object-contain object-top"
            />
          </a>
        )}
        {!isRunning && result && !result.screenshot && result.status === "error" && (
          <span className="px-2 text-center text-xs text-fail">{result.error ?? "Failed."}</span>
        )}
        {!isRunning && result && !result.screenshot && result.status === "ok" && (
          <span className="text-xs text-muted">
            {result.screenshotOmitted
              ? "Ad not confirmed serving — screenshot skipped."
              : "No screenshot captured."}
          </span>
        )}
        {!isRunning && !result && <span className="text-xs text-muted">Not run yet.</span>}
      </div>

      {!isRunning && result?.video && (
        <video controls className="w-full border-t bg-black" src={result.video} />
      )}

      {!isRunning && result && (
        <div className="border-t px-3 py-2 text-[11px] text-muted">
          {result.adStatus !== "unknown" && <div className="mb-1 text-foreground">{result.adReason}</div>}
          {row.autoDiscoverArticle && (
            <div className="mb-1">🏠→📄 auto-picked from {row.url}</div>
          )}
          {result.pageTitle && <div className="truncate text-foreground">{result.pageTitle}</div>}
          <div className="truncate" title={result.finalUrl ?? row.url}>
            {result.finalUrl ?? row.url}
          </div>
          {result.screenshotBytes != null && <div>screenshot: {formatBytes(result.screenshotBytes)}</div>}
          {result.videoBytes != null && (
            <div>
              video: {formatBytes(result.videoBytes)}
              {!result.video && " (too large to show inline)"}
            </div>
          )}
          {result.status === "error" && result.screenshot && (
            <div className="mt-1 text-fail">Failed: {result.error}</div>
          )}
          {result.status === "ok" && result.error && (
            <div className="mt-1 text-warn">Note: {result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 ${
        active ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-muted">
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border bg-panel px-2 py-1 text-foreground outline-none focus:border-accent"
      />
    </label>
  );
}
