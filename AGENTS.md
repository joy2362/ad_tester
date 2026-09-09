<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AdTester project notes

Ad-tag testing tool: paste a tag → run it in headless Chromium → report requests,
cookies, console errors, redirects, weight, and the rendered creative. See `README.md`.

- `lib/runner.ts` imports `playwright-core` and is **server-only** — never import it
  (or anything importing it) from a client component. `lib/input.ts`,
  `lib/heuristics.ts`, `lib/types.ts` are safe on both sides.
- The headless browser is a lazily-launched singleton in `lib/runner.ts`; each run gets
  its own `BrowserContext`, closed in `finally`. `isServerless` (VERCEL /
  AWS_LAMBDA_FUNCTION_NAME) switches the launch to `@sparticuz/chromium`; otherwise the
  browser from `@playwright/browser-chromium` (a devDependency) is used.
- Run history lives in `lib/db.ts` (still named db) — Upstash Redis when
  `UPSTASH_REDIS_REST_URL`/`_TOKEN` (or `KV_REST_API_*`) are set, else an in-process
  Map. The exported fns are **async**. Screenshots are inline base64 JPEG data URLs;
  a record over ~1 MB is stored with `screenshot` nulled.
- Vercel bits: `vercel.json` (function memory/duration) + `next.config.ts`
  `outputFileTracingIncludes` (bundles the `@sparticuz/chromium` binary). See README
  "Deploying to Vercel".
- The sandbox origin `https://sandbox.ad-tester.local/` is fulfilled by a Playwright
  route, not real DNS.
- After changing runner/heuristics, verify with: `POST /api/runs` via curl (see README),
  then `npx tsc --noEmit && npx eslint .`.
