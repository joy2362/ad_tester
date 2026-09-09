# ViewSense Ad Tester

Paste an ad tag or script, run it in a real headless Chromium sandbox, and inspect
everything it does — network requests, cookies, console errors, redirects, payload
weight, and the rendered creative.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind v4)
- **Playwright / Chromium** drives the headless run — `playwright-core` plus
  `@playwright/browser-chromium` locally (downloaded on install) and
  `@sparticuz/chromium` on Vercel / Lambda (`isServerless` switch in `lib/runner.ts`)
- **Run history**: Upstash Redis (`@upstash/redis`) when configured, else an
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
3. Every request/response/failure, console message, page error and cookie is recorded.
   After `load` + a network-idle wait + a fixed settle delay, it screenshots the page
   and snapshots the ad container's DOM.
4. Heuristic checks run (HTTPS-only, payload < 1 MB, request count, load time, redirect
   hops, third-party cookies, `document.write`, clickTag/CLICK_URL macro, creative
   rendered).
5. The run is saved to the run store and shown in **History**, where two runs can be
   compared (the report shows deltas against the previous run).

## Key files

| Path | Purpose |
| --- | --- |
| `lib/input.ts` | input classification + sandbox HTML builder |
| `lib/runner.ts` | Playwright execution + capture (server-only) |
| `lib/heuristics.ts` | request categorization + checks |
| `lib/db.ts` | run store (Upstash Redis or in-memory) |
| `app/api/runs/route.ts` | `GET` list, `POST` run |
| `app/api/runs/[id]/route.ts` | `GET` one, `DELETE` |
| `components/AdTester.tsx` | form + history (client) |
| `components/ResultView.tsx` | report tabs (client) |
| `components/SandboxPreview.tsx` | client-side live iframe re-run |

## Notes & limits

- Tags run in an isolated browser context with **no access to the host machine**, but
  they *do* make real outbound network requests. Only run tags you understand.
- Response sizes come from Playwright's `request.sizes()`; a few resource types report 0.
- `blockThirdParty` (advanced options) aborts every non-sandbox request — useful for an
  isolation / offline-behavior test.
## Deploying to Vercel

The `/api/runs` function launches a real browser, so it needs the serverless
build of Chromium and an off-disk store:

1. **Chromium** — handled in code. `lib/runner.ts` uses `@sparticuz/chromium`
   when `VERCEL` / `AWS_LAMBDA_FUNCTION_NAME` is set; `next.config.ts`
   (`outputFileTracingIncludes`) bundles its binary into the function;
   `vercel.json` gives the function 1024 MB and a 60 s `maxDuration`.
2. **Run history** — add the **Upstash for Redis** integration from the Vercel
   project's Storage tab. It injects `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN` (`KV_REST_API_*` also accepted) and `lib/db.ts`
   picks them up automatically. Without it the app still runs, but history is
   per-instance and disappears on cold starts.
3. Redeploy.

Caveats: cold starts add ~2–4 s (Chromium extraction to `/tmp`); heavy tags can
still hit the 60 s Hobby ceiling — raise `maxDuration`/`memory` in `vercel.json`
on Pro. `screenshot` JPEG quality is 55 and run JSON is capped at ~1 MB (the
screenshot is dropped past that) to stay under Upstash's free per-request limit.

### Other hosts

Any Node host or a container on `mcr.microsoft.com/playwright` also works — there
`isServerless` is false and the locally-downloaded Chromium is used. Point
`UPSTASH_REDIS_REST_URL`/`_TOKEN` at any Redis-compatible store, or leave unset
for in-memory.
