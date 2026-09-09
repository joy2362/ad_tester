import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Request as PWRequest } from "playwright-core";
import { buildSandboxDocument, resolveInputType, SANDBOX_ORIGIN, SANDBOX_URL } from "./input";
import { categorizeRequest, runHeuristics } from "./heuristics";
import type {
  ConsoleMsg,
  CookieInfo,
  CreativeKind,
  InputMode,
  NetRequest,
  RunOptions,
  RunResult,
} from "./types";

let browserPromise: Promise<Browser> | null = null;

// Vercel / AWS Lambda: no bundled Chromium and a read-only FS, so use the
// Lambda-sized build from @sparticuz/chromium. Locally we fall through to the
// browser that @playwright/browser-chromium downloaded on install.
const isServerless = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL);

async function launchBrowser(): Promise<Browser> {
  if (isServerless) {
    const { default: sparticuz } = await import("@sparticuz/chromium");
    sparticuz.setGraphicsMode = false;
    return chromium.launch({
      executablePath: await sparticuz.executablePath(),
      args: sparticuz.args,
      headless: true,
    });
  }
  return chromium.launch({ headless: true });
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
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
  let redirectCount = 0;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: options.viewportWidth, height: options.viewportHeight },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      serviceWorkers: "block",
      bypassCSP: true,
    });
    context.setDefaultTimeout(options.timeoutMs);

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

    page.on("request", (req) => {
      if (req.url() === SANDBOX_URL) return;
      requestsByObj.set(req, {
        url: req.url(),
        domain: hostOf(req.url()),
        method: req.method(),
        resourceType: req.resourceType(),
        status: null,
        fromCache: false,
        bytes: 0,
        timeMs: null,
        thirdParty: isThirdParty(req.url()),
        isRedirect: false,
        failed: false,
        failureText: null,
        category: categorizeRequest(req.url(), req.resourceType()),
      });
      if (req.redirectedFrom()) redirectCount += 1;
    });

    page.on("response", (res) => {
      const entry = requestsByObj.get(res.request());
      if (!entry) return;
      entry.status = res.status();
      if (res.status() >= 300 && res.status() < 400) entry.isRedirect = true;
      entry.fromCache = res.fromServiceWorker() === false && (res.request().timing().responseStart < 0);
    });

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

    const domStats = await page
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
      .catch(() => ({ domNodes: 0, kinds: [] as string[], html: null as string | null }));

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
      },
      requests,
      consoleMessages,
      pageErrors: navError ? [...pageErrors, `Navigation: ${navError}`] : pageErrors,
      cookies,
      checks,
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
