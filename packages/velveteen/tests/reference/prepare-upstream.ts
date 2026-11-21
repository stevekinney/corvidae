import { access, mkdir, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { assertCleanSource } from "./source-identity.ts";

const commit = "a58e0a92c35dbeee161e96c733464dc7397e073a";
const checkoutLink = resolve(import.meta.dirname, "upstream");
const directory = resolve(
  import.meta.dirname,
  "../../.velveteen/reference/upstream",
);
await mkdir(dirname(directory), { recursive: true });
const repository = "https://github.com/sveltejs/kit.git";
try {
  await access(resolve(directory, ".git"));
} catch {
  const clone = Bun.spawnSync([
    "git",
    "clone",
    "--filter=blob:none",
    repository,
    directory,
  ]);
  if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
}
assertCleanSource(directory);
const fetch = Bun.spawnSync([
  "git",
  "-C",
  directory,
  "fetch",
  "--depth",
  "1",
  "origin",
  commit,
]);
if (fetch.exitCode !== 0) throw new Error(fetch.stderr.toString());
const checkout = Bun.spawnSync([
  "git",
  "-C",
  directory,
  "checkout",
  "--detach",
  commit,
]);
if (checkout.exitCode !== 0) throw new Error(checkout.stderr.toString());
const head = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"])
  .stdout.toString()
  .trim();
if (head !== commit)
  throw new Error(`prepared reference is ${head}, expected ${commit}`);
assertCleanSource(directory, commit);
try {
  await access(checkoutLink);
} catch {
  await symlink(relative(import.meta.dirname, directory), checkoutLink, "dir");
}
console.log(`prepared clean SvelteKit checkout at ${head}: ${directory}`);
