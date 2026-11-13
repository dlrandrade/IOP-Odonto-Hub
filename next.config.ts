import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["postgres"],
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
};

export default config;
