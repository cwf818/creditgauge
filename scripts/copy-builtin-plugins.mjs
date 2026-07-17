#!/usr/bin/env node
// Copy built-in plugin .js files from src/plugins/<id>/index.js to
// dist/plugins/<id>/index.js. Built-in plugins are plain ESM JS —
// the same shape as user-written plugins under
// ~/.claude/plugins/creditgauge/query_plugins/<id>/index.{js,mjs}.
// No transpile step; the host loader imports these directly via
// dynamic `import()`.

import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..", "src", "plugins");
const distRoot = resolve(here, "..", "dist", "plugins");

mkdirSync(distRoot, { recursive: true });

let copied = 0;
for (const entry of readdirSync(srcRoot)) {
  const srcPath = join(srcRoot, entry);
  if (!statSync(srcPath).isDirectory()) continue;
  const srcFile = join(srcPath, "index.js");
  // Each plugin must be a directory with an index.js (ESM). Anything
  // else (parser modules, data.ts, parsers.ts) is already bundled
  // into dist/index.js by the entry esbuild step.
  let exists = false;
  try {
    exists = statSync(srcFile).isFile();
  } catch {
    continue;
  }
  if (!exists) continue;

  const distDir = join(distRoot, entry);
  mkdirSync(distDir, { recursive: true });
  cpSync(srcFile, join(distDir, "index.js"));
  copied += 1;
  console.log(`copy-builtin-plugins: ${entry}/index.js`);
}

console.log(`copy-builtin-plugins: ${copied} plugin(s) copied`);