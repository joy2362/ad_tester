"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_OPTIONS, type InputMode, type RunOptions, type RunRecord, type RunSummary } from "@/lib/types";
import { resolveInputType } from "@/lib/input";
import ResultView from "@/components/ResultView";
import { formatBytes } from "@/lib/heuristics";

const MODE_LABELS: Record<InputMode, string> = {
  auto: "Auto-detect",
  "script-tag": "Script / HTML tag",
  "raw-html": "Raw HTML / JS snippet",
  "script-url": "Script URL (src)",
  "iframe-url": "Iframe URL (src)",
};

const SAMPLES: { name: string; mode: InputMode; value: string }[] = [
  {
    name: "GPT display slot",
    mode: "script-tag",
    value: `<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script>
  window.googletag = window.googletag || { cmd: [] };
  googletag.cmd.push(function () {
    googletag
      .defineSlot("/6355419/Travel/Europe/France/Paris", [300, 250], "ad-slot")
      .addService(googletag.pubads());
    googletag.enableServices();
  });
</script>
<div id="ad-slot" style="width:300px;height:250px;">
  <script>googletag.cmd.push(function () { googletag.display("ad-slot"); });</script>
</div>`,
  },
  {
    name: "Tracking pixel",
    mode: "raw-html",
    value: `<img src="https://www.google-analytics.com/collect?v=1&t=event&tid=UA-000000-1&cid=555&ec=ad&ea=impression&cb=[timestamp]" width="1" height="1" style="display:none" alt="">`,
  },
  {
    name: "Prebid-style snippet",
    mode: "raw-html",
    value: `<div id="banner" style="width:728px;height:90px;background:#eee;font:14px/90px Arial;text-align:center;color:#333">
  Creative 728x90 %%CLICK_URL_UNESC%%
</div>
<script>
  var img = new Image();
  img.src = "https://ib.adnxs.com/pixie?bt=IMP&cb=" + Date.now();
  console.log("impression fired");
</script>`,
  },
];

interface Props {
  initial?: RunRecord | null;
}

export default function AdTester({ initial = null }: Props) {
  const [script, setScript] = useState("");
  const [mode, setMode] = useState<InputMode>("auto");
  const [label, setLabel] = useState("");
  const [options, setOptions] = useState<RunOptions>(DEFAULT_OPTIONS);
  const [showOptions, setShowOptions] = useState(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<RunRecord | null>(initial);

  const [history, setHistory] = useState<RunSummary[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resolved = useMemo(() => (script.trim() ? resolveInputType(script, mode) : null), [script, mode]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data.runs)) setHistory(data.runs);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Load run history once on mount; state updates happen after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, [loadHistory]);

  const previousRun = useMemo(() => {
    if (!record) return null;
    const idx = history.findIndex((h) => h.id === record.id);
    const prior = idx >= 0 ? history[idx + 1] : history[0];
    return prior ?? null;
  }, [record, history]);

  async function run() {
    if (!script.trim() || running) return;
    setRunning(true);
    setError(null);
    abortRef.current = new AbortController();
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script, mode, label: label || null, options }),
        signal: abortRef.current.signal,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status}).`);
        if (data.record) setRecord(data.record);
      } else {
        setRecord(data.record as RunRecord);
        if ((data.record as RunRecord).status === "error") {
          setError((data.record as RunRecord).error ?? "Run failed.");
        }
      }
      await loadHistory();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
    }
  }

  async function openRun(id: string) {
    setLoadingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        const rec = data.record as RunRecord;
        setRecord(rec);
        setScript(rec.script);
        setMode(rec.inputMode);
        setLabel(rec.label ?? "");
        setOptions(rec.options);
      } else {
        setError(data.error ?? "Could not load run.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingId(null);
    }
  }

  async function removeRun(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await fetch(`/api/runs/${id}`, { method: "DELETE" });
      if (record?.id === id) setRecord(null);
      await loadHistory();
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
      {/* ---------- Left: form + history ---------- */}
      <div className="flex flex-col gap-4">
        <section className="rounded-lg border bg-panel p-4">
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted">
            Ad tag / script
          </label>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            spellCheck={false}
            placeholder={`<script src="https://ad.example/tag.js"></script>`}
            className="h-56 w-full resize-y rounded-md border bg-panel-2 p-3 font-mono text-[12.5px] leading-relaxed text-foreground outline-none focus:border-accent"
          />

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {SAMPLES.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => {
                  setScript(s.value);
                  setMode(s.mode);
                }}
                className="rounded border border-border bg-panel-2 px-2 py-1 text-muted hover:text-foreground"
              >
                {s.name}
              </button>
            ))}
            {script && (
              <button
                type="button"
                onClick={() => setScript("")}
                className="rounded border border-border bg-panel-2 px-2 py-1 text-muted hover:text-fail"
              >
                clear
              </button>
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted">Interpret as</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as InputMode)}
                className="w-full rounded-md border bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
              >
                {Object.entries(MODE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted">Label (optional)</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Q3 300x250 v2"
                className="w-full rounded-md border bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
            </div>
          </div>

          {resolved && (
            <p className="mt-2 text-[11px] text-muted">
              Will run as <span className="text-foreground">{MODE_LABELS[resolved]}</span>
            </p>
          )}

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
                  checked={options.blockThirdParty}
                  onChange={(e) => setOptions((o) => ({ ...o, blockThirdParty: e.target.checked }))}
                />
                Block all third-party requests (offline / isolation test)
              </label>
            </div>
          )}

          <button
            type="button"
            onClick={run}
            disabled={!script.trim() || running}
            className="brand-gradient-bg mt-3 w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? "Running in headless Chromium…" : "Run test"}
          </button>
          <p className="mt-2 text-[11px] leading-snug text-muted">
            The tag runs in an isolated browser context with no access to this machine. Still, only run
            tags you understand — they can make real network requests.
          </p>
        </section>

        <section className="rounded-lg border bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">History</h2>
            <button onClick={loadHistory} className="text-[11px] text-muted hover:text-foreground">
              refresh
            </button>
          </div>
          {history.length === 0 && <p className="text-xs text-muted">No runs yet.</p>}
          <ul className="flex flex-col gap-1">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  onClick={() => openRun(h.id)}
                  className={`group flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs ${
                    record?.id === h.id
                      ? "border-accent bg-panel-2"
                      : "border-transparent bg-panel-2/50 hover:border-border"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      h.status === "error" ? "bg-fail" : h.failCheckCount ? "bg-warn" : "bg-ok"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">
                      {h.label || `${h.resolvedType} run`}
                      {loadingId === h.id && " …"}
                    </span>
                    <span className="block truncate text-muted">
                      {new Date(h.createdAt).toLocaleString()} · {h.requestCount} req ·{" "}
                      {formatBytes(h.totalBytes)} · {h.thirdPartyDomainCount} 3p
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => removeRun(h.id, e)}
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
        {!record && !running && (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed text-sm text-muted">
            Run a tag to see the report.
          </div>
        )}
        {running && !record && (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed text-sm text-muted">
            Launching browser, loading the tag, capturing traffic…
          </div>
        )}
        {record && <ResultView record={record} previous={previousRun} />}
      </div>
    </div>
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
