import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `redis` (node-redis) uses conditional exports / dynamic requires that the
  // server bundler can mangle — keep it external so it's require()d from
  // node_modules at runtime. playwright-core / @sparticuz/chromium are already
  // in Next's built-in external list.
  serverExternalPackages: ["redis"],
  // Make sure the @sparticuz/chromium binary pack is traced into the API
  // route's serverless function bundle on Vercel (the file tracer misses the
  // .br blobs otherwise).
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@sparticuz/chromium/**"],
  },
};

export default nextConfig;
