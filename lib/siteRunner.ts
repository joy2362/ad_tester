import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { DEFAULT_UA, STEALTH_HEADERS, STEALTH_INIT, STEALTH_UA, withBrowser, withTimeout } from "./browser";
import { looksLikePassback } from "./heuristics";
import type { AdStatus, SiteCheckOptions, SitePageInput, SitePageResult } from "./types";

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

function parseAdTerms(adMatch: string): string[] {
  return adMatch
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
    adStatus: "unknown",
    adReason: "Page failed before the ad could be checked.",
    adRequestCount: 0,
    adElementDetected: false,
    checkedAt: Date.now(),
  };
}

/**
 * Runs in the page — finds a plausible ad element (an iframe matching one of
 * the ad terms, or a common ad-serving host as a fallback; or a visibly-sized
 * container whose class/id reads as an ad slot and holds real media) and
 * outlines up to 5 of them so the screenshot visibly shows where the ad is.
 * Returns how many it found.
 */
function highlightAdElements(terms: string[]): number {
  const isVisible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  };
  const commonAdHostRe =
    /doubleclick|googlesyndication|adnxs|adsrvr|rubiconproject|pubmatic|casalemedia|criteo|amazon-adsystem|openx|3lift|smartadserver|adform|teads|spotx|indexexchange|pubads|safeframe/i;
  const found: Element[] = [];

  document.querySelectorAll("iframe[src]").forEach((el) => {
    if (found.length >= 5) return;
    const src = el.getAttribute("src") || "";
    const matchesTerm = terms.length > 0 && terms.some((t) => src.toLowerCase().includes(t));
    const matchesCommon = terms.length === 0 && commonAdHostRe.test(src);
    if ((matchesTerm || matchesCommon) && isVisible(el)) found.push(el);
  });

  const adNameRe = /\bad[-_]?(slot|unit|container|zone|banner|wrapper|frame)\b/i;
  document.querySelectorAll("[class],[id]").forEach((el) => {
    if (found.length >= 5 || found.includes(el)) return;
    const label = `${(el as HTMLElement).className ?? ""} ${el.id ?? ""}`;
    if (!adNameRe.test(label)) return;
    if (!isVisible(el)) return;
    if (!el.querySelector("img, video, iframe, canvas")) return;
    found.push(el);
  });

  for (const el of found) {
    (el as HTMLElement).style.outline = "4px solid #ff2d78";
    (el as HTMLElement).style.outlineOffset = "-4px";
  }
  return found.length;
}

interface ArticleCandidate {
  url: string;
  text: string;
}

/**
 * Runs in the page (on a home/listing page) — collects same-site links that
 * plausibly go to an article: long visible link text (a headline, not a nav
 * item), inside an article-ish context first, falling back to any long-text
 * same-site link, and excluding obvious non-article sections (tag/category/
 * account/legal pages etc).
 */
function discoverArticleLinks(homeHost: string): ArticleCandidate[] {
  const NON_ARTICLE_PATH_RE =
    /^\/(tag|tags|topic|topics|category|categories|section|sections|author|authors|about|about-us|contact|advertise|privacy|privacy-policy|terms|terms-of-service|cookie|cookies|search|login|signin|signup|register|subscribe|subscription|account|profile|rss|feed|feeds|sitemap|newsletter|jobs|careers)(\/|$)/i;

  const looksLikeArticleUrl = (href: string): string | null => {
    let u: URL;
    try {
      u = new URL(href, location.href);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname.replace(/^www\./, "") !== homeHost) return null;
    const path = u.pathname;
    if (path === "" || path === "/") return null;
    if (NON_ARTICLE_PATH_RE.test(path)) return null;
    u.hash = "";
    return u.toString();
  };

  const isVisible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  };

  const seen = new Set<string>();
  const candidates: ArticleCandidate[] = [];
  const collect = (nodes: NodeListOf<Element>, minTextLen: number) => {
    nodes.forEach((el) => {
      if (candidates.length >= 40) return;
      const a = el as HTMLAnchorElement;
      const href = a.getAttribute("href");
      if (!href) return;
      const text = (a.textContent || "").trim();
      if (text.length < minTextLen) return;
      if (!isVisible(a)) return;
      const abs = looksLikeArticleUrl(href);
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      candidates.push({ url: abs, text: text.slice(0, 140) });
    });
  };

  collect(
    document.querySelectorAll(
      [
        "article a[href]",
        "h1 a[href]",
        "h2 a[href]",
        "h3 a[href]",
        '[class*="headline" i] a[href]',
        '[class*="article" i] a[href]',
        '[class*="story" i] a[href]',
        '[class*="teaser" i] a[href]',
        '[class*="card" i] a[href]',
      ].join(","),
    ),
    15,
  );
  if (!candidates.length) {
    collect(document.querySelectorAll("a[href]"), 25);
  }
  return candidates;
}

