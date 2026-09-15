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

// A hard-rejecting timeout (unlike withTimeout, which resolves to a fallback) —
// used to bound browser/context/page acquisition, because a stale connection
// doesn't always reject promptly. It can hang indefinitely instead (observed on
// Vercel: a "dead" cached browser's newPage() neither resolved nor rejected for
// 30s+), so a plain try/catch around it never gets the chance to retry.
function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const ACQUIRE_TIMEOUT_MS = 15_000;

export interface BrowserSession<T> {
  value: T;
  /** Must be called (in a `finally`) once the whole run is done with the browser. */
  closeBrowser: () => Promise<void>;
}

/**
 * Opens a browser and hands it to `fn` (typically "create a context + page and
 * return them") — bounded so a stale/wedged connection can't hang the request.
 * `fn` should do only that acquisition step, not the rest of the run: the
 * browser must stay alive for however long the caller then uses the returned
 * context/page, so closing happens via the returned `closeBrowser()`, called
 * once the whole operation (navigation, screenshot, etc.) has finished.
 *
 * On serverless (Vercel/Lambda), a function instance's child processes can be
 * frozen or reaped between invocations while the warm Node module still holds
 * a reference to the (now-dead) Browser — `isConnected()` can report true right
 * before a real call hangs or fails (observed: newPage() hanging 30s+ with no
 * rejection). Rather than chase that race with a shared singleton, serverless
 * launches a **fresh browser per call** and closes it when the caller is done —
 * the ~1-3s extra cold start is worth the reliability. Locally (one
 * long-running dev/prod process) the singleton is safe and worth reusing, with
 * a reset-and-retry-once fallback if it ever does go stale.
 */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<BrowserSession<T>> {
  if (isServerless) {
    const browser = await launchBrowser();
    try {
      const value = await withDeadline(fn(browser), ACQUIRE_TIMEOUT_MS, "browser operation timed out");
      return { value, closeBrowser: () => browser.close().catch(() => {}) };
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }

  let browser = await getBrowser();
  try {
    const value = await withDeadline(fn(browser), ACQUIRE_TIMEOUT_MS, "browser operation timed out");
    return { value, closeBrowser: async () => {} };
  } catch {
    resetBrowser();
    browser = await getBrowser();
    const value = await withDeadline(
      fn(browser),
      ACQUIRE_TIMEOUT_MS,
      "browser operation timed out (after retry)",
    );
    return { value, closeBrowser: async () => {} };
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
