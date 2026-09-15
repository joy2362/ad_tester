<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AdTester project notes

Two tools, one headless-Chromium backend. See `README.md`.
- **Ad Tag Taster** (`/`): paste a tag → run it in a sandboxed browser → report
  requests, cookies, console errors, redirects, weight, rendered creative, passback.
- **Site Checks** (`/sites`): list real publisher pages (portal + page type + URL) →
  visit each directly → detect whether "our ad" (a configurable domain/URL pattern)
  actually served, not just whether the page loaded → screenshot / optionally record
  video of what's actually there.

- `lib/browser.ts` is the **shared** browser plumbing + stealth impl — both
  `lib/runner.ts` (ad tag) and `lib/siteRunner.ts` (site checks) call `withBrowser(fn)`
  (not `getBrowser()` directly) to get a `{ value, closeBrowser }` session; `fn` should
  do ONLY acquisition (`browser.newContext()` + `newPage()`, return them) — the browser
  must stay alive for the whole run, so the caller uses `value.{ctx,pg}` for
  navigation/screenshot/etc. and calls `closeBrowser()` in its own `finally`, not inside
  `fn`. On serverless this launches (and the caller closes) a **fresh browser per call**;
  locally it reuses one singleton with a hard-deadline+reset+retry-once fallback. This
  split exists because a Vercel instance can reap a browser's child process between
  invocations while the warm module still holds a reference that *looks* connected —
  using it doesn't reject, it can **hang indefinitely** (see git history: two separate
  fixes were needed, a retry-on-error one first, which didn't cover the hang, then this
  one). Don't reintroduce a cross-invocation singleton on the serverless path.
  `isServerless` (VERCEL / AWS_LAMBDA_FUNCTION_NAME) switches the launch to
  `@sparticuz/chromium`; otherwise the browser from `@playwright/browser-chromium` (a
  devDependency) is used.
- `lib/runner.ts` and `lib/siteRunner.ts` import `playwright-core` and are
  **server-only** — never import either (or anything importing them) from a client
  component. `lib/input.ts`, `lib/heuristics.ts`, `lib/types.ts` are safe on both sides.
- `lib/store.ts` is a **generic** Redis-or-memory keyed-record store (Redis via
  `node-redis` when `REDIS_URL`/`KV_URL` is set, else an in-process Map; lazily
  connected client; falls back to memory on any Redis error, not just at init). `lib/db.ts`
  (ad-tag runs, prefix `adtester:run:`) and `lib/siteDb.ts` (site batches, prefix
  `adtester:sitebatch:`) each call `createRecordStore()` with their own prefix/shrink
  steps — don't reimplement Redis logic in either, extend `lib/store.ts` instead.
  Screenshots are inline base64 JPEG; a record over ~1 MB has shrink steps applied
  (drop screenshot, then — for runs — body previews; for site batches, all screenshots).
- Vercel bits: `vercel.json` (function memory/duration) + `next.config.ts`
  `outputFileTracingIncludes` (bundles the `@sparticuz/chromium` + `playwright-core`
  binaries) + `serverExternalPackages: ["redis", "playwright-core", "@sparticuz/chromium"]`.
  See README "Deploying to Vercel". Route handlers that touch the runner import it
  *lazily* (`await import("@/lib/runner")` inside the handler) so a Playwright load
  failure 500s that one request with a JSON error instead of crashing the whole route
  module (which would 500 every method including GET) — keep new routes doing the same.
- `lib/siteRunner.ts`: navigates to **real external URLs**, not a sandbox — validates
  http(s)-only + blocks obvious local/private hosts first. Video: `context.newContext({
  recordVideo })` writes to an `os.tmpdir()` dir that must be read *after* both `page`
  and `context` close (video finalizes on close); the two `fs.readdir`/`fs.readFile`
  calls need `/* turbopackIgnore: true */` on the dynamic path args or Turbopack traces
  the entire project into the function bundle (build-time warning, not an error — don't
  ignore it if it reappears). Video is capped ~8 MB inline and **never persisted**
  (`lib/siteDb.ts` nulls it defensively even if a caller sends it) — only ever present
  in the immediate `/api/sites/check` response.
