import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Netlify deployment
  output: 'export',
  trailingSlash: true,
  // Workspace root tetap `web/`. Versi dibaca oleh `scripts/generate-version.mjs`
  // saat prebuild, bukan dengan mengimpor manifest di luar root: Turbopack
  // menolak berkas di luar workspace, dan menaikkan root ke repo akan menarik
  // seluruh node_modules repo ke build situs.
  turbopack: {
    root: __dirname,
  },
  // Disable image optimization for static export
  images: {
    unoptimized: true,
  },
  // Exclude native modules from bundling
  serverExternalPackages: ['pg'],
};

export default nextConfig;
