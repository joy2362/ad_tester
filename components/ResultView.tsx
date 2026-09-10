"use client";

import { Fragment, useState } from "react";
import type { Check, ConsoleMsg, CookieInfo, NetRequest, RunRecord, RunSummary } from "@/lib/types";
import { formatBytes } from "@/lib/heuristics";
import SandboxPreview from "@/components/SandboxPreview";

type Tab = "overview" | "preview" | "network" | "console" | "cookies" | "dom";

const TABS: { id: Tab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "overview", label: "Overview" },
  { id: "network", label: "Network" },
  { id: "console", label: "Console" },
  { id: "cookies", label: "Cookies" },
  { id: "dom", label: "DOM" },
];

const CHECK_COLOR: Record<Check["status"], string> = {
  pass: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  info: "text-muted",
};
const CHECK_ICON: Record<Check["status"], string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
  info: "·",
};

const CATEGORY_COLOR: Record<NetRequest["category"], string> = {
  creative: "bg-ok/15 text-ok",
  tracker: "bg-fail/15 text-fail",
  script: "bg-warn/15 text-warn",
  document: "bg-accent/15 text-accent",
  media: "bg-ok/15 text-ok",
  other: "bg-muted/15 text-muted",
};

export default function ResultView({
  record,
  previous,
}: {
  record: RunRecord;
  previous: RunSummary | null;
}) {
  const [tab, setTab] = useState<Tab>("preview");
  const r = record.result;

  if (!r) {
    return (
      <div className="rounded-lg border border-fail/40 bg-fail/10 p-4 text-sm text-fail">
        Run failed: {record.error ?? "unknown error"}
      </div>
    );
  }

  const m = r.metrics;
  const failCount = r.checks.filter((c) => c.status === "fail").length;
  const warnCount = r.checks.filter((c) => c.status === "warn").length;

  return (
    <div className="rounded-lg border bg-panel">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              record.status === "error" ? "bg-fail" : failCount ? "bg-warn" : "bg-ok"
            }`}
          />
          <span className="text-sm font-semibold">{record.label || "Untitled run"}</span>
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">
            {record.resolvedType}
          </span>
        </div>
        <span className="text-xs text-muted">
          {new Date(record.createdAt).toLocaleString()} · {(r.durationMs / 1000).toFixed(1)}s ·{" "}
          {failCount} fail / {warnCount} warn
        </span>
      </div>

      <nav className="flex gap-1 border-b px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-t-md px-3 py-1.5 text-xs ${
              tab === t.id
                ? "border border-b-0 border-border bg-panel text-foreground"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
            {t.id === "network" && ` (${m.requestCount})`}
            {t.id === "console" && ` (${r.consoleMessages.length + r.pageErrors.length})`}
            {t.id === "cookies" && ` (${m.cookieCount})`}
          </button>
        ))}
      </nav>

      <div className="p-4">
        {tab === "overview" && (
          <Overview record={record} failCount={failCount} warnCount={warnCount} previous={previous} />
        )}
        {tab === "preview" && (
          <div className="flex flex-col gap-4">
            {r.screenshot ? (
              <figure className="rounded-lg border bg-panel-2 p-3">
                <figcaption className="mb-2 text-[11px] text-muted">
                  Headless screenshot ({record.options.viewportWidth}×{record.options.viewportHeight})
                </figcaption>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.screenshot}
                  alt="Ad screenshot"
                  className="max-w-full rounded border"
                />
              </figure>
            ) : (
              <p className="text-sm text-muted">No screenshot captured.</p>
            )}
            <SandboxPreview
              script={record.script}
              mode={record.inputMode}
              width={record.options.viewportWidth}
              height={record.options.viewportHeight}
            />
          </div>
        )}
        {tab === "network" && <NetworkTable requests={r.requests} />}
        {tab === "console" && (
          <ConsolePane messages={r.consoleMessages} errors={r.pageErrors} />
        )}
        {tab === "cookies" && <CookieTable cookies={r.cookies} />}
        {tab === "dom" && (
          <pre className="max-h-[520px] overflow-auto rounded-md border bg-panel-2 p-3 text-[11.5px] leading-relaxed text-foreground">
            {r.finalDomHtml || "(empty)"}
          </pre>
        )}
      </div>
    </div>
  );
}

function Overview({
  record,
  failCount,
  warnCount,
  previous,
}: {
  record: RunRecord;
  failCount: number;
  warnCount: number;
  previous: RunSummary | null;
}) {
  const r = record.result!;
  const m = r.metrics;

  const tiles: { label: string; value: string; delta?: number; invert?: boolean }[] = [
    { label: "Requests", value: String(m.requestCount), delta: diff(m.requestCount, previous?.requestCount), invert: true },
    { label: "Transferred", value: formatBytes(m.totalBytes), delta: diff(m.totalBytes, previous?.totalBytes), invert: true },
    {
      label: "3rd-party domains",
      value: String(m.thirdPartyDomains.length),
      delta: diff(m.thirdPartyDomains.length, previous?.thirdPartyDomainCount),
      invert: true,
    },
    { label: "Redirects", value: String(m.redirectCount), invert: true },
    {
      label: "Console errors",
      value: String(m.consoleErrorCount + m.pageErrorCount),
      delta: diff(m.consoleErrorCount, previous?.consoleErrorCount),
      invert: true,
    },
    { label: "Cookies (3p)", value: `${m.cookieCount} (${m.thirdPartyCookieCount})`, invert: true },
    { label: "Insecure http://", value: String(m.insecureRequestCount), invert: true },
    { label: "Nested frames", value: String(m.frameCount ?? 0), invert: true },
    { label: "Popups", value: String(m.popupCount ?? 0), invert: true },
    { label: "DOM nodes", value: String(m.domNodes) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border bg-panel-2 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted">{t.label}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-lg font-semibold">{t.value}</span>
              {typeof t.delta === "number" && t.delta !== 0 && (
                <span
                  className={`text-[11px] ${
                    (t.delta > 0) === Boolean(t.invert) ? "text-fail" : "text-ok"
                  }`}
                >
                  {t.delta > 0 ? "+" : ""}
                  {t.delta}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          <span className="font-semibold uppercase tracking-wider">Creative detected:</span>
          {m.detectedCreative.map((c) => (
            <span key={c} className="rounded bg-panel-2 px-1.5 py-0.5 text-foreground">
              {c}
            </span>
          ))}
        </div>
        {m.thirdPartyDomains.length > 0 && (
          <div className="text-xs text-muted">
            <span className="font-semibold uppercase tracking-wider">Talked to:</span>{" "}
            <span className="text-foreground">{m.thirdPartyDomains.join(", ")}</span>
          </div>
        )}
      </div>

      {r.passback?.detected && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-warn">
            Passback / no-fill detected
          </div>
          <p className="text-xs text-foreground">
            {r.checks.find((c) => c.id === "passback-handled")?.detail ??
              "The tag handed back to a fallback ad source."}
          </p>
          {r.passback.chainDomains.length > 1 && (
            <p className="mt-1 text-xs text-muted">
              Chain: {r.passback.chainDomains.join(" → ")}
            </p>
          )}
          <ul className="mt-1 list-disc pl-4 text-xs text-muted">
            {r.passback.signals.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {(r.frames?.length > 0 || r.popups?.length > 0) && (
        <div className="text-xs text-muted">
          {r.frames?.length > 0 && (
            <div>
              <span className="font-semibold uppercase tracking-wider">Nested frames:</span>{" "}
              <span className="break-all text-foreground">{r.frames.join("  ·  ")}</span>
            </div>
          )}
          {r.popups?.length > 0 && (
            <div className="mt-1">
              <span className="font-semibold uppercase tracking-wider">Popups opened:</span>{" "}
              <span className="break-all text-foreground">{r.popups.join("  ·  ")}</span>
            </div>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
          Checks — {failCount} fail, {warnCount} warn
        </h3>
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {r.checks.map((c) => (
            <li key={c.id} className="flex gap-3 p-3">
              <span className={`mt-0.5 font-mono text-sm ${CHECK_COLOR[c.status]}`}>
                {CHECK_ICON[c.status]}
              </span>
              <div>
                <div className="text-sm text-foreground">{c.label}</div>
                <div className="text-xs text-muted">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {record.error && (
        <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
          Note: {record.error}
        </p>
      )}
    </div>
  );
}

function diff(current: number, prev?: number): number | undefined {
  if (typeof prev !== "number") return undefined;
  return current - prev;
}

function NetworkTable({ requests }: { requests: NetRequest[] }) {
  const [filter, setFilter] = useState<"all" | "passback" | NetRequest["category"]>("all");
  const [open, setOpen] = useState<number | null>(null);
  const cats = Array.from(new Set(requests.map((r) => r.category)));
  const passbackCount = requests.filter((r) => r.passback).length;
  const shown =
    filter === "all"
      ? requests
      : filter === "passback"
        ? requests.filter((r) => r.passback)
        : requests.filter((r) => r.category === filter);

  if (requests.length === 0) return <p className="text-sm text-muted">No network requests were made.</p>;

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          all ({requests.length})
        </FilterChip>
        {passbackCount > 0 && (
          <FilterChip active={filter === "passback"} onClick={() => setFilter("passback")}>
            <span className="text-fail">passback ({passbackCount})</span>
          </FilterChip>
        )}
        {cats.map((c) => (
          <FilterChip key={c} active={filter === c} onClick={() => setFilter(c)}>
            {c} ({requests.filter((r) => r.category === c).length})
          </FilterChip>
        ))}
      </div>
      <p className="mb-2 text-[11px] text-muted">Click a row for headers, timing and body.</p>
      <div className="max-h-[560px] overflow-auto rounded-md border">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel-2 text-muted">
            <tr>
              <th className="p-2 font-medium">#</th>
              <th className="p-2 font-medium">Type</th>
              <th className="p-2 font-medium">Method</th>
              <th className="p-2 font-medium">Domain</th>
              <th className="p-2 font-medium">URL</th>
              <th className="p-2 font-medium">Status</th>
              <th className="p-2 text-right font-medium">Size</th>
              <th className="p-2 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((req, i) => {
              const isOpen = open === i;
              return (
                <Fragment key={i}>
                  <tr
                    onClick={() => setOpen(isOpen ? null : i)}
                    className={`cursor-pointer border-t border-border align-top hover:bg-panel-2/60 ${
                      isOpen ? "bg-panel-2/60" : ""
                    }`}
                  >
                    <td className="p-2 text-muted">
                      <span className="mr-1 inline-block w-2 text-muted">{isOpen ? "▾" : "▸"}</span>
                      {i + 1}
                    </td>
                    <td className="p-2">
                      <span className={`rounded px-1.5 py-0.5 ${CATEGORY_COLOR[req.category]}`}>
                        {req.category}
                      </span>
                      <span className="ml-1 text-muted">{req.resourceType}</span>
                      {req.passback && (
                        <span className="ml-1 rounded bg-fail/15 px-1 py-0.5 text-fail">passback</span>
                      )}
                      {req.isSubframe && (
                        <span className="ml-1 rounded bg-accent/15 px-1 py-0.5 text-accent">subframe</span>
                      )}
                    </td>
                    <td className="p-2 text-muted">{req.method}</td>
                    <td className={`p-2 ${req.thirdParty ? "text-accent" : "text-muted"}`}>{req.domain}</td>
                    <td className="max-w-[280px] truncate p-2 text-muted" title={req.url}>
                      {stripDomain(req.url)}
                    </td>
                    <td className="p-2">
                      {req.failed ? (
                        <span className="text-fail" title={req.failureText ?? ""}>
                          failed
                        </span>
                      ) : req.isRedirect ? (
                        <span className="text-warn">{req.status} ↪</span>
                      ) : (
                        <span className={statusColor(req.status)}>{req.status ?? "—"}</span>
                      )}
                    </td>
                    <td className="p-2 text-right text-muted">{req.bytes ? formatBytes(req.bytes) : "—"}</td>
                    <td className="p-2 text-right text-muted">
                      {req.timeMs != null ? `${req.timeMs} ms` : "—"}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-border bg-panel">
                      <td colSpan={8} className="p-3">
                        <RequestDetail req={req} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RequestDetail({ req }: { req: NetRequest }) {
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <Kv k="URL">
          <span className="break-all font-mono text-foreground">{req.url}</span>
        </Kv>
        <Kv k="Method">{req.method}</Kv>
        <Kv k="Status">
          {req.failed
            ? `failed — ${req.failureText ?? ""}`
            : `${req.status ?? "—"}${req.statusText ? ` ${req.statusText}` : ""}`}
        </Kv>
        <Kv k="Category">
          {req.category} · {req.resourceType}
        </Kv>
        <Kv k="Party">{req.thirdParty ? "third-party" : "first-party"}</Kv>
        <Kv k="Frame">{req.isSubframe ? req.frameUrl || "nested frame" : "top sandbox"}</Kv>
        <Kv k="Transferred">{req.bytes ? formatBytes(req.bytes) : "—"}</Kv>
        <Kv k="Body size">{req.bodyBytes != null ? formatBytes(req.bodyBytes) : "—"}</Kv>
      </div>

      {(req.redirectChain?.length ?? 0) > 0 && (
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wider text-muted">Redirect chain</div>
          <ol className="list-decimal pl-5 font-mono text-[11px] text-muted">
            {req.redirectChain.map((u, i) => (
              <li key={i} className="break-all">
                {u}
              </li>
            ))}
            <li className="break-all text-foreground">{req.url}</li>
          </ol>
        </div>
      )}

      {req.timing && (
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wider text-muted">Timing</div>
          <div className="flex flex-col gap-0.5 font-mono text-[11px]">
            <TimingRow label="DNS" ms={req.timing.dnsMs} />
            <TimingRow label="Connect" ms={req.timing.connectMs} />
            <TimingRow label="TLS" ms={req.timing.tlsMs} />
            <TimingRow label="Wait (TTFB)" ms={req.timing.ttfbMs} />
            <TimingRow label="Download" ms={req.timing.downloadMs} />
            <TimingRow label="Total" ms={req.timing.totalMs} strong />
          </div>
        </div>
      )}

      <HeaderBlock title="Request headers" headers={req.requestHeaders} />
      <HeaderBlock title="Response headers" headers={req.responseHeaders} />

      {req.bodyPreview != null && (
        <div>
          <div className="mb-1 font-semibold uppercase tracking-wider text-muted">
            Response body{req.bodyTruncated ? " (truncated)" : ""}
          </div>
          <pre className="max-h-72 overflow-auto rounded border bg-panel-2 p-2 text-[11px] leading-relaxed text-foreground">
            {req.bodyPreview}
          </pre>
        </div>
      )}
      {req.bodyPreview == null && req.bodyTruncated && (
        <p className="text-[11px] text-muted">Body was captured but dropped to keep the run small.</p>
      )}
    </div>
  );
}

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 font-semibold uppercase tracking-wider text-muted">{k}</span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

function TimingRow({ label, ms, strong }: { label: string; ms: number | null; strong?: boolean }) {
  const width = ms != null ? Math.min(100, Math.max(2, ms / 20)) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <span className="h-2 w-40 overflow-hidden rounded bg-panel-2">
        <span
          className={`block h-full ${strong ? "bg-accent" : "bg-accent/50"}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className={strong ? "text-foreground" : "text-muted"}>{ms != null ? `${ms} ms` : "—"}</span>
    </div>
  );
}

