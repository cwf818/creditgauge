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

switch (op) {
  case "set-preset": {
    const [name] = rest;
    if (!name) {
      console.error("edit-config.mjs: set-preset requires a preset name");
      process.exit(2);
    }
    let data;
    if (!existsSync(target)) {
      data = {};
    } else {
      try {
        data = readJson(target);
      } catch (e) {
        console.error(`edit-config.mjs: cannot read config (${e.message}); leaving file untouched`);
        process.exit(1);
      }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      console.error("edit-config.mjs: config.json root must be an object; leaving file untouched");
      process.exit(1);
    }
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

  default:
    console.error(`edit-config.mjs: unknown op '${op}'`);
    process.exit(2);
}
