#!/usr/bin/env node
// edit-config.mjs — small helper for scripts/config.sh to read & write
// creditgauge's config.json (CLAUDE_CONFIG_DIR/plugins/creditgauge/config.json).
//
// Usage:
//   node scripts/lib/edit-config.mjs <config-file> <op> [args]
//
// Operations:
//   set-preset <config-file> <name>
//       Read-modify-write: sets `statuslineTemplate` to "<name>" (string form,
//       a preset name). Creates the file if absent; preserves all other keys
//       and the original line ending (CRLF/LF). Bad JSON → stderr + exit 1,
//       file left untouched.
//   set-provider <config-file> <id>
//       Read-modify-write: sets `providerOverride` to "<id>". <id> MUST already
//       be a key in the file's `providers` object — otherwise this exits 1 and
//       writes nothing. A missing plugin for the id is only a printed note
//       (the statusline runtime is the authority and will warn + fall back).
//   clear-provider <config-file>
//       Sets `providerOverride` back to "". A missing config.json is a no-op.
//
// Targets must be absolute, native-OS paths (use `cygpath -w` on Git Bash).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [, , target, op, ...rest] = process.argv;

if (!target || !op) {
  console.error("edit-config.mjs: missing target or op");
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  // Preserve the original line ending: detect CRLF vs LF from a sample byte.
  let eol = "\n";
  try {
    const size = statSync(p).size;
    const head = Buffer.alloc(Math.min(64, size));
    const fd = openSync(p, "r");
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (head.includes(0x0d)) eol = "\r\n";
  } catch {
    /* target may be new; default to LF */
  }
  const body = text.replace(/\n/g, eol);
  writeFileSync(p, body);
}

// Read the target as a plain object, or null when the file is absent. The
// caller decides whether "absent" is an error. Unreadable JSON / a non-object
// root exits 1 so a half-understood file is never rewritten.
function loadTarget(p) {
  if (!existsSync(p)) return null;
  let data;
  try {
    data = readJson(p);
  } catch (e) {
    console.error(`edit-config.mjs: cannot read config (${e.message}); leaving file untouched`);
    process.exit(1);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.error("edit-config.mjs: config.json root must be an object; leaving file untouched");
    process.exit(1);
  }
  return data;
}

function providerKeys(data) {
  const providers = data && data.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
  return Object.keys(providers);
}

const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;

// Advisory plugin-existence check, mirroring src/api.ts's resolution order
// closely enough for a note: a user copy at
// <claudeRoot>/plugins/creditgauge/query_plugins/<id>/ wins, else the bundled
// copy beside this script (<pluginRoot>/query_plugins/<id>/). The runtime
// re-checks far more carefully; this only decides whether to print a caveat.
// The id is regex-gated so a configured value can never walk the filesystem.
function pluginExists(targetPath, id) {
  if (!PROVIDER_ID_RE.test(id)) return false;
  const userDir = join(dirname(targetPath), "query_plugins", id);
  if (existsSync(join(userDir, "index.js"))) return true;
  if (existsSync(join(userDir, "index.mjs"))) return true;
  const bundledDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "query_plugins",
    id,
  );
  return existsSync(join(bundledDir, "index.js"));
}

switch (op) {
  case "set-preset": {
    const [name] = rest;
    if (!name) {
      console.error("edit-config.mjs: set-preset requires a preset name");
      process.exit(2);
    }
    const data = loadTarget(target) ?? {};
    const prev = data.statuslineTemplate;
    data.statuslineTemplate = name;
    writeJson(target, data);
    if (Array.isArray(prev)) {
      console.log(`set statuslineTemplate: ${name} (replaced custom template with ${prev.length} tokens)`);
    } else {
      console.log(`set statuslineTemplate: ${name}`);
    }
    break;
  }

  case "set-provider": {
    const [name] = rest;
    if (!name) {
      console.error("edit-config.mjs: set-provider requires a provider id");
      process.exit(2);
    }
    const data = loadTarget(target);
    if (!data) {
      console.error(`edit-config.mjs: no config.json at ${target}; nothing written`);
      console.error("  add a `providers` block first (see config.example.json)");
      process.exit(1);
    }
    const keys = providerKeys(data);
    if (!keys.includes(name)) {
      console.error(`edit-config.mjs: "${name}" is not a key in providers; nothing written`);
      console.error(`  known providers: ${keys.length > 0 ? keys.join(", ") : "(none)"}`);
      process.exit(1);
    }
    data.providerOverride = name;
    writeJson(target, data);
    console.log(`set providerOverride: ${name}`);
    if (!pluginExists(target, name)) {
      console.log(
        `  note: no plugin found at query_plugins/${name}/ — the statusline ` +
        `will warn and fall back to ANTHROPIC_BASE_URL matching`,
      );
    }
    break;
  }

  case "clear-provider": {
    const data = loadTarget(target);
    if (!data) {
      console.log("no config.json; nothing to clear (no-op)");
      break;
    }
    const prev = data.providerOverride;
    data.providerOverride = "";
    writeJson(target, data);
    if (typeof prev === "string" && prev.length > 0) {
      console.log(`cleared providerOverride (was "${prev}")`);
    } else {
      console.log("providerOverride already unset (no-op)");
    }
    break;
  }

  default:
    console.error(`edit-config.mjs: unknown op '${op}'`);
    process.exit(2);
}
