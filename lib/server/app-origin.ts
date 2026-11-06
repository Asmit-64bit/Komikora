import "server-only";

/** Never derive the sign-in domain from untrusted request headers. */
export function configuredAppOrigin(env: Record<string, string | undefined> = process.env): string | undefined {
  const configured = env.APP_ORIGIN?.trim() || env.NEXT_PUBLIC_APP_URL?.trim();
  const url = configured ? new URL(configured) : undefined;
  const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (env.VERCEL === "1" && (!url || local)) {
    const host = env.VERCEL_ENV === "production"
      ? env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL
      : env.VERCEL_URL || env.VERCEL_PROJECT_PRODUCTION_URL;
    if (!host) return undefined;
    const deployed = new URL(`https://${host}`);
    if (deployed.username || deployed.password || deployed.pathname !== "/" || deployed.search || deployed.hash) throw new Error("Invalid deployment origin.");
    return deployed.origin;
  }
  if (url && (!["http:", "https:"].includes(url.protocol) || url.username || url.password)) throw new Error("Invalid application origin.");
  return url?.origin;
}
