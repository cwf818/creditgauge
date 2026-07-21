/**
 * Shared utilities for the CLI plugin commands.
 * ESM port from creditgauge-plugin/src/utils.js.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Recursively copy a directory.
 */
export function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Remove a directory recursively. Skips if not found.
 */
export function removeDirSync(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Ask a yes/no question. Returns true for y/yes, false for n/no.
 */
export async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + " " + hint + " ", (input) => {
      rl.close();
      const trimmed = input.trim().toLowerCase();
      if (!trimmed) return resolve(defaultYes);
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Ask a question with free-form text answer.
 */
export async function prompt(question, defaultVal = "") {
  const hint = defaultVal ? " (" + defaultVal + ")" : "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + hint + ": ", (input) => {
      rl.close();
      const trimmed = input.trim();
      resolve(trimmed || defaultVal);
    });
  });
}

/**
 * Present a list of options and let the user pick by number or name.
 */
export async function select(question, options, defaultIdx = 0) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n" + question);
  options.forEach((opt, i) => {
    const marker = i === defaultIdx ? " (default)" : "";
    console.log("  " + (i + 1) + ". " + opt + marker);
  });

  return new Promise((resolve) => {
    rl.question("Enter number or value (Enter=default): ", (input) => {
      rl.close();
      const trimmed = input.trim();

      if (!trimmed) return resolve(options[defaultIdx]);

      const idx = parseInt(trimmed, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= options.length) {
        return resolve(options[idx - 1]);
      }

      const match = options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
      if (match) return resolve(match);

      resolve(trimmed);
    });
  });
}

/**
 * Wrap text to a given width, preserving existing newlines.
 */
export function wrapText(text, width = 80, indent = "") {
  if (!text) return "";
  const indentLen = indent.length;
  const available = width - indentLen;
  const lines = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";

    for (const word of words) {
      if ((line ? line.length + 1 + word.length : word.length) > available) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    if (line) lines.push(line);
  }

  return lines.map((l) => indent + l).join("\n");
}
