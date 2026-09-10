import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep these external (require()d from node_modules at runtime) rather than
  // bundled — `redis`, `playwright-core` and `@sparticuz/chromium` all use
  // conditional exports / dynamic requires the server bundler mangles.
  serverExternalPackages: ["redis", "playwright-core", "@sparticuz/chromium"],
  // Force the browser packages (incl. the @sparticuz/chromium .br binary blobs,
  // which the tracer misses) into the API route's function bundle on Vercel.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/@sparticuz/chromium/**",
      "./node_modules/playwright-core/**",
    ],
  },
};

export default nextConfig;