export async function checkSitePage(
  input: SitePageInput,
  options: SiteCheckOptions,
): Promise<SitePageResult> {
  const valid = validateUrl(input.url);
  if (!valid.ok) return errored(input, valid.error);

  const adTerms = parseAdTerms(options.adMatch);

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

    // "Article page" via auto-discovery: visit `input.url` as a home/listing
    // page, pick a same-site article link off it, and check THAT page instead
    // — the home page itself is never scored for ad-serving here.
    let targetUrl = valid.url.toString();
    if (input.autoDiscoverArticle) {
      let homeNavError: string | null = null;
      try {
        await page.goto(targetUrl, { waitUntil: "load", timeout: options.timeoutMs });
      } catch (err) {
        homeNavError = err instanceof Error ? err.message : String(err);
      }
      // Give the home page a short, fixed window to render its link list —
      // independent of settleMs, which is reserved for the article page.
      await withTimeout(
        page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {}),
        5000,
        undefined,
      );
      await page.waitForTimeout(1000);

      if (homeNavError && !(await withTimeout(page.title(), 2000, null).catch(() => null))) {
        return errored(
          input,
          `Could not load the home page to find an article: ${homeNavError}`,
          Date.now() - started,
        );
      }

      const homeHost = valid.url.hostname.replace(/^www\./, "");
      const candidates = await withTimeout(
        page.evaluate(discoverArticleLinks, homeHost),
        5000,
        [] as ArticleCandidate[],
      ).catch(() => [] as ArticleCandidate[]);

      if (!candidates.length) {
        return errored(
          input,
          "Could not find an article link on the home page — the page may need JS interaction, or its markup doesn't look like a typical article listing.",
          Date.now() - started,
        );
      }

      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      targetUrl = chosen.url;
    }

    // Watch for requests to "our ad" (if a pattern was given) so we can tell
    // whether the ad actually filled, not just whether the page loaded. Only
    // for the final (article, or direct) page — the home-page hop above isn't
    // scored.
    const adRequests: { url: string; status: number | null; failed: boolean }[] = [];
    const passbackChecks: Promise<boolean>[] = [];
    if (adTerms.length) {
      page.on("response", (res) => {
        const url = res.url();
        if (!adTerms.some((t) => url.toLowerCase().includes(t))) return;
        const status = res.status();
        adRequests.push({ url, status, failed: false });
        passbackChecks.push(
          withTimeout(res.body(), 2000, null)
            .then((buf) => {
              if (!buf || !buf.length) return false;
              const host = (() => {
                try {
                  return new URL(url).hostname;
                } catch {
                  return "";
                }
              })();
              return looksLikePassback(buf.toString("utf8").slice(0, 20000), host, status).hit;
            })
            .catch(() => false),
        );
      });
      page.on("requestfailed", (req) => {
        const url = req.url();
        if (!adTerms.some((t) => url.toLowerCase().includes(t))) return;
        adRequests.push({ url, status: null, failed: true });
      });
    }

    let navError: string | null = null;
    try {
      await page.goto(targetUrl, { waitUntil: "load", timeout: options.timeoutMs });
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

    // A goto() timeout on a heavy page (constant ad/analytics activity means
    // "load" never truly fires) is not the same as a hard failure — we still
    // got a title, a URL, ads, a screenshot. Only DNS/TLS/refused/abort-style
    // errors (no navError, or one that isn't just "ran out of time") mean
    // there was never a real document to see.
    const hardNavFailure = Boolean(navError) && !(/Timeout \d+ms exceeded/.test(navError!) && pageTitle);

    // Resolve the ad-serving verdict before deciding whether to screenshot.
    const passbackHits = await withTimeout(Promise.all(passbackChecks), 4000, [] as boolean[]);
    const anyPassback = passbackHits.some(Boolean);
    let adStatus: AdStatus;
    let adReason: string;
    if (!adTerms.length) {
      adStatus = "unknown";
      adReason = "No ad domain/pattern configured — network check skipped.";
    } else if (adRequests.length === 0) {
      adStatus = "not_detected";
      adReason = `No request matching "${options.adMatch}" was seen on this page.`;
    } else {
      const allBad = adRequests.every((r) => r.failed || (r.status != null && r.status >= 400));
      if (allBad || anyPassback) {
        adStatus = "no_fill";
        adReason = anyPassback
          ? `Request(s) to "${options.adMatch}" responded, but it looked like a no-fill / passback.`
          : `Request(s) to "${options.adMatch}" failed or returned an error status.`;
      } else {
        adStatus = "serving";
        adReason = `${adRequests.length} request(s) matching "${options.adMatch}" resolved normally.`;
      }
    }

    // Outline a plausible ad element (found via the same terms, or common ad
    // hosts as a fallback) so the screenshot shows where the ad rendered.
    let adElementDetected = false;
    try {
      const hits = await withTimeout(page.evaluate(highlightAdElements, adTerms), 4000, 0);
      adElementDetected = hits > 0;
    } catch {
      /* best-effort DOM heuristic — never fail the check over it */
    }

    let screenshot: string | null = null;
    let screenshotBytes: number | null = null;
    let screenshotOmitted = false;
    if (options.onlyScreenshotIfServing && adStatus !== "serving") {
      screenshotOmitted = true;
    } else {
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

    // A hard navigation failure (DNS, TLS, connection refused, or a timeout
    // with no content at all) means there was never a real document to see —
    // flag it as an error even though we still attempt a screenshot (often
    // Chromium's own error interstitial, which can be useful context) and, if
    // requested, a video. A timeout on an otherwise-loaded page (common on
    // heavy news sites that never go fully idle) stays "ok" with the timeout
    // kept as a note.
    return {
      ...input,
      status: hardNavFailure ? "error" : "ok",
      error: navError,
      finalUrl,
      pageTitle,
      loadTimeMs,
      screenshot,
      screenshotBytes,
      screenshotOmitted,
      video,
      videoBytes,
      adStatus,
      adReason,
      adRequestCount: adRequests.length,
      adElementDetected,
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
