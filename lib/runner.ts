import type { BrowserContext, Page, Request as PWRequest, Response as PWResponse } from "playwright-core";
import { DEFAULT_UA, STEALTH_HEADERS, STEALTH_INIT, STEALTH_UA, withBrowser, withTimeout } from "./browser";
import { buildSandboxDocument, resolveInputType, SANDBOX_ORIGIN, SANDBOX_URL } from "./input";
import { buildPassbackReport, categorizeRequest, looksLikePassback, runHeuristics } from "./heuristics";
import type {
  ConsoleMsg,
  CookieInfo,
  CreativeKind,
  InputMode,
  NetRequest,
  NetTiming,
  RunOptions,
  RunResult,
} from "./types";

// Response-body capture budget — keeps the stored run JSON small.
const MAX_BODY_PREVIEW = 12_000; // chars per response
const MAX_TOTAL_BODY = 350_000; // chars across the whole run
const MAX_BODIES = 60; // number of responses to read
const BODYABLE = new Set(["document", "script", "xhr", "fetch", "sub_frame", "other", "eventsource"]);

function timingBreakdown(t: ReturnType<PWRequest["timing"]> | null): NetTiming | null {
  if (!t || t.responseEnd < 0) return null;
  const nn = (v: number) => (v >= 0 ? Math.round(v) : null);
  const span = (a: number, b: number) => (a >= 0 && b >= a ? Math.round(b - a) : null);
  return {
    dnsMs: span(t.domainLookupStart, t.domainLookupEnd),
    connectMs: span(t.connectStart, t.connectEnd),
    tlsMs: span(t.secureConnectionStart, t.connectEnd),
    ttfbMs: span(t.requestStart, t.responseStart),
    downloadMs: span(t.responseStart, t.responseEnd),
    totalMs: nn(t.responseEnd),
  };
}

const SANDBOX_HOST = new URL(SANDBOX_ORIGIN).host;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isThirdParty(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return host !== SANDBOX_HOST;
}

export interface RunnerOutcome {
  status: "ok" | "error";
  error: string | null;
  result: RunResult | null;
}

