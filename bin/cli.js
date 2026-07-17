#!/usr/bin/env node
// bin/cli.js — creditgauge install/uninstall/clean/diagnostics TUI
//
// Modes:
//   npx creditgauge                  → interactive clack/prompts menu
//   npx creditgauge install          → non-interactive, passthrough args
//   npx creditgauge uninstall        → non-interactive
//   npx creditgauge clean            → non-interactive
//   npx creditgauge clean-cache      → non-interactive
//   npx creditgauge reset            → non-interactive
//   npx creditgauge diagnostics      → print last 20 diagnostics rows
//   npx creditgauge --version / -v
//   npx creditgauge --help / -h
//
// Pure ESM. Node 18+.
// Dependencies: @clack/prompts (for the interactive TUI)

import {
  intro,
  outro,
  select,
  isCancel,
  cancel,
  log,
  note,
} from "@clack/prompts";
import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { EOL } from "node:os";

// ---------------------------------------------------------------------------
// Path resolution (works from the npm-installed package root)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, "..");
const scriptsDir = join(pkgRoot, "scripts");
const require2 = createRequire(import.meta.url);
const pkg = require2(join(pkgRoot, "package.json"));

// ---------------------------------------------------------------------------
// Bash pre-flight
// ---------------------------------------------------------------------------

