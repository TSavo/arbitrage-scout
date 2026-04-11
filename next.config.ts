import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "better-sqlite3",
    "sqlite-vec",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-linux-x64",
  ],
};

export default nextConfig;
