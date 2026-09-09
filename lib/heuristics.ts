import type { Check, ConsoleMsg, CookieInfo, CreativeKind, NetRequest } from "./types";

// A small, non-exhaustive list of common ad-tech / tracking hosts.
const KNOWN_TRACKER_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googleadservices.com",
  "adservice.google.com",
  "adnxs.com",
  "adsrvr.org",
  "rubiconproject.com",
  "pubmatic.com",
  "casalemedia.com",
  "criteo.com",
  "criteo.net",
  "amazon-adsystem.com",
  "scorecardresearch.com",
  "moatads.com",
  "adsafeprotected.com",
  "serving-sys.com",
  "2mdn.net",
  "facebook.com/tr",
  "connect.facebook.net",
  "bat.bing.com",
  "taboola.com",
  "outbrain.com",
  "yieldmo.com",
  "smartadserver.com",
  "openx.net",
  "3lift.com",
  "bidswitch.net",
  "quantserve.com",
  "demdex.net",
  "everesttech.net",
  "hotjar.com",
  "segment.com",
  "segment.io",
  "branch.io",
  "flashtalking.com",
  "innovid.com",
  "sizmek.com",
];

export function categorizeRequest(url: string, resourceType: string): NetRequest["category"] {
  const lower = url.toLowerCase();
  if (KNOWN_TRACKER_HOSTS.some((h) => lower.includes(h))) return "tracker";
  if (/(\/|[?&])(pixel|impression|imp|beacon|track|collect|event|metrics|analytics|viewability|vast)([/?&=]|\.gif|\.png|$)/.test(lower)) {
    return "tracker";
  }
  if (resourceType === "image" || resourceType === "font") {
    // 1x1 / tiny tracking gifs often still report as image; keep as creative unless matched above.
    return "creative";
  }
  if (resourceType === "media") return "media";
  if (resourceType === "script") return "script";
  if (resourceType === "document" || resourceType === "iframe" || resourceType === "sub_frame") return "document";
  if (resourceType === "stylesheet") return "other";
  if (resourceType === "xhr" || resourceType === "fetch") {
    if (/beacon|collect|track|log|event/.test(lower)) return "tracker";
    return "other";
  }
  return "other";
}

interface HeuristicInput {
  requests: NetRequest[];
  consoleMessages: ConsoleMsg[];
  pageErrors: string[];
  cookies: CookieInfo[];
  detectedCreative: CreativeKind[];
  durationMs: number;
  totalBytes: number;
  redirectCount: number;
  rawScript: string;
}

const BYTE_BUDGET = 1_000_000; // 1 MB initial-load budget (IAB LEAN-ish)
const LOAD_BUDGET_MS = 5_000;
const REQUEST_BUDGET = 60;

