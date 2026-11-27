/**
 * @zettly-code DWF-VITE-CONFIG-001
 * @purpose Vite SSR build configuration for dist/index.mjs with zero runtime dependency on vite in vite.config.js.
 */
import { fileURLToPath } from 'url';
import path from 'path';
import { builtinModules } from 'node:module';

const defineConfig = (config) => config;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  consumer: 'server',
  build: {
    target: 'node18',
    ssr: true,
    outDir: 'dist',
    minify: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.js'),
      output: {
        entryFileNames: 'index.mjs',
        format: 'es',
      },
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return;
        warn(warning);
      },
      external: [
        ...builtinModules,
        ...builtinModules.map(name=>`node:${name}`),
        'pg','mysql2','mysql2/promise','better-sqlite3',
        '@modelcontextprotocol/sdk',
        '@programinglive/zettly-code',
        // dotenv ships CommonJS only (dist/index.cjs). Bundling it into an ES
        // module leaks its `require.main === module` guard, which throws
        // "require is not defined in ES module scope" at startup. Keeping it
        // external lets Node load it as CJS, which is how it is designed to run.
        'dotenv',
        'dotenv/config',
        // Node.js built-in modules
        'node:fs',
        'node:path',
        'node:url',
        'node:util',
        'node:os',
        'node:process',
        'node:child_process',
        'fs',
        'fs/promises',
        'path',
        'url',
        'util',
        'os',
        'process',
        'child_process',
        'events',
        'net',
        'tls',
        'timers',
        'stream',
        'crypto',
        'zlib',
        'dns',
      ],
    },
  },
  define: {
    __filename: JSON.stringify(path.resolve(__dirname, 'index.js')),
  },
});
