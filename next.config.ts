import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Keep undici + playwright-core as real node modules (they are server-only and
  // must not be bundled/transformed by turbopack).
  serverExternalPackages: ["undici", "playwright-core"],
  // playwright-core ki non-JS files (browsers.json etc.) output tracing miss kar deta hai,
  // jis se standalone production me signer ka chromium launch fail hota hai. Poori package copy karo.
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/playwright-core/**/*"],
  },
};

export default nextConfig;
