import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { DEFAULT_UA, STEALTH_HEADERS, STEALTH_INIT, STEALTH_UA, withBrowser, withTimeout } from "./browser";
import type { SiteCheckOptions, SitePageInput, SitePageResult } from "./types";

// Keep an inline video small: cap what we'll base64-embed in the response.
const MAX_VIDEO_BYTES = 8_000_000;

const PRIVATE_HOST_RE =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0|::1|10(\.\d+){3}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|192\.168(\.\d+){2}|.*\.local)$/i;

function validateUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported." };
  }
  if (PRIVATE_HOST_RE.test(url.hostname)) {
    return { ok: false, error: "Local/private hosts aren't allowed." };
  }
  return { ok: true, url };
}

function errored(input: SitePageInput, error: string, loadTimeMs: number | null = null): SitePageResult {
  return {
    ...input,
    status: "error",
    error,
    finalUrl: null,
    pageTitle: null,
    loadTimeMs,
    screenshot: null,
    screenshotBytes: null,
    screenshotOmitted: false,
    video: null,
    videoBytes: null,
    checkedAt: Date.now(),
  };
}

export async function checkSitePage(
  input: SitePageInput,
  options: SiteCheckOptions,
): Promise<SitePageResult> {
  const valid = validateUrl(input.url);
  if (!valid.ok) return errored(input, valid.error);

  const started = Date.now();
  let context: BrowserContext | null = null;
  let videoDir: string | null = null;
  let closeBrowser: (() => Promise<void>) | null = null;

  try {
    if (options.recordVideo) {
      videoDir = await fs.mkdtemp(path.join(os.tmpdir(), "adtester-video-"));
    }

    // On serverless this launches a dedicated browser for this one check and
    // closeBrowser() (called in `finally`) closes it; locally it reuses the
    // shared singleton. See lib/browser.ts for why the split exists.
    const opened = await withBrowser(async (browser) => {
      const ctx = await browser.newContext({
        viewport: { width: options.viewportWidth, height: options.viewportHeight },
        userAgent: options.stealth ? STEALTH_UA : DEFAULT_UA,
        ...(options.stealth
          ? { locale: "en-US", timezoneId: "America/New_York", extraHTTPHeaders: STEALTH_HEADERS }
          : {}),
        ...(videoDir
          ? { recordVideo: { dir: videoDir, size: { width: options.viewportWidth, height: options.viewportHeight } } }
          : {}),
      });
      ctx.setDefaultTimeout(options.timeoutMs);
      if (options.stealth) await ctx.addInitScript(STEALTH_INIT);
      const pg = await ctx.newPage();
      return { ctx, pg };
    });
    closeBrowser = opened.closeBrowser;
    context = opened.value.ctx;
    const page: Page = opened.value.pg;

    let navError: string | null = null;
    try {
      await page.goto(valid.url.toString(), { waitUntil: "load", timeout: options.timeoutMs });
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
    }

    try {
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(options.settleMs + 4000, options.timeoutMs),
      });
    } catch {
      /* real sites rarely go fully idle (analytics/ad polling) — that's fine */
    }
    await page.waitForTimeout(options.settleMs);

    const pageTitle = await withTimeout(page.title(), 3000, null).catch(() => null);
    const finalUrl = page.url();

    let screenshot: string | null = null;
    let screenshotBytes: number | null = null;
    try {
      const buf = await withTimeout(
        page.screenshot({ type: "jpeg", quality: 60, fullPage: options.fullPage }),
        20000,
        null,
      );
      if (buf) {
        screenshot = `data:image/jpeg;base64,${buf.toString("base64")}`;
        screenshotBytes = buf.length;
      }
    } catch {
      /* ignore screenshot failure — still report the rest */
    }

    const loadTimeMs = Date.now() - started;

    // The video file only finalizes once the page (and context) close.
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    context = null;

    let video: string | null = null;
    let videoBytes: number | null = null;
    if (videoDir) {
      try {
        // turbopackIgnore: these paths are a runtime-only os.tmpdir() scratch dir
        // (Playwright's video output), not project files — nothing to trace/bundle.
        const files = await fs.readdir(/* turbopackIgnore: true */ videoDir);
        const webm = files.find((f) => f.endsWith(".webm"));
        if (webm) {
          const videoPath = path.join(/* turbopackIgnore: true */ videoDir, webm);
          const buf = await fs.readFile(/* turbopackIgnore: true */ videoPath);
          videoBytes = buf.length;
          if (buf.length <= MAX_VIDEO_BYTES) {
            video = `data:video/webm;base64,${buf.toString("base64")}`;
          }
        }
      } catch {
        /* no video file — non-fatal */
      }
    }

    // A hard navigation failure (DNS, TLS, timeout, connection refused) means
    // there was never a real document to see — flag it as an error even though
    // we still attempt a screenshot (often Chromium's own error interstitial,
    // which can be useful context) and, if requested, a video.
    return {
      ...input,
      status: navError ? "error" : "ok",
      error: navError,
      finalUrl,
      pageTitle,
      loadTimeMs,
      screenshot,
      screenshotBytes,
      screenshotOmitted: false,
      video,
      videoBytes,
      checkedAt: Date.now(),
    };
  } catch (err) {
    return errored(
      input,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      Date.now() - started,
    );
  } finally {
    if (context) await context.close().catch(() => {});
    if (closeBrowser) await closeBrowser();
    if (videoDir) await fs.rm(videoDir, { recursive: true, force: true }).catch(() => {});
  }
}
