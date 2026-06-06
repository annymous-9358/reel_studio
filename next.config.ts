import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow ngrok tunnels (and any similar reverse-proxy) to reach the dev server.
  // Next.js 16 blocks cross-origin dev requests by default; without this the
  // browser-side RSC hydration is silently rejected, so React never attaches
  // event handlers and no button clicks / file uploads work.
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok-free.dev",
    "*.ngrok.io",
    "*.ngrok.app",
  ],
  experimental: { serverActions: { bodySizeLimit: "500mb" } },
};

export default nextConfig;
