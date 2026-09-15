# ViewSense Ad Tag Taster

Two tools sharing one headless-Chromium backend:

- **Ad Tag Taster** (`/`) — paste an ad tag or script, run it in a sandboxed browser
  context, and inspect everything it does: network requests, cookies, console errors,
  redirects, payload weight, and the rendered creative.
- **Site Checks** (`/sites`) — list the real publisher pages a campaign should be live
  on (portal + page type, e.g. Home / Article), visit each one directly in a browser,
  and screenshot (or record video of) what's actually there.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind v4)
- **Playwright / Chromium** drives both tools via one shared browser singleton
  (`lib/browser.ts`) — `playwright-core` plus `@playwright/browser-chromium` locally
  (downloaded on install) and `@sparticuz/chromium` on Vercel / Lambda
- **History**: Redis via `node-redis` when `REDIS_URL` is set, else an in-process map
  (ephemeral). Generic store in `lib/store.ts`; `lib/db.ts` (runs) and `lib/siteDb.ts`
  (site-check batches) each bind their own key prefix.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000.

`npm run build && npm start` for production.

## How a test works

1. You paste a tag. It is classified as a script/HTML tag, raw HTML/JS snippet, a
   script `src` URL, or an iframe `src` URL (override with the **Interpret as** dropdown).
2. The server wraps it in a sandbox document served from `https://sandbox.ad-tester.local/`
   (an intercepted route — never a real DNS lookup) and loads it in a fresh, isolated
   browser context.
3. Every request/response/failure, console message, page error and cookie is recorded —
   including, per request, the **request + response headers, timing breakdown
   (DNS/connect/TLS/TTFB/download), redirect chain, which frame issued it, and a body
   preview** for text responses (toggle "Capture request/response headers & body
   previews" in Advanced options). Nested frames and popups are tracked too. After
   `load` + a network-idle wait + a fixed settle delay it screenshots the page and
   snapshots the ad container's DOM.
4. Heuristic checks run (HTTPS-only, payload < 1 MB, request count, load time, redirect
   hops, third-party cookies, `document.write`, clickTag/CLICK_URL macro, creative
   rendered, **passback / no-fill handled**).
5. **Passback detection**: when a tag can't fill and hands back another tag (or returns a
   no-fill / 204 / empty `seatbid`), the report flags the chain, lists the signals, and
   says whether a fallback creative still rendered — i.e. whether the sandbox followed
   the passback or broke. A per-request `passback` badge marks the offending responses.
6. The run is saved to the run store and shown in **History**, where two runs can be
   compared (the report shows deltas against the previous run).

## Site Checks (`/sites`)

For verifying a campaign is actually live on the pages it's supposed to be, rather than
inspecting one tag in isolation:

1. Add pages — one row per (portal, page type, URL), or paste a bulk list
   (`Portal | Page label | URL` per line, or bare URLs).
2. **Run** visits each URL directly (no sandbox — real navigation) in its own browser
   context, waits for load + a settle delay, then screenshots it (viewport or full page).
   Optionally records a short video of the load instead of/alongside the screenshot.
3. The client calls `/api/sites/check` **once per page** with limited concurrency (2 at
   a time) rather than looping server-side — that keeps every request well under
   Vercel's function timeout no matter how many pages are queued, and streams results
   into the UI as each one finishes instead of all-or-nothing.
4. The finished batch auto-saves to **History** — screenshots persist; **video does
   not** (only ever present in the immediate response) to keep Redis usage bounded.
5. Same `stealth` option as the ad-tag tester, useful when a publisher page's own ad
   slots also skip serving to headless traffic.

A hard navigation failure (DNS/TLS/timeout) is reported as `status: "error"`; an HTTP
error page (404/500) still loads and screenshots normally with `status: "ok"`.

## Key files

