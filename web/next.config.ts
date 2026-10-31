import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Static export for Netlify deployment
  output: 'export',
  trailingSlash: true,
  // Turbopack root = repo root, not web/. `lib/version.ts` reads the root
  // package.json so the site shows the version that was actually released; with
  // the root pinned to web/ that import is outside the workspace and fails to
  // resolve.
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  // Disable image optimization for static export
  images: {
    unoptimized: true,
  },
  // Exclude native modules from bundling
  serverExternalPackages: ['pg'],
};

export default nextConfig;
