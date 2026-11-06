import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // A transitive wallet connector imports CDP's Node SDK. Keep its optional
  // payment modules lazy instead of resolving unused peers during SSR bundling.
  serverExternalPackages: ["@coinbase/cdp-sdk"],
  // The copied design uses plain CSS, which Turbopack handles natively.
  devIndicators: false,
};

export default nextConfig;