function HeaderBlock({ title, headers }: { title: string; headers: Record<string, string> }) {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="mb-1 font-semibold uppercase tracking-wider text-muted">{title}</div>
      <div className="max-h-52 overflow-auto rounded border bg-panel-2">
        <table className="w-full border-collapse font-mono text-[11px]">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-t border-border first:border-t-0">
                <td className="whitespace-nowrap p-1.5 pr-3 align-top text-muted">{k}</td>
                <td className="break-all p-1.5 text-foreground">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConsolePane({ messages, errors }: { messages: ConsoleMsg[]; errors: string[] }) {
  if (messages.length === 0 && errors.length === 0)
    return <p className="text-sm text-muted">Console stayed clean.</p>;
  return (
    <div className="flex flex-col gap-3">
      {errors.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-fail">
            Uncaught exceptions
          </h3>
          <ul className="flex flex-col gap-1">
            {errors.map((e, i) => (
              <li key={i} className="rounded border border-fail/30 bg-fail/10 p-2 font-mono text-[11.5px] text-fail">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
          Console output
        </h3>
        <ul className="max-h-[440px] overflow-auto rounded-md border">
          {messages.map((mLine, i) => (
            <li
              key={i}
              className="flex gap-2 border-t border-border p-2 font-mono text-[11.5px] first:border-t-0"
            >
              <span
                className={
                  mLine.type === "error"
                    ? "text-fail"
                    : mLine.type === "warning"
                      ? "text-warn"
                      : "text-muted"
                }
              >
                {mLine.type}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-words text-foreground">{mLine.text}</span>
              {mLine.location && <span className="shrink-0 text-muted">{mLine.location}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CookieTable({ cookies }: { cookies: CookieInfo[] }) {
  if (cookies.length === 0) return <p className="text-sm text-muted">No cookies were set.</p>;
  return (
    <div className="max-h-[520px] overflow-auto rounded-md border">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-panel-2 text-muted">
          <tr>
            <th className="p-2 font-medium">Name</th>
            <th className="p-2 font-medium">Domain</th>
            <th className="p-2 font-medium">Party</th>
            <th className="p-2 font-medium">SameSite</th>
            <th className="p-2 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {cookies.map((c, i) => (
            <tr key={i} className="border-t border-border hover:bg-panel-2/60">
              <td className="p-2 font-mono text-foreground">{c.name}</td>
              <td className="p-2 text-muted">{c.domain}</td>
              <td className={`p-2 ${c.thirdParty ? "text-accent" : "text-muted"}`}>
                {c.thirdParty ? "third-party" : "first-party"}
              </td>
              <td className="p-2 text-muted">{c.sameSite}</td>
              <td className="p-2 text-muted">
                {[c.secure && "Secure", c.httpOnly && "HttpOnly", c.session ? "Session" : "Persistent"]
                  .filter(Boolean)
                  .join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      onClick={onClick}
      className={`rounded border px-2 py-0.5 ${
        active ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function statusColor(status: number | null): string {
  if (status == null) return "text-muted";
  if (status >= 200 && status < 300) return "text-ok";
  if (status >= 400) return "text-fail";
  return "text-warn";
}

function stripDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