function hasBash() {
  const r = spawnSync("bash", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// Plugin-cache detection
// ---------------------------------------------------------------------------

function claudeRoot() {
  return (
    process.env.CLAUDE_CONFIG_DIR ||
    join(
      process.env.HOME || process.env.USERPROFILE || "~",
      ".claude",
    )
  );
}

function pluginCacheDir() {
  return join(claudeRoot(), "plugins", "cache", "creditgauge", "creditgauge");
}

async function isInPluginCache() {
  try {
    const entries = await readdir(pluginCacheDir(), { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name));
  } catch {
    return false;
  }
}

function cacheMissHint() {
  return (
    [
      "creditgauge is not yet in Claude Code's plugin cache.",
      "",
      `Expected: ${pluginCacheDir()}/<version>/`,
      "",
      "Install it once via Claude Code's marketplace flow:",
      "  /plugin marketplace add cwf818/creditgauge",
      "  /plugin install creditgauge@creditgauge",
      "  /reload-plugins",
      "",
      "After that, the plugin copies itself into the cache, and future",
      "`npx creditgauge install` calls will work.",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Script runner
// ---------------------------------------------------------------------------

function runScript(scriptName, extraArgs = []) {
  return new Promise((resolveP) => {
    const scriptPath = join(scriptsDir, scriptName);
    const args = [scriptPath, ...extraArgs];
    const child = spawn("bash", args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => {
      process.stderr.write(
        `creditgauge: failed to spawn bash: ${err.message}${EOL}`,
      );
      resolveP({ code: 127 });
    });
    child.on("close", (code) => resolveP({ code: code ?? 1 }));
  });
}

async function withScript(label, scriptName, extraArgs = []) {
  log.step(
    `Running: bash scripts/${scriptName}${extraArgs.length ? " " + extraArgs.join(" ") : ""}`,
  );
  const { code } = await runScript(scriptName, extraArgs);
  if (code === 0) {
    log.success(`${label} completed.`);
  } else {
    log.error(`${label} failed (exit ${code}). See output above.`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// Diagnostics reader
// ---------------------------------------------------------------------------

async function readDiagnostics(_cwd, limit = 20) {
  const stateRoot = join(claudeRoot(), "plugins", "creditgauge", "state");
  const files = [];
  // Per-project diagnostics
  try {
    const projects = await readdir(stateRoot, { withFileTypes: true });
    for (const p of projects) {
      if (p.isDirectory()) {
        files.push(join(stateRoot, p.name, "diagnostics.jsonl"));
      }
    }
  } catch {
    /* state dir may not exist yet */
  }
  // Top-level fallback
  files.push(join(stateRoot, "diagnostics.jsonl"));

  const rows = [];
  for (const f of files) {
    try {
      const text = await readFile(f, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* file may not exist */
    }
  }
  rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return rows.slice(0, limit);
}

function formatDiagnostics(rows) {
  if (rows.length === 0) {
    return "(no diagnostics entries found)";
  }
  return rows
    .map((r) => {
      const fn = r.fn ? ` ${r.fn}` : "";
      const cwd2 = r.cwd ? ` [${r.cwd}]` : "";
      return `${r.iso}  ${(r.level ?? "").toUpperCase().padEnd(7)} ${r.source}${fn}\n    ${r.msg}${cwd2 ? "\n" + cwd2 : ""}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// TUI menu
// ---------------------------------------------------------------------------

async function menuInstall() {
  if (!(await isInPluginCache())) {
    log.warn("Plugin is not in Claude Code's cache yet.");
    note(cacheMissHint(), "cache miss");
    const action = await select({
      message: "What now?",
      options: [{ value: "back", label: "Back to menu" }],
    });
    return action !== "back"; // stay in menu
  }
  const proceed = await select({
    message: "Install will edit your Claude Code settings.json. Continue?",
    options: [
      { value: "yes", label: "Yes, install (user-level)" },
      {
        value: "project",
        label: "Yes, install (project-level, current dir)",
      },
      { value: "no", label: "Cancel" },
    ],
  });
  if (isCancel(proceed) || proceed === "no") return true;
  const args = proceed === "project" ? ["--project"] : [];
  await withScript("Install", "install.sh", args);
  return true;
}

async function menuUninstall() {
  const proceed = await select({
    message: "Uninstall restores your pre-creditgauge statusline. Continue?",
    options: [
      { value: "yes", label: "Yes, uninstall" },
      { value: "no", label: "Cancel" },
    ],
  });
  if (isCancel(proceed) || proceed === "no") return true;
  await withScript("Uninstall", "uninstall.sh");
  return true;
}

async function menuClean() {
  const proceed = await select({
    message: "Clean: which mode?",
    options: [
      { value: "dry", label: "Dry-run (preview, change nothing)" },
      {
        value: "real",
        label: "Real (remove old backups + purge runtime if flagged)",
      },
      { value: "no", label: "Cancel" },
    ],
  });
  if (isCancel(proceed) || proceed === "no") return true;
  const args = proceed === "dry" ? ["--dry-run"] : [];
  await withScript("Clean", "clean.sh", args);
  return true;
}

async function menuDiagnostics() {
  const rows = await readDiagnostics(process.cwd(), 20);
  note(formatDiagnostics(rows), "Last diagnostics entries");
  return true;
}

const MAIN_MENU = [
  {
    value: "install",
    label: "Install",
    hint: "wire wrapper into settings.json",
  },
  {
    value: "uninstall",
    label: "Uninstall",
    hint: "restore pre-creditgauge statusline",
  },
  {
    value: "clean",
    label: "Clean",
    hint: "remove old backups; optional runtime purge",
  },
  {
    value: "diagnostics",
    label: "View diagnostics",
    hint: "last 20 plugin warning/error entries",
  },
  { value: "exit", label: "Exit", hint: "quit the TUI" },
];

const HANDLERS = {
  install: menuInstall,
  uninstall: menuUninstall,
  clean: menuClean,
  diagnostics: menuDiagnostics,
};

async function runTui() {
  intro("creditgauge");
  if (!hasBash()) {
    log.error(
      "`bash` was not found on PATH. The install/uninstall/clean scripts require bash (Git Bash on Windows, system bash on Linux/macOS).",
    );
    outro("Aborting.");
    process.exit(2);
  }
  let keepGoing = true;
  while (keepGoing) {
    const action = await select({
      message: "选择操作:",
      options: MAIN_MENU,
    });
    if (isCancel(action) || action === "exit") {
      cancel("Cancelled.");
      keepGoing = false;
      break;
    }
    const handler = HANDLERS[action];
    if (handler) keepGoing = await handler();
    else keepGoing = false;
  }
  outro("Bye.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];

  // Interactive mode
  if (!cmd || cmd === "tui" || cmd === "menu" || cmd === "ui") {
    await runTui();
    return;
  }

  // Flags
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${pkg.name} ${pkg.version}${EOL}`);
    return;
  }
  if (cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      [
        `creditgauge ${pkg.version}`,
        "",
        "Usage:",
        "  npx creditgauge                  launch interactive TUI",
        "  npx creditgauge install          run scripts/install.sh",
        "  npx creditgauge install --project   ... at project level",
        "  npx creditgauge uninstall        run scripts/uninstall.sh",
        "  npx creditgauge clean            run scripts/clean.sh",
        "  npx creditgauge clean-cache      run scripts/clean-cache.sh",
        "  npx creditgauge reset            run scripts/reset.sh",
        "  npx creditgauge diagnostics      print last 20 diagnostics rows",
        "  npx creditgauge --version",
        "  npx creditgauge --help",
      ].join("\n") + EOL,
    );
    return;
  }

  // Subcommands
  const restArgs = process.argv.slice(3);
  const scriptMap = {
    install: { script: "install.sh", label: "Install" },
    uninstall: { script: "uninstall.sh", label: "Uninstall" },
    clean: { script: "clean.sh", label: "Clean" },
    "clean-cache": { script: "clean-cache.sh", label: "Clean cache" },
    reset: { script: "reset.sh", label: "Reset" },
  };

  if (cmd === "diagnostics") {
    const rows = await readDiagnostics(process.cwd(), Number(restArgs[0]) || 20);
    process.stdout.write(formatDiagnostics(rows) + EOL);
    return;
  }

  const entry = scriptMap[cmd];
  if (!entry) {
    process.stderr.write(
      `creditgauge: unknown command '${cmd}'. Try \`npx creditgauge --help\`.${EOL}`,
    );
    process.exit(2);
  }
  if (cmd === "install" && !(await isInPluginCache())) {
    process.stderr.write(cacheMissHint() + EOL);
    process.exit(1);
  }
  const code = await withScript(entry.label, entry.script, restArgs);
  process.exit(code === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(
    `creditgauge: unexpected error: ${err && err.stack ? err.stack : String(err)}${EOL}`,
  );
  process.exit(1);
});
