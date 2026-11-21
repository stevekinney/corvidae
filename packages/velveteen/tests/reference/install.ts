import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
import { cp, realpath, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { assertCleanSource } from "./source-identity.ts";

const upstream = resolve(import.meta.dirname, "upstream");
await assertCleanSource(upstream, "a58e0a92c35dbeee161e96c733464dc7397e073a");

const result = await runWithHangGuard(["bun", "install", "--frozen-lockfile"], {
  cwd: import.meta.dirname,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (!result.success) process.exit(result.exitCode ?? 1);
const installed = resolve(import.meta.dirname, "node_modules/@sveltejs/kit");
const pinned = resolve(import.meta.dirname, "upstream/packages/kit");
await rm(installed, { recursive: true, force: true });
await cp(pinned, installed, { recursive: true, verbatimSymlinks: true });

// Bun resolves imports from the checkout's physical path, outside the fixture tree.
const dependencyDirectory = resolve(import.meta.dirname, "node_modules");
const checkoutParent = dirname(await realpath(upstream));
const dependencyLink = resolve(checkoutParent, "node_modules");
try {
  await symlink(
    relative(checkoutParent, dependencyDirectory),
    dependencyLink,
    "dir",
  );
} catch (error) {
  if ((await realpath(dependencyLink)) !== dependencyDirectory) throw error;
}

await assertCleanSource(upstream, "a58e0a92c35dbeee161e96c733464dc7397e073a");
console.log("reference toolchain installed from tests/reference/package.json");
