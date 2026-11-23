import {
  rejectionOf,
  throwingRejectionOf,
} from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import {
  assertPrerenderable,
  resolvePageOptions,
} from "../../src/server/page-options.ts";
import type { ClientRouteEntry } from "../../src/routing/manifest-types.ts";

const route: ClientRouteEntry = {
  id: "/",
  pattern: "^/$",
  params: [],
  node: 0,
  leaf: 0,
  ancestors: [0],
  layouts: [null],
  errors: [null],
};
const registry = (
  server: Record<string, unknown>,
  universal: Record<string, unknown> = {},
) => ({
  nodes: [
    { pageServer: async () => server, pageUniversal: async () => universal },
  ],
  manifest: { version: 1 as const, nodes: [], routes: [] },
});

test("invalid static route options fail at the emitted-module boundary", async () => {
  expect(
    await throwingRejectionOf(
      resolvePageOptions(registry({}, { trailingSlash: "sometimes" }), route),
    ),
  ).toThrow("trailingSlash");
  expect(
    await throwingRejectionOf(
      resolvePageOptions(registry({}, { prerender: "yes" }), route),
    ),
  ).toThrow("prerender");
});

test("actions are rejected before a route can publish static output", async () => {
  expect(
    await throwingRejectionOf(
      assertPrerenderable(
        registry({ actions: { default: () => ({}) } }),
        route,
      ),
    ),
  ).toThrow("cannot define actions");
});

import { join } from "node:path";
import { mkdir, rm, symlink } from "node:fs/promises";
import { prerender } from "../../src/prerender/index.ts";
import { staticFixture } from "../prerender/fixture.ts";

test("L: matcher imports obey the emitted browser graph boundary", async () => {
  const fixture = await staticFixture({
    "src/private.server.ts":
      "export const accepted = 'private-matcher-sentinel';",
    "src/params.ts":
      "import { accepted } from './private.server.ts'; export const params = { named: (value: string) => value === accepted ? value : undefined };",
    "routes/items/[id=named]/+page.svelte": "<h1>Matched</h1>",
  });
  try {
    expect(await rejectionOf(fixture.build())).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            /Server-only module.*private\.server\.ts/,
          ),
        }),
      ]),
    });
  } finally {
    await fixture.dispose();
  }
});

test("Q: application transport imports obey the emitted browser graph boundary", async () => {
  const fixture = await staticFixture({
    "src/private.server.ts": "export const secret = 'private-transport';",
    "src/transport.ts":
      "import {secret} from './private.server.ts'; export const transport = { Token: { encode: () => false, decode: () => secret } };",
  });
  try {
    expect(await rejectionOf(fixture.build())).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            /Server-only module.*private\.server\.ts/,
          ),
        }),
      ]),
    });
  } finally {
    await fixture.dispose();
  }
});

test("H02: actual render, entries, options, action, cookie and path failures preserve the last published artifact", async () => {
  const fixture = await staticFixture({});
  try {
    const accepted = await prerender({
      generation: await fixture.build(),
      outputDirectory: fixture.outputDirectory,
    });
    const pointer = await Bun.file(
      join(fixture.outputDirectory, "current.json"),
    ).text();
    const body = await Bun.file(
      join(accepted.directory, "docs/index.html"),
    ).text();
    for (const [source, diagnostic] of [
      ['export const load=()=>{throw new Error("private");};', "returned 500"],
      ["export const actions={default:()=>({})};", "cannot define actions"],
      ['export const prerender="invalid";', "prerender"],
      [
        'export const load=({cookies})=>{cookies.set("session","private",{path:"/"});return {};};',
        "cannot publish cookies",
      ],
    ]) {
      await fixture.write({ "routes/+page.server.ts": source });
      const generation = await fixture.build();
      expect(
        await throwingRejectionOf(
          prerender({ generation, outputDirectory: fixture.outputDirectory }),
        ),
      ).toThrow(diagnostic);
      expect(
        await Bun.file(join(fixture.outputDirectory, "current.json")).text(),
      ).toBe(pointer);
      expect(
        await Bun.file(join(accepted.directory, "docs/index.html")).text(),
      ).toBe(body);
    }
    await fixture.write({
      "routes/+page.server.ts": "export const load=()=>({});",
      "routes/missing/[id]/+page.svelte": "<h1>Missing</h1>",
    });
    const generation = await fixture.build();
    expect(
      await throwingRejectionOf(
        prerender({ generation, outputDirectory: fixture.outputDirectory }),
      ),
    ).toThrow("missing prerender entry");
    for (const entry of [
      "/docs/../escape",
      "/docs/%2e%2e/escape",
      "/other",
      "/docs/?private=yes",
    ])
      expect(
        await throwingRejectionOf(
          prerender({
            generation,
            outputDirectory: fixture.outputDirectory,
            entries: [entry],
          }),
        ),
      ).toThrow();
    expect(
      await Bun.file(join(fixture.outputDirectory, "current.json")).text(),
    ).toBe(pointer);
  } finally {
    await fixture.dispose();
  }
});
test("H02: missing public assets, collisions and symlinked publication directories fail loudly", async () => {
  const fixture = await staticFixture({});
  try {
    const generation = await fixture.build();
    const accepted = await prerender({
      generation,
      outputDirectory: fixture.outputDirectory,
    });
    const pointer = await Bun.file(
      join(fixture.outputDirectory, "current.json"),
    ).text();
    const asset = generation.manifest.assets.find(
      (asset) => asset.target === "static",
    )!;
    await rm(join(generation.directory, asset.file));
    expect(
      await throwingRejectionOf(
        prerender({ generation, outputDirectory: fixture.outputDirectory }),
      ),
    ).toThrow();
    expect(
      await Bun.file(join(fixture.outputDirectory, "current.json")).text(),
    ).toBe(pointer);
    expect(
      await Bun.file(join(accepted.directory, "docs/public.txt")).text(),
    ).toBe("Public A");
    await fixture.write({ "static/index.html": "Conflicting static file" });
    const collision = await fixture.build();
    expect(
      await throwingRejectionOf(
        prerender({
          generation: collision,
          outputDirectory: fixture.outputDirectory,
        }),
      ),
    ).toThrow("collision");
    await rm(join(fixture.root, "static/index.html"));
    const clean = await fixture.build();
    const unsafe = join(fixture.root, "unsafe"),
      outside = join(fixture.root, "outside");
    await mkdir(unsafe);
    await mkdir(outside);
    await symlink(outside, join(unsafe, "generations"));
    expect(
      await throwingRejectionOf(
        prerender({ generation: clean, outputDirectory: unsafe }),
      ),
    ).toThrow("real directory");
  } finally {
    await fixture.dispose();
  }
});
