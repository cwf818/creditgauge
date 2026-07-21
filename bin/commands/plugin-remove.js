/**
 * creditgauge plugin remove <provider>
 *
 * 1. Removes providers.<provider> from config.json
 * 2. Deletes ~/.claude/.../query_plugins/<provider>/ plugin files
 * 3. Deletes credential files if declared in plugins.json
 *
 * ESM port from creditgauge-plugin/src/commands/remove.js.
 */

import path from "node:path";
import fs from "node:fs";
import * as cfg from "./config.js";
import { pluginTargetDir, knownProviders, getProvider } from "./registry.js";
import { removeDirSync, confirm } from "./utils.js";

export default async function pluginRemove(args) {
  const providerId = args[0];
  const dryRun = args.includes("--dry-run");

  // Validate
  if (!providerId) {
    console.error("Error: please specify a provider ID");
    console.error("Usage: npx creditgauge plugin remove <provider>");
    process.exit(1);
  }

  const config = cfg.load();
  const hasConfigEntry = cfg.hasProvider(config, providerId);
  const target = pluginTargetDir(providerId);
  const hasFiles = fs.existsSync(target);

  // Credential directory (if declared in plugins.json)
  const meta = getProvider(providerId);
  const credDir = meta && meta.credentialsDir
    ? path.join(cfg.creditgaugeDir(), meta.credentialsDir)
    : null;
  const hasCreds = credDir && fs.existsSync(credDir);

  if (!hasConfigEntry && !hasFiles && !hasCreds) {
    console.error("Plugin \"" + providerId + "\" is not installed.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("[DRY-RUN] Will remove plugin \"" + providerId + "\"");
    if (hasConfigEntry) {
      console.log("  Remove config: providers." + providerId);
      console.log("  Current value: " + JSON.stringify(config.providers[providerId], null, 4));
    }
    if (hasFiles) {
      console.log("  Delete dir:    " + target);
    } else {
      console.log("  Plugin dir:    (does not exist, nothing to delete)");
    }
    if (hasCreds) {
      console.log("  Delete creds:  " + credDir);
    } else if (meta && meta.credentialsDir) {
      console.log("  Credentials:   (does not exist, nothing to delete)");
    }
    console.log("");
    console.log("Tip: remove --dry-run to perform actual removal");
    process.exit(0);
  }

  // Summary of what will be removed
  console.log("Preparing to remove plugin \"" + providerId + "\":");
  if (hasConfigEntry) console.log("  - Config entry providers." + providerId);
  if (hasFiles) console.log("  - Plugin directory " + target);
  if (hasCreds) console.log("  - Credential files " + credDir);

  const ok = await confirm("Confirm removal?", false);
  if (!ok) {
    console.log("Cancelled.");
    process.exit(0);
  }

  // Remove config entry
  if (hasConfigEntry) {
    delete config.providers[providerId];
    cfg.save(config);
    console.log("  OK Config entry removed");
  }

  // Remove files
  if (hasFiles) {
    removeDirSync(target);
    console.log("  OK Plugin directory deleted");
  }

  // Remove credential files
  if (hasCreds) {
    removeDirSync(credDir);
    console.log("  OK Credential files deleted");
  }

  console.log("Plugin \"" + providerId + "\" removed.");
  process.exit(0);
}
