import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolate development browser tests from an already-running local studio.
  distDir: process.env.CONSENTCRAFT_E2E_DEV === "1" ? ".next-e2e-dev" : ".next",
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // A transitive wallet connector imports CDP's Node SDK. Keep its optional
  // payment modules lazy instead of resolving unused peers during SSR bundling.
  // The 0G and Turbo SDKs load crypto and wasm modules dynamically; run them from node_modules.
  serverExternalPackages: ["@coinbase/cdp-sdk", "@0gfoundation/0g-compute-ts-sdk", "@ardrive/turbo-sdk", "ethers", "circomlibjs"],
  // The copied design uses plain CSS, which Turbopack handles natively.
  devIndicators: false,
  poweredByHeader: false,
  // Baseline hardening. Framing is blocked so wallet prompts can't be clickjacked.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
      ],
    }];
  },
};

export default nextConfig;
