import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  classifyScript,
  classifyTestFile,
  type PackageScript,
} from "./classify.ts";

const sourceRoot =
  process.env.VELVETEEN_REFERENCE_KIT ??
  resolve(import.meta.dirname, "../reference/upstream");
const run = (args: string[]) => {
  const result = Bun.spawnSync(args);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};
const commit = run(["git", "-C", sourceRoot, "rev-parse", "HEAD"]).trim();
const tracked = run([
  "git",
  "-C",
  sourceRoot,
  "ls-files",
  "-z",
  "--",
  "*test*",
  "*spec*",
])
  .split("\0")
  .filter((file) =>
    /(^|\/)(test|tests|spec|__tests__)(\/)|\.(test|spec)\./.test(file),
  )
  .sort();
const packagePaths = run([
  "git",
  "-C",
  sourceRoot,
  "ls-files",
  "-z",
  "--",
  "**/package.json",
  "package.json",
])
  .split("\0")
  .filter(Boolean)
  .sort();
const scripts: PackageScript[] = [];
for (const path of packagePaths) {
  const manifest = JSON.parse(
    await readFile(resolve(sourceRoot, path), "utf8"),
  ) as { scripts?: Record<string, string> };
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!/(^|:)(test|check|lint|format)(:|$)/.test(name)) continue;
    scripts.push(classifyScript(path, name, command));
  }
}
const files = await Promise.all(
  tracked.map((path) => classifyTestFile(sourceRoot, path, scripts)),
);
const listDigest = createHash("sha256")
  .update(tracked.join("\n"))
  .digest("hex");
await mkdir(resolve("tests/inventory"), { recursive: true });
await writeFile(
  resolve("tests/inventory/ledger.json"),
  JSON.stringify(
    {
      source: {
        repository: "sveltejs/kit",
        commit,
        package: "@sveltejs/kit@3.3.0",
      },
      trackedTestFileCount: files.length,
      trackedTestFileListSha256: listDigest,
      testFiles: files,
      packageScripts: scripts,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `wrote ${files.length} test-file entries and ${scripts.length} package-script entries at ${commit}`,
);
