import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // The copied design uses plain CSS, which Turbopack handles natively.
  devIndicators: false,
};

export default nextConfig;
