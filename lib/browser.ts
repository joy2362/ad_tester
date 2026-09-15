import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";

/**
 * Shared headless-browser plumbing used by both the ad-tag sandbox
 * (lib/runner.ts) and the live-site checker (lib/siteRunner.ts) — one browser
 * singleton, one stealth implementation, one timeout helper.
 */

export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
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

let browserPromise: Promise<Browser> | null = null;

// Vercel / AWS Lambda: no bundled Chromium and a read-only FS, so use the
// Lambda-sized build from @sparticuz/chromium. Locally we fall through to the
// browser that @playwright/browser-chromium downloaded on install.
const isServerless = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL);

// One shared browser, launched plain. Stealth is applied entirely per-context
// (UA, headers, init script) so it never needs a second cold-start browser —
// which on a 1 GB / 60 s Vercel function is the difference between a run and a
// FUNCTION_INVOCATION_TIMEOUT.
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

export async function getBrowser(): Promise<Browser> {
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

/** Drop the cached browser so the next getBrowser() launches a fresh one. */
export function resetBrowser(): void {
  browserPromise = null;
}

function isDeadBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /has been closed|disconnected|target (page|context or browser) .*closed/i.test(msg);
}

/**
 * Runs `fn` against the shared browser. Vercel can freeze/reap a function
 * instance's child processes between invocations while the warm Node module
 * still holds a reference to the (now-dead) Browser object — `isConnected()`
 * can pass right before a call fails with e.g. "browserContext.newPage:
 * Target page, context or browser has been closed". On that specific failure,
 * reset the singleton and retry once with a freshly launched browser; any
 * other error (a real page/tag problem) is not retried.
 */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  try {
    return await fn(browser);
  } catch (err) {
    if (!isDeadBrowserError(err)) throw err;
    resetBrowser();
    const fresh = await getBrowser();
    return fn(fresh);
  }
}

export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// A recent stable Chrome build to impersonate when stealth is on. Kept as a
// constant so the UA string and the Sec-CH-UA / userAgentData brands agree.
const STEALTH_CHROME_MAJOR = "152";
export const STEALTH_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${STEALTH_CHROME_MAJOR}.0.0.0 Safari/537.36`;
export const STEALTH_HEADERS: Record<string, string> = {
  "sec-ch-ua": `"Chromium";v="${STEALTH_CHROME_MAJOR}", "Google Chrome";v="${STEALTH_CHROME_MAJOR}", "Not?A_Brand";v="24"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

// Runs before any page script. Patches the headless "tells" that bot filters
// key on (webdriver / UA / plugins / WebGL / client hints / window size).
export const STEALTH_INIT = `(() => {
  const def = (obj, prop, get) => { try { Object.defineProperty(obj, prop, { get, configurable: true }); } catch (e) {} };

  // Real (non-automated) Chrome reports navigator.webdriver === false.
  def(navigator, 'webdriver', () => false);
  try { delete Navigator.prototype.webdriver; } catch (e) {}

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
