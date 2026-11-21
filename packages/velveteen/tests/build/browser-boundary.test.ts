import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { createBrowserBoundary } from "../../src/build/browser-boundary.ts";
import { createSveltePlugin } from "../../src/compiler/index.ts";

const parent = join(import.meta.dir, "../../.velveteen/build");
test("D04: resolved browser boundary rejects private imports and preserves type-only/public inputs", async () => {
  await mkdir(parent, { recursive: true });
  const project = await mkdtemp(join(parent, "boundary-"));
  const sibling = await mkdtemp(join(parent, "sibling-"));
  const siblingName = basename(sibling);
  const routes = join(project, "routes");
  await mkdir(routes);
  await mkdir(join(project, "lib/server"), { recursive: true });
  const privateFile = join(project, "secrets.server.ts");
  const siblingPrivateFile = join(sibling, "private.server.ts");
  await Bun.write(
    privateFile,
    "export const secret = 'PRIVATE_BROWSER_SENTINEL'; export type Secret = string;",
  );
  await Bun.write(
    siblingPrivateFile,
    "export const secret = 'SIBLING_PRIVATE_BROWSER_SENTINEL';",
  );
  await Bun.write(
    join(sibling, "client.ts"),
    "export const clientValue = 'SIBLING_CLIENT_VALUE';",
  );
  await Bun.write(
    join(project, "lib/server/secret.ts"),
    "export const secret = 'DIRECTORY_PRIVATE_SENTINEL';",
  );
  await Bun.write(
    join(project, "barrel.ts"),
    "export { secret } from './secrets.server.ts'; export const publicValue = 42;",
  );
  await Bun.write(
    join(project, "intermediate.ts"),
    "export { secret } from './secrets.server.ts';",
  );
  await Bun.write(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { paths: { "#secret": ["./secrets.server.ts"] } },
    }),
  );
  await symlink(privateFile, join(project, "innocent.ts"));
  const entry = join(routes, "entry.ts");
  const build = () =>
    Bun.build({
      root: project,
      entrypoints: [entry],
      target: "browser",
      allowUnresolved: [],
      plugins: [
        createBrowserBoundary({
          projectDirectory: project,
          routesDirectory: routes,
        }),
        createSveltePlugin(),
      ],
      throw: false,
    });
  try {
    for (const sourceTemplate of [
      "export { secret } from '../secrets.server.ts';",
      "export { secret } from '../intermediate.ts';",
      "export const lazy = () => import('../secrets.server.ts');",
      "export { publicValue } from '../barrel.ts';",
      "export { secret } from '#secret';",
      "export { secret } from '../innocent.ts';",
      "export { secret } from '../lib/server/secret.ts';",
      "export { secret } from '../../sibling-placeholder/private.server.ts';",
    ]) {
      const source = sourceTemplate.replace(
        "../../sibling-placeholder",
        `../../${siblingName}`,
      );
      await Bun.write(entry, source);
      const result = await build();
      expect(result.success).toBe(false);
      expect(result.logs.map(String).join("\n")).toContain(
        "Server-only module",
      );
    }
    await Bun.write(
      entry,
      `export { clientValue } from '../../${siblingName}/client.ts';`,
    );
    expect((await build()).success).toBe(true);
    await Bun.write(
      entry,
      "import type { Secret } from '../secrets.server.ts'; export const publicValue: Secret = 'public';",
    );
    expect((await build()).success).toBe(true);
    await mkdir(join(routes, "server"));
    await Bun.write(
      join(routes, "server/public.ts"),
      "export const routeNamedServer = 'public';",
    );
    await Bun.write(
      entry,
      "export {routeNamedServer} from './server/public.ts';",
    );
    expect((await build()).success).toBe(true);
    await Bun.write(
      join(routes, "Public.svelte"),
      "<h1>Public</h1><style>h1 { color: purple; }</style>",
    );
    await Bun.write(entry, "export { default } from './Public.svelte';");
    expect((await build()).success).toBe(true);
    await Bun.write(
      entry,
      "export const load = (path: string) => import(path);",
    );
    const unresolved = await build();
    expect(unresolved.success).toBe(false);
    expect(unresolved.logs.map(String).join("\n")).toContain("import");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
});
