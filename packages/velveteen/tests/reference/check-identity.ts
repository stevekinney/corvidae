import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCleanSource } from "./source-identity.ts";

const commit = "a58e0a92c35dbeee161e96c733464dc7397e073a";
assertCleanSource(resolve(import.meta.dirname, "upstream"), commit);
const checkout = resolve(import.meta.dirname, "upstream/packages/kit");
const artifact = resolve(import.meta.dirname, "node_modules/@sveltejs/kit");
const list = Bun.spawnSync([
  "git",
  "-C",
  resolve(import.meta.dirname, "upstream"),
  "ls-files",
  "-z",
  "packages/kit/src",
  "packages/kit/svelte-kit.js",
  "packages/kit/package.json",
]);
if (list.exitCode !== 0) throw new Error(list.stderr.toString());
const files = list.stdout
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter((file) => !/(^|\/)(test|tests|fixtures)(\/)|\.spec\./.test(file))
  .map((file) => file.replace("packages/kit/", ""));
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const mismatches: string[] = [];
const sourceDigests: string[] = [];
for (const file of files) {
  const source = resolve(checkout, file);
  const installed = resolve(artifact, file);
  try {
    const sourceDigest = await digest(source);
    sourceDigests.push(`${file}:${sourceDigest}`);
    if (sourceDigest !== (await digest(installed))) mismatches.push(file);
  } catch {
    mismatches.push(`${file} (missing from installed package)`);
  }
}
if (mismatches.length > 0)
  throw new Error(
    `installed @sveltejs/kit@3.3.0 differs from pinned commit ${commit}: ${mismatches.slice(0, 10).join(", ")}`,
  );
await Bun.write(
  resolve(import.meta.dirname, "identity-digest.json"),
  JSON.stringify(
    {
      package: "@sveltejs/kit@3.3.0",
      commit,
      files: files.length,
      digest: createHash("sha256")
        .update(sourceDigests.join("\n"))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `reference identity passed: @sveltejs/kit@3.3.0 matches ${files.length} pinned source files at ${commit}`,
);
