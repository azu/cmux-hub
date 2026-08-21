import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncPluginVersion } from "../../scripts/sync-plugin-version.js";

const tempDirs: string[] = [];

function createFixture(packageVersion: unknown, pluginVersion: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "cmux-hub-version-"));
  tempDirs.push(dir);
  const packagePath = path.join(dir, "package.json");
  const pluginPath = path.join(dir, "plugin.json");
  writeFileSync(packagePath, `${JSON.stringify({ version: packageVersion }, null, 2)}\n`);
  writeFileSync(
    pluginPath,
    `${JSON.stringify({ name: "cmux-hub", version: pluginVersion }, null, 2)}\n`,
  );
  return { packagePath, pluginPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("syncPluginVersion", () => {
  test("copies the package version to the plugin manifest", () => {
    const fixture = createFixture("2.0.0", "1.0.0");
    expect(syncPluginVersion(fixture.packagePath, fixture.pluginPath)).toBe(true);
    expect(JSON.parse(readFileSync(fixture.pluginPath, "utf8"))).toEqual({
      name: "cmux-hub",
      version: "2.0.0",
    });
  });

  test("does not rewrite an already synchronized manifest", () => {
    const fixture = createFixture("2.0.0", "2.0.0");
    expect(syncPluginVersion(fixture.packagePath, fixture.pluginPath)).toBe(false);
  });

  test("rejects a package without a string version", () => {
    const fixture = createFixture(undefined, "1.0.0");
    expect(() => syncPluginVersion(fixture.packagePath, fixture.pluginPath)).toThrow(
      "Missing version",
    );
  });
});
