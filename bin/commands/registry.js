/**
 * Plugin metadata registry.
 *
 * Loads provider config templates from query_plugins/plugins.json
 * so the add / remove / auth / list commands know what to install.
 *
 * ESM port from creditgauge-plugin/src/registry.js.
 * Uses lazy getter for REGISTRY so import does not trigger process.exit
 * for non-plugin CLI commands.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Plugin source directory within this package. */
export function pluginSourceDir(providerId) {
  return path.join(__dirname, "..", "..", "query_plugins", providerId);
}

/** Plugin target directory inside CreditGauge user data. */
export function pluginTargetDir(providerId) {
  const home = homedir();
  return path.join(
    home,
    ".claude",
    "plugins",
    "creditgauge",
    "query_plugins",
    providerId
  );
}

/** Path to the registry JSON */
function registryJsonPath() {
  return path.join(__dirname, "..", "..", "query_plugins", "plugins.json");
}

// Lazy getter — only loads when a plugin command actually runs.
let _registry = null;

function getRegistry() {
  if (_registry) return _registry;
  const p = registryJsonPath();
  if (!fs.existsSync(p)) {
    console.error("Error: plugin registry not found");
    console.error("  " + p);
    process.exit(1);
  }
  try {
    _registry = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.error("Error: invalid plugin registry JSON");
    console.error("  " + p);
    process.exit(1);
  }
  return _registry;
}

export function knownProviders() {
  return Object.keys(getRegistry());
}

export function isKnownProvider(id) {
  return id in getRegistry();
}

export function getProvider(id) {
  return getRegistry()[id] || null;
}
