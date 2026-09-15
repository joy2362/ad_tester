export type InputMode = "auto" | "script-tag" | "raw-html" | "script-url" | "iframe-url";

export type ResolvedInputType = "script-tag" | "raw-html" | "script-url" | "iframe-url";

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface NetTiming {
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  totalMs: number | null;
}

export interface NetRequest {
  url: string;
  domain: string;
  method: string;
  resourceType: string;
  status: number | null;
  statusText: string | null;
  fromCache: boolean;
  bytes: number;
  bodyBytes: number | null;
  timeMs: number | null;
  thirdParty: boolean;
  isRedirect: boolean;
  isSubframe: boolean;
  frameUrl: string | null;
  redirectChain: string[];
  failed: boolean;
  failureText: string | null;
  category: "creative" | "tracker" | "script" | "document" | "media" | "other";
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  timing: NetTiming | null;
  bodyPreview: string | null;
  bodyTruncated: boolean;
  passback: boolean;
}

export interface ConsoleMsg {
  type: string;
  text: string;
  location: string | null;
}

export interface CookieInfo {
  name: string;
  domain: string;
  thirdParty: boolean;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite: string;
}

export type CreativeKind = "image" | "video" | "iframe" | "canvas" | "text" | "unknown";

export interface RunMetrics {
  requestCount: number;
  totalBytes: number;
  thirdPartyDomains: string[];
  redirectCount: number;
  consoleErrorCount: number;
  pageErrorCount: number;
  cookieCount: number;
  thirdPartyCookieCount: number;
  domNodes: number;
  detectedCreative: CreativeKind[];
  insecureRequestCount: number;
  frameCount: number;
  popupCount: number;
  passbackRequestCount: number;
}

export interface PassbackReport {
  detected: boolean;
  signals: string[];
  chainDomains: string[];
}

export interface RunResult {
  durationMs: number;
  screenshot: string | null;
  finalDomHtml: string | null;
  metrics: RunMetrics;
  requests: NetRequest[];
  consoleMessages: ConsoleMsg[];
  pageErrors: string[];
  cookies: CookieInfo[];
  checks: Check[];
  frames: string[];
  popups: string[];
  passback: PassbackReport;
}

export interface RunOptions {
  viewportWidth: number;
  viewportHeight: number;
  timeoutMs: number;
  settleMs: number;
  blockThirdParty: boolean;
  captureBodies: boolean;
  stealth: boolean;
}

export interface RunRecord {
  id: string;
  createdAt: number;
  label: string | null;
  script: string;
  inputMode: InputMode;
  resolvedType: ResolvedInputType;
  options: RunOptions;
  status: "ok" | "error";
  error: string | null;
  result: RunResult | null;
}

export interface RunSummary {
  id: string;
  createdAt: number;
  label: string | null;
  resolvedType: ResolvedInputType;
  status: "ok" | "error";
  requestCount: number;
  totalBytes: number;
  thirdPartyDomainCount: number;
  consoleErrorCount: number;
  failCheckCount: number;
  warnCheckCount: number;
  durationMs: number;
  passbackDetected: boolean;
}

export const DEFAULT_OPTIONS: RunOptions = {
  viewportWidth: 800,
  viewportHeight: 600,
  timeoutMs: 20000,
  settleMs: 2500,
  blockThirdParty: false,
  captureBodies: true,
  stealth: false,
};

/* -------------------------- Site checker (live pages) -------------------------- */

/** One page to visit — a publisher portal + which page type on it (home, article, ...). */
export interface SitePageInput {
  id: string;
  portal: string;
  pageLabel: string;
  /**
   * The page to visit — or, when autoDiscoverArticle is set, the portal's HOME
   * page to start from. `finalUrl` on the result then shows which article it
   * actually ended up on.
   */
  url: string;
  /** Visit `url` as a home page, pick a same-site article link off it at random, then check that article instead. */
  autoDiscoverArticle?: boolean;
}

export interface SiteCheckOptions {
  viewportWidth: number;
  viewportHeight: number;
  timeoutMs: number;
  settleMs: number;
  fullPage: boolean;
  stealth: boolean;
  recordVideo: boolean;
  /**
   * Comma-separated domain(s) / URL substring(s) that identify "our ad" — e.g.
   * "delivery.viewsense.ai". Empty = skip the network-based serving check
   * (adStatus will be "unknown"); the DOM heuristic still runs either way.
   */
  adMatch: string;
  /** Drop the screenshot unless the ad was confirmed serving. */
  onlyScreenshotIfServing: boolean;
}

/**
 * Whether "our ad" was confirmed present on the page:
 * - "serving": a request matching adMatch got a real (non-passback) response
 * - "no_fill": matching request(s) seen, but all were passback/failed/non-2xx
 * - "not_detected": adMatch was set but no matching request was seen at all
 * - "unknown": no adMatch configured, so the network check didn't run
 */
export type AdStatus = "serving" | "no_fill" | "not_detected" | "unknown";

export interface SitePageResult extends SitePageInput {
  status: "ok" | "error";
  error: string | null;
  finalUrl: string | null;
  pageTitle: string | null;
  loadTimeMs: number | null;
  screenshot: string | null;
  screenshotBytes: number | null;
  screenshotOmitted: boolean;
  /** Only ever present in the immediate API response — never persisted (see lib/siteDb.ts). */
  video: string | null;
  videoBytes: number | null;
  adStatus: AdStatus;
  adReason: string;
  adRequestCount: number;
  /** DOM heuristic: a plausible ad element (iframe/ad-labeled container) with visible size was found and outlined in the screenshot. */
  adElementDetected: boolean;
  checkedAt: number;
}

export interface SiteBatchRecord {
  id: string;
  createdAt: number;
  label: string | null;
  options: SiteCheckOptions;
  pages: SitePageResult[];
}

export interface SiteBatchSummary {
  id: string;
  createdAt: number;
  label: string | null;
  pageCount: number;
  okCount: number;
  errorCount: number;
  servingCount: number;
  noFillCount: number;
}

export const DEFAULT_SITE_OPTIONS: SiteCheckOptions = {
  viewportWidth: 1280,
  viewportHeight: 900,
  timeoutMs: 25000,
  settleMs: 4000,
  fullPage: true,
  stealth: false,
  recordVideo: false,
  adMatch: "",
  onlyScreenshotIfServing: false,
};

export const PAGE_LABEL_SUGGESTIONS = [
  "Home page",
  "Article page",
  "Category page",
  "Search results",
  "Video page",
];
