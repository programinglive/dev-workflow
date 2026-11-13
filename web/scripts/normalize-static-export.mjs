#!/usr/bin/env node
/**
 * Normalizes Next.js static export segment filenames on Windows.
 *
 * Next.js 16's static exporter calls `path.relative()` on segment files and passes
 * the result to `convertSegmentPathToStaticExportFilename()`, which only replaces `/`.
 * On Windows, `\` path separators remain and create nested `__next.<seg>/__PAGE__.txt`
 * directories instead of `__next.<seg>.__PAGE__.txt` files.
 *
 * On Linux/macOS, `__next.*` are already flat files, so this script is a no-op.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(path.dirname(here), "out");

async function flattenNextSegmentDir(parentDir, segmentDirName) {
  const segmentRoot = path.join(parentDir, segmentDirName);
  const stack = [{ dir: segmentRoot, parts: [segmentDirName] }];
  let moved = 0;

  while (stack.length > 0) {
    const { dir, parts } = stack.pop();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, parts: [...parts, entry.name] });
      } else if (entry.isFile()) {
        const flatName = [...parts, entry.name].join(".");
        const destPath = path.join(parentDir, flatName);
        await mkdir(path.dirname(destPath), { recursive: true });
        await rename(fullPath, destPath);
        moved += 1;
      }
    }
  }

  await rm(segmentRoot, { recursive: true, force: true });
  return moved;
}

async function walkAndNormalize(dir) {
  let totalMoved = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("__next.")) {
      totalMoved += await flattenNextSegmentDir(dir, entry.name);
    } else if (entry.name !== "_next") {
      totalMoved += await walkAndNormalize(path.join(dir, entry.name));
    }
  }
  return totalMoved;
}

async function main() {
  if (!existsSync(outDir)) {
    throw new Error(`Static export directory missing: ${outDir}`);
  }
  const st = await stat(outDir);
  if (!st.isDirectory()) {
    throw new Error(`Static export path is not a directory: ${outDir}`);
  }
  const moved = await walkAndNormalize(outDir);
  if (moved > 0) {
    console.log(`normalize-static-export: flattened ${moved} Windows RSC segment file(s) in web/out`);
  }
}

main().catch((err) => {
  console.error(`normalize-static-export failed: ${err.message}`);
  process.exit(1);
});
