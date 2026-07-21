/**
 * creditgauge plugin list — list available query plugins.
 */

import { knownProviders, getProvider } from "./registry.js";

export default async function pluginList(_args) {
  const providers = knownProviders();
  console.log("\nAvailable plugins:\n");
  for (const id of providers) {
    const meta = getProvider(id);
    const hasAuth = meta.hasAuth ? " [supports auth]" : "";
    console.log("  " + id + hasAuth);
    console.log("    " + (meta.title || meta.description || ""));
    console.log();
  }
  process.exit(0);
}
