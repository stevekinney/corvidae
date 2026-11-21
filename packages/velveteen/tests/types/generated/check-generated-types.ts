import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildRouteManifest } from "../../../src/routing/index.ts";
import { generateRouteTypes } from "../../../src/types/generate-route-types.ts";
import { consumerFixtures, invalidConsumers } from "./consumer-fixtures.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const run = async (command: string[]) => {
  const result = await runWithHangGuard([process.execPath, ...command], {
    cwd: repositoryRoot,
  });
  return {
    code: result.exitCode ?? 1,
    output: result.stdout.toString() + result.stderr.toString(),
  };
};
const write = async (path: string, content: string) => {
  await mkdir(resolve(path, ".."), { recursive: true });
  await Bun.write(path, content);
};
const temporaryParent = join(repositoryRoot, ".velveteen/types");
await mkdir(temporaryParent, { recursive: true });
const root = await mkdtemp(join(temporaryParent, "consumer-"));
const routes = join(root, "routes");
const output = join(root, "types");
const evidence: Array<{ phase: string; code: number; output: string }> = [];
try {
  for (const [file, content] of Object.entries(consumerFixtures))
    await write(join(routes, file), content);
  const matcherModule = join(root, "params.ts");
  await write(
    matcherModule,
    `export const params = {
    integer: (value: string) => /^\\d+$/.test(value) ? Number(value) : undefined,
    "large-id": (value: string) => /^\\d+$/.test(value) ? BigInt(value) : undefined,
    flag: (value: string) => value === "on" ? true : value === "off" ? false : undefined,
    "path-size": (value: string) => value === "" ? 0 : value.split("/").length,
  };`,
  );
  await write(
    join(output, "unrelated.d.ts"),
    "export type Unrelated = true;\n",
  );
  const regenerate = async () => {
    const manifest = await buildRouteManifest(routes, { matcherModule });
    return {
      ...(await generateRouteTypes(manifest, { outputDirectory: output })),
      manifest,
    };
  };
  const first = await regenerate();
  const tsc = () =>
    run([
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--project",
      first.configuration,
    ]);
  const check = () =>
    run([
      "node_modules/svelte-check/bin/svelte-check",
      "--workspace",
      routes,
      "--tsconfig",
      first.configuration,
      "--config",
      join(repositoryRoot, "svelte-check.config.ts"),
      "--fail-on-warnings",
    ]);
  const positive = async (phase: string) => {
    for (const [tool, result] of [
      ["tsc", await tsc()],
      ["svelte-check", await check()],
    ] as const) {
      evidence.push({ phase: `${phase} ${tool}`, ...result });
      assert(result.code === 0, `${phase} ${tool} failed:\n${result.output}`);
    }
  };
  await positive("initial consumers");
  assert(
    first.files.includes(join(output, "layout-only/$types.d.ts")),
    "Layout-only types missing",
  );
  for (const fixture of invalidConsumers) {
    const path = join(routes, fixture.file);
    await write(path, fixture.code);
    const result = await tsc();
    evidence.push({ phase: fixture.file, ...result });
    assert(
      result.code !== 0 &&
        result.output.includes(basename(fixture.file)) &&
        result.output.includes(fixture.diagnostic) &&
        result.output.includes(fixture.detail),
      `${fixture.file} did not fail for its intended type error:\n${result.output}`,
    );
    assert(
      (result.output.match(/error TS\d+:/g) ?? []).length === 1,
      `Unexpected extra diagnostics for ${fixture.file}:\n${result.output}`,
    );
    await rm(path);
  }
  const invalidSvelte = join(routes, "blog/[slug]/invalid.svelte");
  await write(
    invalidSvelte,
    `<script lang="ts">import type { PageProps } from './$types'; let { data }: PageProps = $props(); function needsNumber(value: number) { return value; }</script><p>{needsNumber(data.slug)}</p>`,
  );
  const svelteFailure = await check();
  evidence.push({ phase: "invalid Svelte PageProps", ...svelteFailure });
  assert(
    svelteFailure.code !== 0 &&
      svelteFailure.output.includes("invalid.svelte") &&
      svelteFailure.output.includes(
        "Argument of type 'string' is not assignable to parameter of type 'number'",
      ),
    `Svelte negative consumer did not fail causally:\n${svelteFailure.output}`,
  );
  await rm(invalidSvelte);
  await positive("restored consumers");

  const resetDeclaration = join(output, "reset/leaf/$types.d.ts");
  const beforeResetRename = await readFile(resetDeclaration, "utf8");
  await rename(
    join(routes, "reset/leaf/+page@.svelte"),
    join(routes, "reset/leaf/+page.svelte"),
  );
  const afterResetRename = await regenerate();
  const restoredRoute = afterResetRename.manifest.routes.find(
    (route) => route.id === "/reset/leaf",
  );
  assert(
    restoredRoute?.layouts.some(
      (index) =>
        index !== null &&
        afterResetRename.manifest.nodes[index].id === "/reset",
    ),
    "Renaming the reset did not restore the skipped layout branch",
  );
  assert(
    afterResetRename.files.filter((file) => file === resetDeclaration)
      .length === 1 &&
      (await readFile(resetDeclaration, "utf8")) !== beforeResetRename,
    "Renaming the reset did not replace its generated declaration",
  );
  await write(
    join(routes, "reset/leaf/assert-restored.ts"),
    `import type { PageData } from './$types'; export const restored: PageData['skipped'] = 'skipped'; export const local: PageData['local'] = 'local';`,
  );
  await positive("reset rename restores ordinary inheritance");

  // Compiler checks after each structural change also expose stale imports/declarations.
  await write(
    join(routes, "new/+page.ts"),
    "export const load = () => ({created: true});",
  );
  const added = await regenerate();
  assert(
    added.files.includes(join(output, "new/$types.d.ts")),
    "Created types missing",
  );
  await positive("create");
  await rename(join(routes, "new"), join(routes, "renamed"));
  const renamed = await regenerate();
  assert(
    renamed.removed.includes(join(output, "new/$types.d.ts")) &&
      !(await Bun.file(join(output, "new/$types.d.ts")).exists()),
    "Stale renamed types survive",
  );
  assert(
    renamed.files.includes(join(output, "renamed/$types.d.ts")),
    "Renamed types missing",
  );
  await positive("rename");
  await rm(join(routes, "renamed"), { recursive: true });
  const deleted = await regenerate();
  assert(
    deleted.removed.includes(join(output, "renamed/$types.d.ts")) &&
      !(await Bun.file(join(output, "renamed/$types.d.ts")).exists()),
    "Deleted types survive",
  );
  assert(
    (await readFile(join(output, "unrelated.d.ts"), "utf8")) ===
      "export type Unrelated = true;\n",
    "Application-owned output changed",
  );
  await positive("delete");
  await Bun.write(
    join(repositoryRoot, ".velveteen/evidence/c05-generated-consumers.json"),
    JSON.stringify(
      {
        bun: Bun.version,
        typescript: "6.0.3",
        strict: true,
        skipLibCheck: false,
        evidence,
      },
      null,
      2,
    ),
  );
  console.log(
    `C05 generated consumers passed: ${evidence.length} actual compiler/checker executions, including ${invalidConsumers.length + 1} causal negative controls`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
