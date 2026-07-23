/**
 * creditgauge plugin add <provider>
 *
 * 1. Shows provider description and template for interactive editing
 * 2. Copies query_plugins/<provider>/ to ~/.claude/.../query_plugins/<provider>/
 * 3. Writes providers.<provider> to config.json
 *
 * ESM port from creditgauge-plugin/src/commands/add.js.
 */

import fs from "node:fs";
import {
  pluginSourceDir,
  pluginTargetDir,
  isKnownProvider,
  getProvider,
  knownProviders,
} from "./registry.js";
import * as cfg from "./config.js";
import { copyDirSync, confirm, prompt, select, wrapText } from "./utils.js";

/**
 * Interactively edit the template fields before installation.
 */
async function editTemplate(providerMeta) {
  const tpl = { ...providerMeta.template };

  console.log("\n--- " + providerMeta.title + " ---\n");
  if (providerMeta.description) {
    console.log(wrapText(providerMeta.description, 80, "  "));
    console.log("");
  }

  console.log("--- Start installation ---\n");

  // Phase 1: alternativeToken prompt
  if (providerMeta.alternativeToken && "AUTHENTICATION_KEY" in tpl) {
    console.log(wrapText(providerMeta.alternativeTokenHint, 80, "  "));
    console.log("");
    const keyVal = await prompt("AUTHENTICATION_KEY", tpl.AUTHENTICATION_KEY);
    if (keyVal) tpl.AUTHENTICATION_KEY = keyVal;
    console.log("  Tip: can edit manually later\n");
  }

  // Phase 2: menu-driven editing
  while (true) {
    console.log("Current config:");
    console.log("  TYPE              = " + tpl.TYPE);
    console.log("  COMPARE_METHOD    = " + tpl.COMPARE_METHOD);
    console.log("  BASE_URL_COMPARED_TO = " + tpl.BASE_URL_COMPARED_TO);
    if ("AUTHENTICATION_KEY" in tpl) {
      const masked = tpl.AUTHENTICATION_KEY
        ? tpl.AUTHENTICATION_KEY.slice(0, 4) + "****"
        : "(empty)";
      console.log("  AUTHENTICATION_KEY = " + masked);
    }
    if ("CURRENCY" in tpl && Array.isArray(tpl.CURRENCY)) {
      console.log("  CURRENCY          = " + tpl.CURRENCY.join(", "));
    }
    console.log("");

    console.log("Actions:");
    console.log("  t  Edit TYPE");
    console.log("  u  Edit BASE_URL_COMPARED_TO");
    console.log("  m  Edit COMPARE_METHOD");
    if ("AUTHENTICATION_KEY" in tpl) {
      console.log("  k  Edit AUTHENTICATION_KEY");
    }
    if ("CURRENCY" in tpl) {
      console.log("  c  Edit CURRENCY");
    }
    console.log("  Enter  Confirm and continue");
    console.log("");

    const action = await prompt("Choose action", "");
    if (!action) break;

    switch (action.toLowerCase()) {
      case "t": {
        tpl.TYPE = await select(
          "TYPE (current: " + tpl.TYPE + ")",
          ["QUOTA", "BALANCE"],
          tpl.TYPE === "BALANCE" ? 1 : 0
        );
        break;
      }
      case "u": {
        const url = await prompt("BASE_URL_COMPARED_TO", tpl.BASE_URL_COMPARED_TO);
        if (url) tpl.BASE_URL_COMPARED_TO = url;
        break;
      }
      case "m": {
        const methodOptions = ["EXACT", "INCLUDE", "STARTWITH"];
        const methodIdx = methodOptions.indexOf(tpl.COMPARE_METHOD);
        tpl.COMPARE_METHOD = await select(
          "COMPARE_METHOD (current: " + tpl.COMPARE_METHOD + ")",
          methodOptions,
          methodIdx >= 0 ? methodIdx : 0
        );
        break;
      }
      case "k": {
        if ("AUTHENTICATION_KEY" in tpl) {
          const keyVal = await prompt("AUTHENTICATION_KEY", tpl.AUTHENTICATION_KEY);
          if (keyVal) tpl.AUTHENTICATION_KEY = keyVal;
          else console.log("  (kept original value)");
        }
        break;
      }
      case "c": {
        if ("CURRENCY" in tpl && Array.isArray(tpl.CURRENCY)) {
          const current = tpl.CURRENCY.join(", ");
          const raw = await prompt("CURRENCY (comma-separated)", current);
          if (raw) {
            tpl.CURRENCY = raw.split(",").map(s => s.trim()).filter(Boolean);
          } else {
            console.log("  (kept original value)");
          }
        }
        break;
      }
      default:
        console.log("Unknown action: " + action);
    }
    console.log("");
  }

  return tpl;
}

