import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProduction } from "../../src/build/index.ts";
import { readProductionGeneration } from "../../src/build/publication.ts";
import { createApplication } from "../../src/server/index.ts";
import { buildRouteManifest } from "../../src/routing/index.ts";
import { buildProductionGraph } from "../../src/build/graph.ts";
import { writeProductionFixture } from "./production-fixture.ts";

test("external production output renders a context-using route", async () => {
  const parent = join(process.cwd(), ".velveteen/build");
  await mkdir(parent, { recursive: true });
  const project = await mkdtemp(join(parent, "context-project-"));
  const outside = await mkdtemp(join(tmpdir(), "velveteen-context-"));
  try {
    const fixture = await writeProductionFixture(project);
    await Bun.write(
      join(fixture.routesDirectory, "+page.svelte"),
      `<script>import { setContext, getContext } from 'svelte'; setContext('message', 'context rendered'); const message = getContext('message');</script><h1>{message}</h1>`,
    );
    const outputDirectory = join(outside, "output");
    for (let directory = outside; ; directory = dirname(directory)) {
      expect(
        await Bun.file(join(directory, "node_modules/svelte/package.json")).exists(),
      ).toBe(false);
      if (dirname(directory) === directory) break;
    }
    await Promise.all(
      [outputDirectory, join(outside, "other")].map((destination) =>
        buildProduction({
          projectDirectory: project,
          routesDirectory: fixture.routesDirectory,
          outputDirectory: destination,
        }),
      ),
    );
    const generation = await readProductionGeneration(outputDirectory);
    const application = await createApplication({ generation });
    try {
      const response = await application.fetch(
        new Request("https://example.test/"),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("context rendered");
    } finally {
      await application.dispose();
    }
    expect(
      (await readdir(project)).filter((name) => name.startsWith(".velveteen-graph-")),
    ).toEqual([]);
    await Bun.write(
      join(fixture.routesDirectory, "+page.svelte"),
      "<script>const broken = ;</script>",
    );
    await expect(
      buildProduction({
        projectDirectory: project,
        routesDirectory: fixture.routesDirectory,
        outputDirectory,
      }),
    ).rejects.toThrow();
    expect(
      (await readdir(project)).filter((name) => name.startsWith(".velveteen-graph-")),
    ).toEqual([]);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("D02/D04: emitted role graphs preserve route CSS, lazy modules and the browser boundary", async () => {
  const parent = join(process.cwd(), ".velveteen/build");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "graph-test-"));
  try {
    const fixture = await writeProductionFixture(root);
    await Bun.write(
      join(fixture.routesDirectory, "+layout.ts"),
      "export const load = () => ({ layout: true });",
    );
    await Bun.write(
      join(fixture.routesDirectory, "+layout.server.ts"),
      "export const load = () => ({ server: true });",
    );
    await Bun.write(
      join(fixture.routesDirectory, "+error.svelte"),
      "<h1>Error boundary</h1>",
    );
    await Bun.write(
      join(fixture.routesDirectory, "second/+page.ts"),
      "export const load = () => ({ page: true });",
    );
    const routing = await buildRouteManifest(fixture.routesDirectory);
    const stagingDirectory = join(root, "stage");
    const { manifest, metadata } = await buildProductionGraph({
      projectDirectory: root,
      manifest: routing,
      stagingDirectory,
      staticDirectory: fixture.staticDirectory,
      basePath: "/app/",
    });
    expect(manifest.basePath).toBe("/app");
    expect(manifest.routing.nodes).toHaveLength(routing.nodes.length);
    expect(JSON.stringify(manifest.routing)).not.toContain(root);
    expect(JSON.stringify(manifest.client)).not.toContain("pageServer");
    expect(JSON.stringify(manifest.client)).not.toContain("layoutServer");
    expect(JSON.stringify(manifest.client)).not.toContain("endpoint");
    expect(
      manifest.assets.some((asset) => asset.url === "/app/hello%20world.txt"),
    ).toBe(true);
    expect(manifest.assets.every((asset) => asset.target !== "server")).toBe(
      true,
    );
    expect(
      manifest.outputs.every((output) => !output.file.endsWith(".map")),
    ).toBe(true);
    for (const target of ["browser", "server"] as const) {
      const outputs = manifest.outputs.filter(
        (output) => output.target === target,
      );
      expect(outputs.some((output) => output.file.includes("/chunks/"))).toBe(
        true,
      );
      const emitted = new Set(
        outputs.map((output) => output.file.slice(target.length + 1)),
      );
      for (const path of Object.keys(metadata[target].outputs))
        expect(emitted.has(path.replace(/^\.\//, ""))).toBe(true);
      for (const output of outputs) {
        const bytes = await readFile(join(stagingDirectory, output.file));
        expect(bytes.length).toBe(output.bytes);
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
          output.sha256,
        );
        if (target === "browser") {
          expect(bytes.toString()).not.toContain("PRODUCTION_PRIVATE_SENTINEL");
          expect(bytes.toString()).not.toContain("PRODUCTION_DEV_SENTINEL");
          expect(bytes.toString()).not.toContain("sourceMappingURL");
          expect(bytes.toString()).not.toContain(root);
        }
      }
    }
    const rootRoute = routing.routes.find((route) => route.id === "/")!;
    const second = routing.routes.find((route) => route.id === "/second")!;
    const rootNode = manifest.client.nodes[String(rootRoute.leaf)];
    const secondNode = manifest.client.nodes[String(second.leaf)];
    const expectedSecondCss = new Set([
      ...rootNode.layout!.stylesheets,
      ...secondNode.page!.stylesheets,
    ]);
    expect(new Set(manifest.routes["/second"].stylesheets)).toEqual(
      expectedSecondCss,
    );
    expect(manifest.routes["/second"].stylesheets).not.toContain(
      rootNode.page!.stylesheets[0],
    );
    const secondCss = (
      await Promise.all(
        manifest.routes["/second"].stylesheets.map((url) => {
          const asset = manifest.assets.find((asset) => asset.url === url)!;
          return Bun.file(join(stagingDirectory, asset.file)).text();
        }),
      )
    ).join("\n");
    expect(secondCss).toContain("border-top");
    expect(secondCss).not.toContain("background-image");
    const server = await import(
      pathToFileURL(join(stagingDirectory, manifest.server.file)).href
    );
    expect(await server.nodes[rootRoute.node].pageServer()).toHaveProperty(
      "privateToken",
      "PRODUCTION_PRIVATE_SENTINEL",
    );
    expect(
      (await server.nodes[rootRoute.node].layoutUniversal()).load(),
    ).toEqual({ layout: true });
    expect((await server.nodes[rootRoute.node].layoutServer()).load()).toEqual({
      server: true,
    });
    expect((await server.nodes[second.node].pageUniversal()).load()).toEqual({
      page: true,
    });
    expect(
      (await server.nodes[rootRoute.node].endpoint()).GET(),
    ).toBeInstanceOf(Response);
    expect(await server.nodes[rootRoute.node].error()).toHaveProperty(
      "default",
    );
    expect(
      await Bun.file(join(stagingDirectory, "manifest.json")).json(),
    ).toEqual(manifest);
    expect(
      await Bun.file(join(stagingDirectory, "build-metadata.json")).json(),
    ).toEqual(metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
