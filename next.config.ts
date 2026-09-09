import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Make sure the @sparticuz/chromium binary pack is traced into the API
  // route's serverless function bundle on Vercel (the file tracer misses the
  // .br blobs otherwise). playwright-core / @sparticuz/chromium are already in
  // Next's built-in serverExternalPackages list, so no need to repeat them.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@sparticuz/chromium/**"],
  },
};

export default nextConfig;