export default async function pluginAdd(args) {
  const providerId = args[0];
  const dryRun = args.includes("--dry-run");

  // Validate
  if (!providerId) {
    console.error("Error: please specify a provider ID");
    console.error("Usage: npx creditgauge plugin add <provider>");
    console.error("Known plugins: " + knownProviders().join(", "));
    process.exit(1);
  }

  if (!isKnownProvider(providerId)) {
    console.error("Error: unknown plugin \"" + providerId + "\"");
    console.error("Known plugins: " + knownProviders().join(", "));
    process.exit(1);
  }

  const source = pluginSourceDir(providerId);
  if (!fs.existsSync(source)) {
    console.error("Error: plugin source directory not found");
    console.error("  " + source);
    console.error("Please check the package is complete.");
    process.exit(1);
  }

  const providerMeta = getProvider(providerId);
  const target = pluginTargetDir(providerId);
  const config = cfg.load();
  const configEntryExists = cfg.hasProvider(config, providerId);
  const filesExist = fs.existsSync(target);

  // Edit template interactively
  const entry = await editTemplate(providerMeta);

  // Dry-run
  if (dryRun) {
    console.log("\n[DRY-RUN] Will install plugin \"" + providerId + "\"");
    console.log("  Source:  " + source);
    console.log("  Target:  " + target);
    console.log("  Config:  " + cfg.configPath());
    console.log("  Entry:   " + JSON.stringify(entry, null, 4));

    if (configEntryExists) {
      console.log("  Status: providers." + providerId + " already exists (will overwrite)");
    } else {
      console.log("  Status: providers." + providerId + " does not exist (will create)");
    }

    if (filesExist) {
      console.log("  Plugin dir: already exists (will overwrite)");
    } else {
      console.log("  Plugin dir: does not exist (will create)");
    }

    console.log("\nTip: remove --dry-run to perform actual installation");
    process.exit(0);
  }

  // Check existing installation
  if (configEntryExists || filesExist) {
    console.log("\nPlugin \"" + providerId + "\" (" +
      (configEntryExists && filesExist
        ? "installed and configured"
        : configEntryExists
          ? "configured but files missing"
          : "files exist but not configured") +
      ")");

    const overwrite = await confirm("Overwrite existing installation?", false);
    if (!overwrite) {
      console.log("Cancelled.");
      process.exit(0);
    }
  }

  // Copy files
  console.log("\n  -> Copying files...");
  copyDirSync(source, target);
  console.log("  OK Files installed to: " + target);

  // Update config
  cfg.ensureProviders(config);
  config.providers[providerId] = entry;
  cfg.save(config);
  console.log("  OK Config written");

  // Summary
  console.log("\nPlugin \"" + providerId + "\" installed.");

  if (entry.AUTHENTICATION_KEY !== undefined && !entry.AUTHENTICATION_KEY) {
    console.log("Tip: set AUTHENTICATION_KEY for " + providerId);
    if (providerMeta.hasAuth) {
      console.log("  Run: npx creditgauge plugin auth " + providerId);
    } else {
      console.log("  Edit " + cfg.configPath());
    }
  }

  if (providerMeta.hasAuth) {
    console.log("To log in and get credentials: npx creditgauge plugin auth " + providerId);
  }

  process.exit(0);
}
