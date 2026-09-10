# ViewSense Ad Tag Taster

Paste an ad tag or script, run it in a real headless Chromium sandbox, and inspect
everything it does — network requests, cookies, console errors, redirects, payload
weight, and the rendered creative.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind v4)
- **Playwright / Chromium** drives the headless run — `playwright-core` plus
  `@playwright/browser-chromium` locally (downloaded on install) and
  `@sparticuz/chromium` on Vercel / Lambda (`isServerless` switch in `lib/runner.ts`)
- **Run history**: Redis via `node-redis` when `REDIS_URL` is set, else an
  in-process map (ephemeral). See `lib/db.ts`.

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

## Key files

| Path | Purpose |
| --- | --- |
| `lib/input.ts` | input classification + sandbox HTML builder |
| `lib/runner.ts` | Playwright execution + capture (server-only) |
| `lib/heuristics.ts` | request categorization + checks |
| `lib/db.ts` | run store (Redis via `node-redis`, or in-memory) |
| `app/api/runs/route.ts` | `GET` list, `POST` run |
| `app/api/runs/[id]/route.ts` | `GET` one, `DELETE` |
| `components/AdTester.tsx` | form + history (client) |
| `components/ResultView.tsx` | report tabs (client) |
| `components/SandboxPreview.tsx` | client-side live iframe re-run |

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