- **Ad-serving detection** (`SiteCheckOptions.adMatch`, comma-separated domain/URL
  substrings, e.g. `delivery.viewsense.ai`) is the actual point of Site Checks — don't
  regress it back into "just screenshot the page". Two independent signals, both in
  `checkSitePage()`: (1) network — `page.on("response"/"requestfailed")` filters to URLs
  containing an `adMatch` term, and `looksLikePassback()` (imported from
  `lib/heuristics.ts`, same fn the ad-tag tester uses) scans matching response bodies →
  `AdStatus` = `serving` / `no_fill` / `not_detected` / `unknown` (no pattern set); (2)
  DOM — `highlightAdElements()` runs via `page.evaluate` right before the screenshot,
  finds a plausible ad iframe/container (by `adMatch` term, a common-ad-host fallback
  regex, or an `ad[-_]?(slot|unit|container|...)` class/id with visible media inside),
  and outlines up to 5 in pink so the screenshot shows where the ad rendered →
  `adElementDetected`. `onlyScreenshotIfServing` drops the screenshot (sets
  `screenshotOmitted`) unless `adStatus === "serving"`. `AdStatus` lives in
  `lib/types.ts`; keep `lib/db.ts`'s `looksLikePassback` usage and this one in sync if
  the no-fill regex changes.
- A `page.goto` **timeout** is not automatically a failed check — `checkSitePage()`
  computes `hardNavFailure` (a real DNS/TLS/refused error, or a timeout with no
  `pageTitle` at all) and only *that* sets `status: "error"`. A timeout on an
  otherwise-loaded page (very common on heavy news homepages — ads/analytics keep the
  page from ever going idle) stays `status: "ok"` with the timeout kept as `error` (shown
  as a note, not a failure) — this was a real bug caught testing against cnn.com: the
  page, ads and screenshot all came through fine but got marked as a failed check.
- The ad-tag sandbox origin `https://sandbox.ad-tester.local/` is fulfilled by a
  Playwright route, not real DNS — this is specific to `lib/runner.ts`; site checks have
  no sandbox, they hit the real page.
- Network capture (ad tag only) is per-request detailed: req/res headers, `NetTiming`
  breakdown, `redirectChain`, `isSubframe`/`frameUrl`, and a capped `bodyPreview` (budgets
  in `lib/runner.ts`: `MAX_BODY_PREVIEW` / `MAX_TOTAL_BODY` / `MAX_BODIES`). The
  `captureBodies` option only gates *preview storage* — bodies are still read+scanned
  for passback signals when it's off.
- Passback (ad tag only): `looksLikePassback()` scans response bodies,
  `buildPassbackReport()` aggregates (both in `lib/heuristics.ts`); `RunResult.passback`
  + the `passback-handled` check say whether a fallback creative rendered.
  `page.on("popup"|"framenavigated")` feed `RunResult.popups` / `frames`.
- Every post-goto/post-navigate await in both runners (`page.evaluate`, body drains,
  settle, `page.title()`, screenshot) is wrapped in `withTimeout` so one slow/hanging
  page can't hang the request.
- `stealth` (both `RunOptions` and `SiteCheckOptions`) masks headless tells (webdriver /
  UA / Sec-CH-UA / userAgentData / plugins / WebGL / chrome / outerWidth), all per-context
  via `lib/browser.ts`'s `STEALTH_UA`/`STEALTH_HEADERS`/`STEALTH_INIT` — deliberately no
  per-mode browser: a second cold-start Chromium on a 1 GB / 60 s Vercel function =
  FUNCTION_INVOCATION_TIMEOUT (hit this once already; see git history). It cannot change
  the egress IP.
- Site Checks architecture: the client (`components/SiteChecker.tsx`) calls
  `POST /api/sites/check` **once per page** with concurrency 2, not one big
  server-side loop — keeps each request well under the function timeout regardless of
  list size, and streams results into the UI. It auto-saves the finished batch via
  `POST /api/sites/batches` when done.
- After changing either runner/heuristics/siteRunner, verify with: `POST /api/runs` or
  `POST /api/sites/check` via curl (see README), then `npx tsc --noEmit && npx eslint .`.
