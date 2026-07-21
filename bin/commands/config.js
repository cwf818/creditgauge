/**
 * CreditGauge config.json read / write utilities.
 * ESM port from creditgauge-plugin/src/config.js.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/** ~/.claude/plugins/creditgauge */
export function creditgaugeDir() {
  const home = homedir();
  if (!home) {
    console.error("Error: cannot determine home directory (HOME / USERPROFILE)");
    process.exit(1);
  }
  return path.join(home, ".claude", "plugins", "creditgauge");
}

/** Full path to config.json */
export function configPath() {
  return path.join(creditgaugeDir(), "config.json");
}

/** Load and parse config.json */
export function load() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    console.error("Error: config file not found");
    console.error("  " + p);
    console.error("Please confirm CreditGauge is installed.");
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.error("Error: invalid config file format");
    console.error("  " + p);
    process.exit(1);
  }
}

/** Write config.json (pretty-printed) */
export function save(config) {
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Check if a provider already has an entry in config */
export function hasProvider(config, providerId) {
  return !!(config.providers && config.providers[providerId]);
}

/** Ensure the `providers` key exists */
export function ensureProviders(config) {
  if (!config.providers) config.providers = {};
  return config;
}
