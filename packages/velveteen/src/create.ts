import { mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const frameworkDirectory = resolve(import.meta.dir, "..");
const packageName = "@lostgradient/velveteen";

const files: Record<string, string> = {
  "package.json":
    JSON.stringify(
      {
        name: "velveteen-app",
        private: true,
        type: "module",
        scripts: {
          sync: "bun src/sync.ts",
          check:
            "bun run sync && tsc --noEmit && svelte-check --workspace src --tsconfig ../tsconfig.json --fail-on-warnings",
          dev: "bun src/server.ts --mode development",
          build: "bun src/server.ts --mode production --build-only",
          start: "bun src/server.ts --mode production --start",
        },
        dependencies: {
          [packageName]: "file:.velveteen/velveteen.tgz",
          svelte: "5.57.1",
        },
        devDependencies: {
          "@types/bun": "1.4.4",
          "@types/node": "26.6.6",
          "svelte-check": "4.7.8",
          typescript: "6.0.3",
        },
      },
      null,
      2,
    ) + "\n",
  "tsconfig.json":
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "Bundler",
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          types: ["bun"],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          isolatedModules: true,
          verbatimModuleSyntax: true,
          allowImportingTsExtensions: true,
          rootDirs: ["src/routes", ".velveteen/types"],
        },
        include: [
          "src/**/*.ts",
          "src/**/*.svelte",
          ".velveteen/types/**/*.d.ts",
        ],
      },
      null,
      2,
    ) + "\n",
  "src/routes/+page.svelte": `<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  let count = $state(0);
</script>

<svelte:head>
  <title>Velveteen starter</title>
</svelte:head>

<main>
  <h1>Welcome to Velveteen</h1>
  <p>{data.message}</p>
  <button onclick={() => (count += 1)}>Count: {count}</button>
</main>

<style>
  main { max-width: 42rem; margin: 4rem auto; font-family: system-ui, sans-serif; }
  button { padding: 0.5rem 0.75rem; }
</style>
`,
  "src/routes/+page.ts": `import type { PageLoad } from "./$types";

export const load = (() => ({ message: "Your Bun-native Svelte app is ready." })) satisfies PageLoad;
`,
  "src/sync.ts": `import { join } from "node:path";
import { buildRouteManifest } from "${packageName}/routing";
import { generateRouteTypes } from "${packageName}/types";

const root = process.cwd();
const manifest = await buildRouteManifest(join(root, "src/routes"));
await generateRouteTypes(manifest, { outputDirectory: join(root, ".velveteen/types") });
`,
  "src/server.ts": `import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildProduction } from "${packageName}/build";
import { readProductionGeneration } from "${packageName}/build/publication";
import { createApplication } from "${packageName}/server";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string", default: "development" },
    "build-only": { type: "boolean", default: false },
    start: { type: "boolean", default: false },
  },
});
const mode = values.mode === "production" ? "production" : "development";
const root = process.cwd();
const outputDirectory = join(root, ".velveteen/production");
const build = async () => buildProduction({
  projectDirectory: root,
  routesDirectory: join(root, "src/routes"),
  outputDirectory,
  mode,
});

if (!values.start) await build();
if (values["build-only"]) process.exit(0);
const generation = await readProductionGeneration(outputDirectory);
const application = await createApplication({ generation });
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: application.fetch });
console.log(JSON.stringify({ url: server.url.href, mode }));
const shutdown = async () => { await server.stop(); await application.dispose(); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
`,
};

function packFramework(archive: string) {
  const result = Bun.spawnSync(
    [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive],
    { cwd: frameworkDirectory, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(`Unable to pack Velveteen:\n${result.stderr.toString()}`);
}

/** Generate a TypeScript starter with a local archive of the framework. */
export async function createProject(directory: string) {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  const resolvedValue = await readdir(target);
  if (resolvedValue.length)
    throw new Error(`Refusing to scaffold non-empty directory: ${target}`);
  const packageDirectory = join(target, ".velveteen");
  await mkdir(packageDirectory);
  const cleanup = [() => rmdir(packageDirectory)];
  try {
    const existingFiles = await readdir(target);
    if (existingFiles.some((entry) => entry !== ".velveteen"))
      throw new Error(`Refusing to scaffold non-empty directory: ${target}`);
    const archive = join(packageDirectory, "velveteen.tgz");
    cleanup.push(() => rm(archive, { force: true }));
    packFramework(archive);
    for (const path of ["src", "src/routes"]) {
      const destination = join(target, path);
      await mkdir(destination);
      cleanup.push(() => rmdir(destination));
    }
    for (const [path, content] of Object.entries(files)) {
      const destination = join(target, path);
      const file = await open(destination, "wx");
      cleanup.push(() => rm(destination, { force: true }));
      try {
        await file.writeFile(content);
      } finally {
        await file.close();
      }
    }
    console.info(`Created Velveteen app in ${target}`);
  } catch (error) {
    const failures: unknown[] = [];
    for (const remove of cleanup.toReversed()) {
      try {
        await remove();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Unable to scaffold and clean up Velveteen app",
        { cause: error },
      );
    throw error;
  }
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory || Bun.argv.length !== 3)
    throw new Error("Usage: bun run create <empty-directory>");
  await createProject(directory);
}
