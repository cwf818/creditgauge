/**
 * creditgauge plugin auth <provider> [--mode <mode>] [--workspace-id <id>]
 *
 * 1. Checks the provider is installed (config.json entry exists)
 * 2. Finds the auth script from plugins.json metadata
 * 3. Spawns the auth script with forwarded arguments
 *
 * ESM port from creditgauge-plugin/src/commands/auth.js.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as cfg from "./config.js";
import { isKnownProvider, getProvider, knownProviders } from "./registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function pluginAuth(args) {
  const providerId = args[0];
  const extraArgs = args.slice(1);

  // Validate
  if (!providerId) {
    console.error("Error: please specify a provider ID");
    console.error("Usage: npx creditgauge plugin auth <provider> [options]");
    console.error("Known plugins: " + knownProviders().join(", "));
    process.exit(1);
  }

  if (!isKnownProvider(providerId)) {
    console.error("Error: unknown plugin \"" + providerId + "\"");
    console.error("Known plugins: " + knownProviders().join(", "));
    process.exit(1);
  }

  // Check installed
  const config = cfg.load();
  if (!cfg.hasProvider(config, providerId)) {
    console.error("Error: plugin \"" + providerId + "\" is not installed");
    console.error("Run first: npx creditgauge plugin add " + providerId);
    process.exit(1);
  }

  // Find auth script
  const meta = getProvider(providerId);
  if (!meta.hasAuth) {
    console.error("Plugin \"" + providerId + "\" does not require authentication.");
    process.exit(0);
  }

  const authScript = path.join(
    __dirname, "..", "..", "query_plugins", providerId, meta.authScript
  );

  if (!fs.existsSync(authScript)) {
    console.error("Error: auth script not found");
    console.error("  " + authScript);
    process.exit(1);
  }

  // Spawn
  console.log("Running " + providerId + " auth script...\n");

  const child = spawn(process.execPath, [authScript, ...extraArgs], {
    stdio: "inherit",
    cwd: path.dirname(authScript),
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}
