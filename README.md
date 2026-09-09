# ViewSense Ad Tester

Paste an ad tag or script, run it in a real headless Chromium sandbox, and inspect
everything it does — network requests, cookies, console errors, redirects, payload
weight, and the rendered creative.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind v4)
- **Playwright / Chromium** (`playwright-core` + `@playwright/browser-chromium`) drives the headless run
- **better-sqlite3** stores run history in `.data/runs.db` (git-ignored)

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
5. The run is saved to SQLite and shown in **History**, where two runs can be compared
   (the report shows deltas against the previous run).

## Key files

| Path | Purpose |
| --- | --- |
| `lib/input.ts` | input classification + sandbox HTML builder |
| `lib/runner.ts` | Playwright execution + capture (server-only) |
| `lib/heuristics.ts` | request categorization + checks |
| `lib/db.ts` | SQLite persistence |
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
- Deploying: needs a Node runtime with a Chromium binary (not Edge/serverless-static).
  A long-running Node host or a container with the Playwright image works.