export function runHeuristics(input: HeuristicInput): Check[] {
  const checks: Check[] = [];
  const {
    requests,
    consoleMessages,
    pageErrors,
    cookies,
    detectedCreative,
    durationMs,
    totalBytes,
    redirectCount,
    rawScript,
  } = input;

  const insecure = requests.filter((r) => r.url.startsWith("http://"));
  checks.push({
    id: "https-only",
    label: "All requests over HTTPS",
    status: insecure.length === 0 ? "pass" : "fail",
    detail:
      insecure.length === 0
        ? "No cleartext HTTP requests were made."
        : `${insecure.length} request(s) used insecure http://, which browsers block as mixed content on secure pages.`,
  });

  const failed = requests.filter((r) => r.failed);
  checks.push({
    id: "no-failed-requests",
    label: "No failed / blocked requests",
    status: failed.length === 0 ? "pass" : failed.length <= 2 ? "warn" : "fail",
    detail:
      failed.length === 0
        ? "Every request resolved."
        : `${failed.length} request(s) failed: ${failed.slice(0, 3).map((r) => shortUrl(r.url)).join(", ")}${failed.length > 3 ? "…" : ""}`,
  });

  checks.push({
    id: "payload-weight",
    label: "Payload under 1 MB",
    status: totalBytes <= BYTE_BUDGET ? "pass" : totalBytes <= BYTE_BUDGET * 2 ? "warn" : "fail",
    detail: `${formatBytes(totalBytes)} transferred across ${requests.length} request(s). Budget: ${formatBytes(
      BYTE_BUDGET,
    )}.`,
  });

  checks.push({
    id: "request-count",
    label: "Reasonable request count",
    status: requests.length <= REQUEST_BUDGET ? "pass" : requests.length <= REQUEST_BUDGET * 2 ? "warn" : "fail",
    detail: `${requests.length} request(s). Heavy tags chain many trackers; ${REQUEST_BUDGET} or fewer is healthy.`,
  });

  checks.push({
    id: "load-time",
    label: `Loads within ${LOAD_BUDGET_MS / 1000}s`,
    status: durationMs <= LOAD_BUDGET_MS ? "pass" : durationMs <= LOAD_BUDGET_MS * 2 ? "warn" : "fail",
    detail: `Sandbox settled in ${(durationMs / 1000).toFixed(1)}s (includes a fixed settle delay).`,
  });

  checks.push({
    id: "redirects",
    label: "Few redirect hops",
    status: redirectCount <= 3 ? "pass" : redirectCount <= 6 ? "warn" : "fail",
    detail: `${redirectCount} HTTP redirect(s) observed. Long redirect chains add latency and drop-off.`,
  });

  const errorConsole = consoleMessages.filter((m) => m.type === "error");
  checks.push({
    id: "console-clean",
    label: "No console errors",
    status: errorConsole.length === 0 && pageErrors.length === 0 ? "pass" : "warn",
    detail:
      errorConsole.length === 0 && pageErrors.length === 0
        ? "Console stayed clean during the run."
        : `${errorConsole.length} console error(s) and ${pageErrors.length} uncaught exception(s).`,
  });

  const thirdPartyCookies = cookies.filter((c) => c.thirdParty);
  checks.push({
    id: "third-party-cookies",
    label: "Third-party cookie usage",
    status: thirdPartyCookies.length === 0 ? "pass" : thirdPartyCookies.length <= 5 ? "warn" : "fail",
    detail:
      thirdPartyCookies.length === 0
        ? "No third-party cookies were set."
        : `${thirdPartyCookies.length} third-party cookie(s) set (${thirdPartyCookies
            .slice(0, 4)
            .map((c) => c.domain)
            .join(", ")}). These are increasingly blocked by browsers.`,
  });

  const hasClickMacro = /(%%CLICK_URL[^%]*%%|\$\{CLICK_URL[^}]*\}|\[timestamp\]|%%CACHEBUSTER%%|\bclickTag\b|\bCLICK_URL_UNESC\b)/i.test(
    rawScript,
  );
  checks.push({
    id: "click-macro",
    label: "Click / cachebuster macro present",
    status: hasClickMacro ? "pass" : "info",
    detail: hasClickMacro
      ? "Found a clickTag / CLICK_URL / cachebuster macro — good for click tracking."
      : "No clickTag or CLICK_URL macro detected. Fine for pixels; required for most display creatives.",
  });

  const usesDocWrite = /document\.write\s*\(/i.test(rawScript);
  checks.push({
    id: "document-write",
    label: "Avoids document.write()",
    status: usesDocWrite ? "warn" : "pass",
    detail: usesDocWrite
      ? "Tag calls document.write(). Chrome intervenes against document.write in parser-blocking scripts on slow connections."
      : "No document.write() in the pasted tag.",
  });

  checks.push({
    id: "creative-rendered",
    label: "Creative rendered something",
    status: detectedCreative.length && !detectedCreative.includes("unknown") ? "pass" : detectedCreative.length ? "info" : "warn",
    detail: detectedCreative.length
      ? `Detected: ${detectedCreative.join(", ")}.`
      : "No image, video, iframe, canvas or visible text was detected in the ad container.",
  });

  return checks;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname.length > 1 ? u.pathname.slice(0, 24) : "");
  } catch {
    return url.slice(0, 40);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
