import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readVelveteenTestEnvironment } from "../environment-configuration.ts";
import { assertCleanSource } from "../reference/source-identity.ts";
import {
  classifyScript,
  classifyTestFile,
  type PackageScript,
  type TestFileEntry,
} from "./classify.ts";

const allowedOwners = new Set(["A", "B", "C", "D", "E", "F", "G", "H"]);

const {
  referenceKit,
  inventoryAlterOwner: alterOwner,
  inventoryRemoveOwner: removeOwner,
  inventoryRemoveEntry: removeEntry,
  inventoryRemoveScript: removeScript,
  inventoryAlterScript: alterScript,
  inventoryControls,
} = readVelveteenTestEnvironment();
const sourceRoot =
  referenceKit ?? resolve(import.meta.dirname, "../reference/upstream");
const ledger = JSON.parse(
  await readFile(resolve("tests/inventory/ledger.json"), "utf8"),
) as {
  source: { commit: string };
  testFiles: TestFileEntry[];
  packageScripts: PackageScript[];
  trackedTestFileCount: number;
  trackedTestFileListSha256: string;
};
if (alterOwner) ledger.testFiles[0].owner = "unknown";
if (removeOwner) ledger.packageScripts[0].owner = "";
for (const entry of [...ledger.testFiles, ...ledger.packageScripts])
  if (!allowedOwners.has(entry.owner))
    throw new Error("unknown or missing feature owner");
assertCleanSource(sourceRoot, ledger.source.commit);
const head = await runWithHangGuard([
  "git",
  "-C",
  sourceRoot,
  "rev-parse",
  "HEAD",
]);
if (
  head.exitCode !== 0 ||
  head.stdout.toString().trim() !== ledger.source.commit
) {
  throw new Error(
    `reference checkout is not at pinned commit ${ledger.source.commit}`,
  );
}
const processResult = await runWithHangGuard([
  "git",
  "-C",
  sourceRoot,
  "ls-files",
  "-z",
  "--",
  "*test*",
  "*spec*",
]);
if (processResult.exitCode !== 0) {
  throw new Error(
    "reference source checkout is unavailable; set VELVETEEN_REFERENCE_KIT",
  );
}
const files = processResult.stdout
  .toString()
  .split("\0")
  .filter((file) =>
    /(^|\/)(test|tests|spec|__tests__)(\/)|\.(test|spec)\./.test(file),
  )
  .toSorted();
if (removeEntry) files.splice(files.indexOf(removeEntry), 1);
if (ledger.trackedTestFileCount !== files.length) {
  throw new Error(
    `inventory count changed: expected ${ledger.trackedTestFileCount}, got ${files.length}`,
  );
}
const ledgerPaths = ledger.testFiles.map(({ path }) => path).toSorted();
if (
  ledgerPaths.length !== files.length ||
  ledgerPaths.some((file, index) => file !== files[index])
) {
  throw new Error(
    "inventory ledger is incomplete or stale: regenerate it deliberately",
  );
}
const digest = createHash("sha256").update(files.join("\n")).digest("hex");
if (digest !== ledger.trackedTestFileListSha256) {
  throw new Error(
    `inventory digest changed: expected ${ledger.trackedTestFileListSha256}, got ${digest}`,
  );
}
const packageResult = await runWithHangGuard([
  "git",
  "-C",
  sourceRoot,
  "ls-files",
  "-z",
  "--",
  "**/package.json",
  "package.json",
]);
if (packageResult.exitCode !== 0)
  throw new Error("could not enumerate package manifests");
const actualScripts: PackageScript[] = [];
for (const path of packageResult.stdout
  .toString()
  .split("\0")
  .filter(Boolean)
  .toSorted()) {
  const manifest = JSON.parse(
    await readFile(resolve(sourceRoot, path), "utf8"),
  ) as { scripts?: Record<string, string> };
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!/(^|:)(test|check|lint|format)(:|$)/.test(name)) continue;
    actualScripts.push(classifyScript(path, name, command));
  }
}
const actualFiles = await Promise.all(
  files.map((path) => classifyTestFile(sourceRoot, path, actualScripts)),
);
for (const entry of actualFiles)
  if (!allowedOwners.has(entry.owner) || entry.owner === "batch-ledger")
    throw new Error(`unknown feature owner for ${entry.path}: ${entry.owner}`);
const expectedFiles = [...ledger.testFiles].toSorted((a, b) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
);
if (expectedFiles.length !== actualFiles.length)
  throw new Error("test-file ledger entry count differs from source");
for (const [index, actual] of actualFiles.entries()) {
  const expected = expectedFiles[index];
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error(`test-file ledger metadata differs for ${actual.path}`);
}
const observedScripts = actualScripts
  .filter((entry) => `${entry.package}:${entry.name}` !== removeScript)
  .map((entry) =>
    `${entry.package}:${entry.name}` === alterScript
      ? { ...entry, command: `${entry.command} altered` }
      : `${entry.package}:${entry.name}` === alterOwner
        ? { ...entry, owner: "unknown" }
        : entry,
  );
const expectedScripts = ledger.packageScripts.toSorted((a, b) =>
  `${a.package}:${a.name}`.localeCompare(`${b.package}:${b.name}`),
);
const observedSorted = observedScripts.toSorted((a, b) =>
  `${a.package}:${a.name}`.localeCompare(`${b.package}:${b.name}`),
);
if (JSON.stringify(expectedScripts) !== JSON.stringify(observedSorted))
  throw new Error(
    "package test/check script ledger is incomplete or differs from source manifests",
  );
if (!inventoryControls) {
  const controls = [
    {
      name: "remove-entry",
      variable: "VELVETEEN_INVENTORY_REMOVE_ENTRY",
      value: ledger.testFiles[0].path,
      diagnostic: "inventory count changed",
    },
    {
      name: "remove-script",
      variable: "VELVETEEN_INVENTORY_REMOVE_SCRIPT",
      value: `${ledger.packageScripts[0].package}:${ledger.packageScripts[0].name}`,
      diagnostic: "package test/check script ledger is incomplete",
    },
    {
      name: "alter-owner",
      variable: "VELVETEEN_INVENTORY_ALTER_OWNER",
      value: `${ledger.packageScripts[0].package}:${ledger.packageScripts[0].name}`,
      diagnostic: "unknown or missing feature owner",
    },
    {
      name: "remove-owner",
      variable: "VELVETEEN_INVENTORY_REMOVE_OWNER",
      value: "1",
      diagnostic: "unknown or missing feature owner",
    },
    {
      name: "alter-script",
      variable: "VELVETEEN_INVENTORY_ALTER_SCRIPT",
      value: `${ledger.packageScripts[0].package}:${ledger.packageScripts[0].name}`,
      diagnostic: "package test/check script ledger is incomplete",
    },
  ];
  for (const control of controls) {
    const result = await runWithHangGuard(
      [process.execPath, import.meta.path],
      {
        env: {
          ...process.env,
          VELVETEEN_INVENTORY_CONTROLS: "1",
          [control.variable]: control.value,
        },
      },
    );
    if (result.exitCode === 0)
      throw new Error(
        `inventory negative control unexpectedly passed: ${control.name}`,
      );
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    if (!output.includes(control.diagnostic))
      throw new Error(
        `inventory negative control had wrong failure: ${control.name}`,
      );
  }
}
console.log(
  `P01 inventory passed: ${files.length} tracked test files and ${ledger.packageScripts.length} package test/check scripts at ${ledger.source.commit}`,
);
