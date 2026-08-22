import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "kerkerker-plugin-contract-"));

try {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", temporaryDirectory], {
    cwd: packageDirectory,
    stdio: "pipe",
  });
  const tarball = readdirSync(temporaryDirectory).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack did not create a tarball");
  const installDirectory = join(temporaryDirectory, "install");
  execFileSync("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    "--prefix", installDirectory, join(temporaryDirectory, tarball),
  ], { stdio: "pipe" });

  const requireFromInstall = createRequire(join(installDirectory, "smoke.cjs"));
  const contractEntry = requireFromInstall.resolve("@kerkerker/plugin-contract");
  const schemaEntry = requireFromInstall.resolve(
    "@kerkerker/plugin-contract/schemas/plugin-job-event.v1.schema.json"
  );
  const fixtureEntry = requireFromInstall.resolve(
    "@kerkerker/plugin-contract/fixtures/plugin-job-event.v1.valid.json"
  );
  const invalidFixtureEntry = requireFromInstall.resolve(
    "@kerkerker/plugin-contract/fixtures/plugin-job-event.v1.invalid.json"
  );
  const contract = await import(pathToFileURL(contractEntry).href);
  assert.equal(contract.PLUGIN_CONTRACT_VERSION, "1.0.0");
  assert.equal(contract.PLUGIN_JOB_EVENT_SCHEMA, "kerkerker.plugin-job.v1");
  assert.equal(
    JSON.parse(readFileSync(schemaEntry, "utf8")).title,
    "Kerkerker plugin job event v1"
  );
  assert.equal(
    JSON.parse(readFileSync(fixtureEntry, "utf8")).schema,
    contract.PLUGIN_JOB_EVENT_SCHEMA
  );
  assert.equal(
    JSON.parse(readFileSync(invalidFixtureEntry, "utf8")).metadata.actor,
    "system/refresh\ufeff"
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
