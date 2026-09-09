export type InputMode = "auto" | "script-tag" | "raw-html" | "script-url" | "iframe-url";

export type ResolvedInputType = "script-tag" | "raw-html" | "script-url" | "iframe-url";

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface NetRequest {
  url: string;
  domain: string;
  method: string;
  resourceType: string;
  status: number | null;
  fromCache: boolean;
  bytes: number;
  timeMs: number | null;
  thirdParty: boolean;
  isRedirect: boolean;
  failed: boolean;
  failureText: string | null;
  category: "creative" | "tracker" | "script" | "document" | "media" | "other";
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
}

export interface RunOptions {
  viewportWidth: number;
  viewportHeight: number;
  timeoutMs: number;
  settleMs: number;
  blockThirdParty: boolean;
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
}

export const DEFAULT_OPTIONS: RunOptions = {
  viewportWidth: 800,
  viewportHeight: 600,
  timeoutMs: 20000,
  settleMs: 2500,
  blockThirdParty: false,
};