| Path | Purpose |
| --- | --- |
| `lib/browser.ts` | shared browser singleton + stealth (used by both tools) |
| `lib/store.ts` | generic Redis-or-memory keyed-record store |
| `lib/input.ts` | ad-tag input classification + sandbox HTML builder |
| `lib/runner.ts` | ad-tag sandbox execution + capture (server-only) |
| `lib/heuristics.ts` | request categorization + checks |
| `lib/db.ts` | ad-tag run store (built on `lib/store.ts`) |
| `lib/siteRunner.ts` | site-check navigation + screenshot/video (server-only) |
| `lib/siteDb.ts` | site-check batch store (built on `lib/store.ts`) |
| `app/api/runs/route.ts` | `GET` list, `POST` run (ad tag) |
| `app/api/runs/[id]/route.ts` | `GET` one, `DELETE` (ad tag) |
| `app/api/sites/check/route.ts` | `POST` — check one page, no persistence |
| `app/api/sites/batches/route.ts` | `GET` list, `POST` save a finished batch |
| `app/api/sites/batches/[id]/route.ts` | `GET` one, `DELETE` |
| `components/AdTester.tsx` / `ResultView.tsx` | ad-tag UI (client) |
| `components/SiteChecker.tsx` | site-check UI (client) |
| `components/BrandHeader.tsx` | shared header + nav between the two tools |

## Notes & limits

- Tags run in an isolated browser context with **no access to the host machine**, but
  they *do* make real outbound network requests. Only run tags you understand.
- Response sizes come from Playwright's `request.sizes()`; a few resource types report 0.
- Body previews are capped (~12 KB each, ~350 KB / 60 responses per run) and only read
  for document/script/xhr/fetch responses. If the stored run JSON still exceeds ~1 MB,
  `lib/db.ts` drops the screenshot, then the bodies.
- Response-body reads, `page.evaluate`, and the settle phase all have their own timeouts,
  so a runaway passback loop can't hang the run — it finishes with whatever was captured.
- Popups a tag opens are recorded and closed; their own sub-requests aren't traced.
- `blockThirdParty` (advanced options) aborts every non-sandbox request — useful for an
  isolation / offline-behavior test.
- `stealth` (advanced options) masks the headless tells an ad server's invalid-traffic
  (IVT) filter keys on: `navigator.webdriver`, the UA / `Sec-CH-UA` / `userAgentData`
  brands, `navigator.plugins`/`mimeTypes`, `window.chrome`, WebGL vendor/renderer,
  `outerWidth/Height`, locale + timezone. Applied per browser context (no extra
  browser launch). Note it can't change the **egress IP** — ad servers commonly drop
  fills from datacenter ranges (Vercel included) regardless of the browser fingerprint,
  so a masked run may still get a no-fill when deployed.
- Site Checks navigates to **real, arbitrary URLs** — `lib/siteRunner.ts` blocks
  non-http(s) schemes and obvious local/private hosts (`localhost`, `127.*`, `10.*`,
  `172.16-31.*`, `192.168.*`, `*.local`) as a basic safety net, but this is a string
  check, not DNS-rebinding protection. Only point it at pages you're allowed to check.
- Video capture is capped at ~8 MB inline and, when enabled, the settle wait is capped
  at 8 s to bound the recording length; going over the cap reports `videoBytes` without
  the data. Video is written to a per-check `os.tmpdir()` folder and deleted after
  reading — never left on disk.
## Deploying to Vercel

The `/api/runs` function launches a real browser, so it needs the serverless
build of Chromium and an off-disk store:

1. **Chromium** — handled in code. `lib/runner.ts` uses `@sparticuz/chromium`
   when `VERCEL` / `AWS_LAMBDA_FUNCTION_NAME` is set; `next.config.ts`
   (`outputFileTracingIncludes`) bundles its binary into the function;
   `vercel.json` gives the function 1024 MB and a 60 s `maxDuration`.
2. **Run history** — Storage tab → create/connect a **Redis** store to the
   project (Production + Preview). Vercel injects `REDIS_URL`; `lib/db.ts`
   connects with `node-redis` automatically. Without it the app still runs, but
   history is per-instance and disappears on cold starts.
3. Redeploy (env vars only take effect on new deployments).

Caveats: cold starts add ~2–4 s (Chromium extraction to `/tmp`); heavy tags can
still hit the 60 s Hobby ceiling — raise `maxDuration`/`memory` in `vercel.json`
on Pro. `screenshot` JPEG quality is 55 and each run record is capped at ~1 MB
(screenshot then body previews are dropped past that).

### Other hosts

Any Node host or a container on `mcr.microsoft.com/playwright` also works — there
`isServerless` is false and the locally-downloaded Chromium is used. Set
`REDIS_URL` to any Redis connection string, or leave it unset for in-memory.
