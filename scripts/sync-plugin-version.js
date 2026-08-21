import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {Record<string, unknown> & { version?: unknown }} VersionedJson */

/**
 * @param {string} filePath
 * @returns {VersionedJson}
 */
function readVersionedJson(filePath) {
  return /** @type {VersionedJson} */ (JSON.parse(readFileSync(filePath, "utf8")));
}

/**
 * @param {string} packagePath
 * @param {string} pluginPath
 * @returns {boolean}
 */
export function syncPluginVersion(packagePath, pluginPath) {
  const packageJson = readVersionedJson(packagePath);
  if (typeof packageJson.version !== "string") {
    throw new Error(`Missing version in ${packagePath}`);
  }

  const pluginJson = readVersionedJson(pluginPath);
  if (pluginJson.version === packageJson.version) return false;

  pluginJson.version = packageJson.version;
  writeFileSync(pluginPath, `${JSON.stringify(pluginJson, null, 2)}\n`);
  return true;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const root = path.join(path.dirname(scriptPath), "..");
  const packagePath = path.join(root, "package.json");
  const pluginPath = path.join(root, "cmux-hub-plugin", ".claude-plugin", "plugin.json");
  const changed = syncPluginVersion(packagePath, pluginPath);
  console.log(changed ? "Synced plugin version" : "Plugin version already matches");
}