export async function executeRun(
  rawScript: string,
  mode: InputMode,
  options: RunOptions,
): Promise<RunnerOutcome> {
  const resolvedType = resolveInputType(rawScript, mode);
  const doc = buildSandboxDocument(rawScript, resolvedType);

  const started = Date.now();
  let context: BrowserContext | null = null;

  const requestsByObj = new Map<PWRequest, NetRequest>();
  const consoleMessages: ConsoleMsg[] = [];
  const pageErrors: string[] = [];
  const frameUrls = new Set<string>();
  const popups: string[] = [];
  const bodyReads: Promise<void>[] = [];
  let redirectCount = 0;
  let totalBodyChars = 0;
  let bodiesRead = 0;

  try {
    // withBrowser retries once with a freshly launched browser if the shared
    // singleton died between serverless invocations (see lib/browser.ts).
    const opened = await withBrowser(async (browser) => {
      const ctx = await browser.newContext({
        viewport: { width: options.viewportWidth, height: options.viewportHeight },
        userAgent: options.stealth ? STEALTH_UA : DEFAULT_UA,
        ...(options.stealth
          ? { locale: "en-US", timezoneId: "America/New_York", extraHTTPHeaders: STEALTH_HEADERS }
          : {}),
        serviceWorkers: "block",
        bypassCSP: true,
      });
      ctx.setDefaultTimeout(options.timeoutMs);
      if (options.stealth) await ctx.addInitScript(STEALTH_INIT);

      // Serve the sandbox document for the first navigation.
      await ctx.route(`${SANDBOX_ORIGIN}/**`, async (route) => {
        if (route.request().url() === SANDBOX_URL) {
          await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: doc });
          return;
        }
        await route.continue();
      });

      if (options.blockThirdParty) {
        await ctx.route("**/*", async (route) => {
          const url = route.request().url();
          if (url.startsWith(SANDBOX_ORIGIN) || url.startsWith("data:") || url.startsWith("blob:")) {
            await route.continue();
            return;
          }
          await route.abort("blockedbyclient");
        });
      }

      const pg = await ctx.newPage();
      return { ctx, pg };
    });
    context = opened.ctx;
    const page: Page = opened.pg;
    const mainFrame = page.mainFrame();

    page.on("framenavigated", (frame) => {
      if (frame === mainFrame) return;
      const url = frame.url();
      if (url && !url.startsWith("about:") && url !== SANDBOX_URL) frameUrls.add(url);
    });

    page.on("popup", async (popup) => {
      const initial = popup.url() || "about:blank";
      popups.push(initial);
      try {
        await popup.waitForLoadState("domcontentloaded", { timeout: 3000 });
        const settled = popup.url();
        if (settled && settled !== initial) popups[popups.length - 1] = settled;
      } catch {
        /* ignore */
      }
      await popup.close().catch(() => {});
    });

    page.on("request", (req) => {
      if (req.url() === SANDBOX_URL) return;
      const frame = req.frame();
      const redirectChain: string[] = [];
      let rf = req.redirectedFrom();
      while (rf) {
        redirectChain.unshift(rf.url());
        rf = rf.redirectedFrom();
      }
      requestsByObj.set(req, {
        url: req.url(),
        domain: hostOf(req.url()),
        method: req.method(),
        resourceType: req.resourceType(),
        status: null,
        statusText: null,
        fromCache: false,
        bytes: 0,
        bodyBytes: null,
        timeMs: null,
        thirdParty: isThirdParty(req.url()),
        isRedirect: false,
        isSubframe: Boolean(frame) && frame !== mainFrame,
        frameUrl: frame && frame !== mainFrame ? frame.url() || null : null,
        redirectChain,
        failed: false,
        failureText: null,
        category: categorizeRequest(req.url(), req.resourceType()),
        requestHeaders: req.headers(),
        responseHeaders: {},
        timing: null,
        bodyPreview: null,
        bodyTruncated: false,
        passback: false,
      });
      if (redirectChain.length) redirectCount += 1;
    });

    page.on("response", (res) => {
      const entry = requestsByObj.get(res.request());
      if (!entry) return;
      entry.status = res.status();
      entry.statusText = res.statusText() || null;
      entry.responseHeaders = res.headers();
      if (res.status() >= 300 && res.status() < 400) entry.isRedirect = true;
      entry.fromCache = res.fromServiceWorker() === false && res.request().timing().responseStart < 0;
      maybeCaptureBody(entry, res);
    });

    function maybeCaptureBody(entry: NetRequest, res: PWResponse) {
      const scanOnly = !options.captureBodies;
      if (entry.isRedirect) return;
      if (!BODYABLE.has(entry.resourceType)) return;
      if (bodiesRead >= MAX_BODIES || totalBodyChars >= MAX_TOTAL_BODY) return;
      bodiesRead += 1;
      bodyReads.push(
        withTimeout(res.body(), 2500, Buffer.alloc(0))
          .then((buf) => {
            if (!buf.length) return;
            entry.bodyBytes = buf.length;
            const text = buf.toString("utf8");
            const pb = looksLikePassback(text, entry.domain, entry.status);
            if (pb.hit) entry.passback = true;
            if (scanOnly) return;
            const room = Math.min(MAX_BODY_PREVIEW, MAX_TOTAL_BODY - totalBodyChars);
            entry.bodyPreview = text.slice(0, room);
            entry.bodyTruncated = text.length > entry.bodyPreview.length;
            totalBodyChars += entry.bodyPreview.length;
          })
          .catch(() => {}),
      );
    }

    page.on("requestfailed", (req) => {
      const entry = requestsByObj.get(req);
      if (!entry) return;
      entry.failed = true;
      entry.failureText = req.failure()?.errorText ?? "failed";
    });

    page.on("requestfinished", async (req) => {
      const entry = requestsByObj.get(req);
      if (!entry) return;
      try {
        const sizes = await req.sizes();
        entry.bytes = Math.max(sizes.responseBodySize + sizes.responseHeadersSize, 0);
      } catch {
        /* ignore */
      }
      const timing = req.timing();
      if (timing && timing.responseEnd > 0 && timing.startTime >= 0) {
        entry.timeMs = Math.round(timing.responseEnd);
      }
      entry.timing = timingBreakdown(timing);
    });

    page.on("console", (msg) => {
      if (consoleMessages.length > 400) return;
      const loc = msg.location();
      consoleMessages.push({
        type: msg.type(),
        text: msg.text().slice(0, 2000),
        location: loc?.url ? `${shortLoc(loc.url)}:${loc.lineNumber}` : null,
      });
    });

    page.on("pageerror", (err) => {
      if (pageErrors.length > 100) return;
      pageErrors.push(`${err.name}: ${err.message}`.slice(0, 2000));
    });

    let navError: string | null = null;
    try {
      await page.goto(SANDBOX_URL, { waitUntil: "load", timeout: options.timeoutMs });
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
    }

    // Let async ad calls settle.
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(options.settleMs + 4000, options.timeoutMs) });
    } catch {
      /* networkidle may never happen with polling trackers — that's fine */
    }
    await page.waitForTimeout(options.settleMs);

    // Drain any in-flight response-body reads (bounded by their own 2.5s guards).
    await withTimeout(Promise.allSettled(bodyReads).then(() => undefined), 6000, undefined);

    const emptyDom = { domNodes: 0, kinds: [] as string[], html: null as string | null };
    const domStats = await withTimeout(
      page
        .evaluate(() => {
          const container = document.getElementById("ad-tester-container");
          const scope: ParentNode = container ?? document.body;
          const kinds = new Set<string>();
          const imgs = Array.from(scope.querySelectorAll("img")).filter(
            (n) => (n as HTMLImageElement).currentSrc || n.getAttribute("src"),
          );
          if (imgs.length) kinds.add("image");
          if (scope.querySelectorAll("video").length) kinds.add("video");
          if (scope.querySelectorAll("iframe").length) kinds.add("iframe");
          if (scope.querySelectorAll("canvas").length) kinds.add("canvas");
          const text = (container?.textContent ?? "").replace(/\s+/g, " ").trim();
          if (text.length > 12) kinds.add("text");
          return {
            domNodes: document.getElementsByTagName("*").length,
            kinds: Array.from(kinds),
            html: (container?.innerHTML ?? "").slice(0, 20000),
          };
        })
        .catch(() => emptyDom),
      5000,
      emptyDom,
    );

    // Nested frames that survived to the end (a passback usually renders in one).
    for (const f of page.frames()) {
      if (f === mainFrame) continue;
      const u = f.url();
      if (u && !u.startsWith("about:") && u !== SANDBOX_URL) frameUrls.add(u);
    }

    let screenshot: string | null = null;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      screenshot = `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch {
      /* ignore screenshot failure */
    }

    const rawCookies = await context.cookies().catch(() => []);
    const cookies: CookieInfo[] = rawCookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      thirdParty: !c.domain.replace(/^\./, "").endsWith(SANDBOX_HOST),
      secure: c.secure,
      httpOnly: c.httpOnly,
      session: c.expires === -1,
      sameSite: c.sameSite ?? "None",
    }));

    const requests = Array.from(requestsByObj.values()).sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));
    const totalBytes = requests.reduce((sum, r) => sum + r.bytes, 0);
    const thirdPartyDomains = Array.from(
      new Set(requests.filter((r) => r.thirdParty && r.domain).map((r) => r.domain)),
    ).sort();
    const detectedCreative: CreativeKind[] = (domStats.kinds.length
      ? domStats.kinds
      : ["unknown"]) as CreativeKind[];
    const insecureRequestCount = requests.filter((r) => r.url.startsWith("http://")).length;
    const consoleErrorCount = consoleMessages.filter((m) => m.type === "error").length;

    const durationMs = Date.now() - started;
    const frames = Array.from(frameUrls);
    const passback = buildPassbackReport(requests, consoleMessages);

    const checks = runHeuristics({
      requests,
      consoleMessages,
      pageErrors,
      cookies,
      detectedCreative,
      durationMs,
      totalBytes,
      redirectCount,
      rawScript,
      passback,
    });

    const result: RunResult = {
      durationMs,
      screenshot,
      finalDomHtml: domStats.html,
      metrics: {
        requestCount: requests.length,
        totalBytes,
        thirdPartyDomains,
        redirectCount,
        consoleErrorCount,
        pageErrorCount: pageErrors.length,
        cookieCount: cookies.length,
        thirdPartyCookieCount: cookies.filter((c) => c.thirdParty).length,
        domNodes: domStats.domNodes,
        detectedCreative,
        insecureRequestCount,
        frameCount: frames.length,
        popupCount: popups.length,
        passbackRequestCount: requests.filter((r) => r.passback).length,
      },
      requests,
      consoleMessages,
      pageErrors: navError ? [...pageErrors, `Navigation: ${navError}`] : pageErrors,
      cookies,
      checks,
      frames,
      popups,
      passback,
    };

    return { status: "ok", error: navError, result };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      result: null,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

function shortLoc(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}
