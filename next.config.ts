import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // V1 uses pdf-parse v1, which is intentionally kept outside the Next.js
  // bundle. This avoids PDF.js worker resolution inside .next/Turbopack.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
