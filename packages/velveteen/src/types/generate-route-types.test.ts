import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateRouteTypes } from "./generate-route-types.ts";
import { buildRouteManifest } from "../routing/index.ts";

async function fixture() {
  const parent = join(import.meta.dir, "../../.velveteen/types");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "generation-"));
  const routes = join(root, "routes");
  const output = join(root, "types");
  await mkdir(join(routes, "blog/[slug]"), { recursive: true });
  await Bun.write(
    join(routes, "blog/[slug]/+page.ts"),
    "export const load = () => ({title: 'hello'});",
  );
  return { root, routes, output, manifest: await buildRouteManifest(routes) };
}

test("generated declarations are deterministic and retain application-owned output", async () => {
  const { root, output, manifest } = await fixture();
  try {
    const first = await generateRouteTypes(manifest, {
      outputDirectory: output,
    });
    const before = await Promise.all(
      first.files.map((file) => Bun.file(file).text()),
    );
    await Bun.write(
      join(output, "unrelated.d.ts"),
      "export type Unrelated = true;\n",
    );
    const second = await generateRouteTypes(manifest, {
      outputDirectory: output,
    });
    expect(second.files).toEqual(first.files);
    expect(
      await Promise.all(second.files.map((file) => Bun.file(file).text())),
    ).toEqual(before);
    expect(await Bun.file(join(output, "unrelated.d.ts")).text()).toBe(
      "export type Unrelated = true;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation rejects path escapes and owned-path collisions before replacing files", async () => {
  const { root, routes, output, manifest } = await fixture();
  try {
    expect(
      await throwingRejectionOf(
        generateRouteTypes(manifest, { outputDirectory: routes }),
      ),
    ).toThrow("must not contain");
    const invalid = structuredClone(manifest);
    invalid.nodes[0].directory = "../escape";
    expect(
      await throwingRejectionOf(
        generateRouteTypes(invalid, { outputDirectory: output }),
      ),
    ).toThrow("Invalid route directory");
    expect(await Bun.file(join(root, "escape/$types.d.ts")).exists()).toBe(
      false,
    );
    await mkdir(output);
    await Bun.write(join(output, "index.d.ts"), "export type Mine = true;\n");
    expect(
      await throwingRejectionOf(
        generateRouteTypes(manifest, { outputDirectory: output }),
      ),
    ).toThrow("application-owned file");
    expect(await Bun.file(join(output, "index.d.ts")).text()).toBe(
      "export type Mine = true;\n",
    );
    expect(await Bun.file(join(output, "$types.d.ts")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
