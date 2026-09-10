import { chromium } from "playwright-core";
import type {
  Browser,
  BrowserContext,
  Request as PWRequest,
  Response as PWResponse,
} from "playwright-core";
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

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

// One shared browser per mode — stealth needs different launch flags.
const browserPromises: Record<"normal" | "stealth", Promise<Browser> | null> = {
  normal: null,
  stealth: null,
};

// Vercel / AWS Lambda: no bundled Chromium and a read-only FS, so use the
// Lambda-sized build from @sparticuz/chromium. Locally we fall through to the
// browser that @playwright/browser-chromium downloaded on install.
const isServerless = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL);

// Drops the `navigator.webdriver` flag and the "automation" infobar so the
// browser reports like a normal Chrome (webdriver === false, not true).
const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins",
];

async function launchBrowser(stealth: boolean): Promise<Browser> {
  const extra = stealth ? STEALTH_ARGS : [];
  if (isServerless) {
    const { default: sparticuz } = await import("@sparticuz/chromium");
    sparticuz.setGraphicsMode = false;
    return chromium.launch({
      executablePath: await sparticuz.executablePath(),
      args: [...sparticuz.args, ...extra],
      headless: true,
    });
  }
  return chromium.launch({ headless: true, args: extra });
}

async function getBrowser(stealth: boolean): Promise<Browser> {
  const key = stealth ? "stealth" : "normal";
  if (!browserPromises[key]) {
    browserPromises[key] = launchBrowser(stealth).catch((err) => {
      browserPromises[key] = null;
      throw err;
    });
  }
  const browser = await browserPromises[key]!;
  if (!browser.isConnected()) {
    browserPromises[key] = null;
    return getBrowser(stealth);
  }
  return browser;
}

// A recent stable Chrome build to impersonate when stealth is on. Kept as a
// constant so the UA string and the Sec-CH-UA / userAgentData brands agree.
const STEALTH_CHROME_MAJOR = "152";
const STEALTH_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${STEALTH_CHROME_MAJOR}.0.0.0 Safari/537.36`;
const STEALTH_HEADERS: Record<string, string> = {
  "sec-ch-ua": `"Chromium";v="${STEALTH_CHROME_MAJOR}", "Google Chrome";v="${STEALTH_CHROME_MAJOR}", "Not?A_Brand";v="24"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

// Runs before any page script. Patches the headless "tells" that bot filters
// (including ViewSense's own IVT check: webdriver / fake_chrome / no_plugins).
const STEALTH_INIT = `(() => {
  const def = (obj, prop, get) => { try { Object.defineProperty(obj, prop, { get, configurable: true }); } catch (e) {} };

  if (!window.chrome) {
    window.chrome = { runtime: {}, app: { isInstalled: false }, csi: function () {}, loadTimes: function () {} };
  }

  def(navigator, 'languages', () => ['en-US', 'en']);
  def(navigator, 'hardwareConcurrency', () => 8);
  def(navigator, 'deviceMemory', () => 8);

  const mkPlugin = (name, filename, description) => {
    const p = Object.create(Plugin.prototype);
    def(p, 'name', () => name); def(p, 'filename', () => filename); def(p, 'description', () => description); def(p, 'length', () => 1);
    return p;
  };
  const plugins = [
    mkPlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
    mkPlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
    mkPlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
  ];
  const pluginArray = Object.create(PluginArray.prototype);
  plugins.forEach((p, i) => { pluginArray[i] = p; });
  def(pluginArray, 'length', () => plugins.length);
  pluginArray.item = (i) => plugins[i] || null;
  pluginArray.namedItem = (n) => plugins.find((p) => p.name === n) || null;
  def(navigator, 'plugins', () => pluginArray);
  def(navigator, 'mimeTypes', () => {
    const mt = Object.create(MimeTypeArray.prototype);
    const one = Object.create(MimeType.prototype);
    def(one, 'type', () => 'application/pdf'); def(one, 'suffixes', () => 'pdf'); def(one, 'description', () => '');
    mt[0] = one; def(mt, 'length', () => 1);
    mt.item = (i) => mt[i] || null; mt.namedItem = (n) => (n === 'application/pdf' ? one : null);
    return mt;
  });

  try {
    const q = navigator.permissions && navigator.permissions.query;
    if (q) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : q.call(navigator.permissions, p);
    }
  } catch (e) {}

  const patchGL = (proto) => {
    if (!proto) return;
    const gp = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return gp.call(this, p);
    };
  };
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  if (!window.outerWidth) def(window, 'outerWidth', () => window.innerWidth);
  if (!window.outerHeight) def(window, 'outerHeight', () => window.innerHeight + 74);

  if (navigator.userAgentData) {
    const brands = [
      { brand: 'Chromium', version: '${STEALTH_CHROME_MAJOR}' },
      { brand: 'Google Chrome', version: '${STEALTH_CHROME_MAJOR}' },
      { brand: 'Not?A_Brand', version: '24' },
    ];
    def(navigator, 'userAgentData', () => ({
      brands, mobile: false, platform: 'macOS',
      getHighEntropyValues: () => Promise.resolve({
        brands, mobile: false, platform: 'macOS', platformVersion: '13.5.0',
        architecture: 'x86', bitness: '64', model: '', uaFullVersion: '${STEALTH_CHROME_MAJOR}.0.0.0',
        fullVersionList: brands,
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'macOS' }),
    }));
  }
})();`;

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
    const browser = await getBrowser(options.stealth);
    context = await browser.newContext({
      viewport: { width: options.viewportWidth, height: options.viewportHeight },
      userAgent: options.stealth
        ? STEALTH_UA
        : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      ...(options.stealth
        ? { locale: "en-US", timezoneId: "America/New_York", extraHTTPHeaders: STEALTH_HEADERS }
        : {}),
      serviceWorkers: "block",
      bypassCSP: true,
    });
    context.setDefaultTimeout(options.timeoutMs);
    if (options.stealth) await context.addInitScript(STEALTH_INIT);

    // Serve the sandbox document for the first navigation.
    await context.route(`${SANDBOX_ORIGIN}/**`, async (route) => {
      if (route.request().url() === SANDBOX_URL) {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: doc });
        return;
      }
      await route.continue();
    });

    if (options.blockThirdParty) {
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith(SANDBOX_ORIGIN) || url.startsWith("data:") || url.startsWith("blob:")) {
          await route.continue();
          return;
        }
        await route.abort("blockedbyclient");
      });
    }

    const page = await context.newPage();
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
