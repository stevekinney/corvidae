import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProduction } from "../../src/build/index.ts";
import { readProductionGeneration } from "../../src/build/publication.ts";
import { normalizeBasePath } from "../../src/build/paths.ts";
import { createApplication, fetchAssetSource } from "../../src/server/index.ts";
import { writeProductionFixture } from "./production-fixture.ts";

const buildRoot = join(process.cwd(), ".velveteen/build");

const assertNoTemporaryOutputs = async (outputDirectory: string) => {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  expect(
    entries.filter(
      (entry) =>
        entry.name.startsWith(".stage-") ||
        entry.name.startsWith(".velveteen-graph-"),
    ),
  ).toEqual([]);
};

const hashes = async (
  generation: Awaited<ReturnType<typeof readProductionGeneration>>,
) =>
  Object.fromEntries(
    await Promise.all(
      generation.manifest.outputs.map(async (output) => [
        output.file,
        await Bun.file(join(generation.directory, output.file)).arrayBuffer(),
      ]),
    ),
  );

test("D05: build output exports a manifest and server registry for host-owned runtime assets", async () => {
  await mkdir(buildRoot, { recursive: true });
  const root = await mkdtemp(join(buildRoot, "build-host-inputs-"));
  try {
    const fixture = await writeProductionFixture(root);
    const buildInputs: Array<{ browser: string[]; server: string[] }> = [];
    const generation = await buildProduction({
      projectDirectory: root,
      routesDirectory: fixture.routesDirectory,
      staticDirectory: fixture.staticDirectory,
      outputDirectory: join(root, "application"),
      basePath: "/app",
      onBuildMetadata({ browser, server }) {
        buildInputs.push({
          browser: Object.keys(browser.inputs),
          server: Object.keys(server.inputs),
        });
      },
    });
    expect(buildInputs).toHaveLength(1);
    expect(buildInputs[0]?.browser).toEqual(
      expect.arrayContaining([expect.stringContaining("+page.svelte")]),
    );
    expect(buildInputs[0]?.server).toEqual(
      expect.arrayContaining([expect.stringContaining("+page.server.ts")]),
    );
    const manifestModule = await import(
      pathToFileURL(join(generation.directory, "velveteen-manifest.js")).href
    );
    const registryModule = await import(
      pathToFileURL(join(generation.directory, "velveteen-registry.js")).href
    );
    expect(manifestModule.manifest).toEqual(generation.manifest);
    const application = await createApplication({
      generation: {
        directory: join(root, "missing-generation"),
        manifest: manifestModule.manifest,
      },
      registry: registryModule.registry as never,
      assets: fetchAssetSource({
        fetch: () => new Response("host asset"),
      }),
    });
    try {
      const response = await application.fetch(
        new Request("https://example.test/app/"),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("First: 0");
    } finally {
      await application.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D05: failed syntax and warning rebuilds preserve the published generation", async () => {
  await mkdir(buildRoot, { recursive: true });
  const root = await mkdtemp(join(buildRoot, "build-integration-"));
  const outputDirectory = join(root, "application");
  try {
    const fixture = await writeProductionFixture(root);
    await buildProduction({
      projectDirectory: root,
      routesDirectory: fixture.routesDirectory,
      staticDirectory: fixture.staticDirectory,
      outputDirectory,
      basePath: "/app",
    });
    const firstCurrent = await readProductionGeneration(outputDirectory);
    const firstHashes = await hashes(firstCurrent);
    const firstPointer = await Bun.file(
      join(outputDirectory, "current.json"),
    ).text();
    const originalRegistry = await import(
      pathToFileURL(
        join(firstCurrent.directory, firstCurrent.manifest.server.file),
      ).href
    );
    const rootRoute = firstCurrent.manifest.routing.routes.find(
      (route) => route.id === "/",
    )!;
    const renderOriginal = async () => {
      const component = await originalRegistry.nodes[rootRoute.leaf!].page();
      return (await originalRegistry.render(component.default)).body;
    };
    expect(await renderOriginal()).toContain("First: 0");

    await Bun.write(
      join(fixture.routesDirectory, "+page.svelte"),
      "<script>const broken = ;</script><h1>broken</h1>",
    );
    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          routesDirectory: fixture.routesDirectory,
          staticDirectory: fixture.staticDirectory,
          outputDirectory,
          basePath: "/app",
        }),
      ),
    ).toThrow();
    expect(await Bun.file(join(outputDirectory, "current.json")).text()).toBe(
      firstPointer,
    );
    const afterSyntaxError = await readProductionGeneration(outputDirectory);
    expect(afterSyntaxError.directory).toBe(firstCurrent.directory);
    expect(await hashes(afterSyntaxError)).toEqual(firstHashes);
    expect(await renderOriginal()).toContain("First: 0");
    await assertNoTemporaryOutputs(outputDirectory);

    await Bun.write(
      join(fixture.routesDirectory, "+page.svelte"),
      "<script>let value = 1;</script><h1>{value}</h1><style>.unused { color: red; }</style>",
    );
    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          routesDirectory: fixture.routesDirectory,
          staticDirectory: fixture.staticDirectory,
          outputDirectory,
          basePath: "/app",
        }),
      ),
    ).toThrow();
    expect(await Bun.file(join(outputDirectory, "current.json")).text()).toBe(
      firstPointer,
    );
    const afterWarning = await readProductionGeneration(outputDirectory);
    expect(afterWarning.directory).toBe(firstCurrent.directory);
    expect(await hashes(afterWarning)).toEqual(firstHashes);
    expect(await renderOriginal()).toContain("First: 0");
    await assertNoTemporaryOutputs(outputDirectory);

    await Bun.write(
      join(fixture.routesDirectory, "+page.svelte"),
      "<h1>Changed route</h1>",
    );
    const second = await buildProduction({
      projectDirectory: root,
      routesDirectory: fixture.routesDirectory,
      staticDirectory: fixture.staticDirectory,
      outputDirectory,
      basePath: "/app",
    });
    const secondCurrent = await readProductionGeneration(outputDirectory);
    expect(secondCurrent.directory).toBe(second.directory);
    expect(secondCurrent.directory).not.toBe(firstCurrent.directory);
    expect(await hashes(firstCurrent)).toEqual(firstHashes);
    expect(await hashes(secondCurrent)).not.toEqual(firstHashes);
    expect(await renderOriginal()).toContain("First: 0");
    await assertNoTemporaryOutputs(outputDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D05: production graph rejects unsafe static inputs and base paths", async () => {
  await mkdir(buildRoot, { recursive: true });
  const root = await mkdtemp(join(buildRoot, "build-safety-"));
  try {
    const fixture = await writeProductionFixture(root);
    const collision = join(fixture.staticDirectory, "_assets");
    await mkdir(collision);
    await Bun.write(join(collision, "collision.js"), "collision");
    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          routesDirectory: fixture.routesDirectory,
          staticDirectory: fixture.staticDirectory,
          outputDirectory: join(root, "output-collision"),
          basePath: "/app",
        }),
      ),
    ).toThrow("_assets namespace");
    expect(await Bun.file(join(collision, "collision.js")).text()).toBe(
      "collision",
    );

    await rm(collision, { recursive: true, force: true });
    const symlinkTarget = await mkdtemp(join(buildRoot, "static-target-"));
    const symlinkPath = join(fixture.staticDirectory, "linked.txt");
    await Bun.write(join(symlinkTarget, "target.txt"), "target");
    await symlink(join(symlinkTarget, "target.txt"), symlinkPath);
    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          routesDirectory: fixture.routesDirectory,
          staticDirectory: fixture.staticDirectory,
          outputDirectory: join(root, "output-symlink"),
          basePath: "/app",
        }),
      ),
    ).toThrow("Static symlink");
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(join(symlinkTarget, "target.txt")).text()).toBe(
      "target",
    );
    await rm(symlinkPath, { force: true });
    await rm(symlinkTarget, { recursive: true, force: true });

    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          routesDirectory: fixture.routesDirectory,
          staticDirectory: fixture.staticDirectory,
          outputDirectory: join(root, "output-invalid-base"),
          basePath: "/bad path",
        }),
      ),
    ).toThrow("Invalid production base path");

    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          routesDirectory: fixture.routesDirectory,
          staticDirectory: fixture.staticDirectory,
          outputDirectory: join(fixture.staticDirectory, "output", "nested"),
          basePath: "/app",
        }),
      ),
    ).toThrow("must not contain one another");
    const alias = join(root, "source-alias");
    await symlink(fixture.routesDirectory, alias);
    const before = await readdir(fixture.routesDirectory);
    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          ...fixture,
          outputDirectory: join(alias, "generated"),
        }),
      ),
    ).toThrow("must not contain one another");
    expect(await readdir(fixture.routesDirectory)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D03: deployment bases accept only canonical unreserved path segments", () => {
  for (const input of [undefined, "", "/"])
    expect(normalizeBasePath(input)).toBe("");
  expect(normalizeBasePath("/app/")).toBe("/app");
  expect(normalizeBasePath("/one/two")).toBe("/one/two");
  for (const input of [
    "app",
    "//app",
    "/app//next",
    "/app/../next",
    "/app?x",
    "/app#x",
    "/app%20",
    "/app\\x",
  ])
    expect(() => normalizeBasePath(input)).toThrow(
      "Invalid production base path",
    );
});
