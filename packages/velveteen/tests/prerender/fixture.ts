import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
export async function staticFixture(
  files: Record<string, string>,
  basePath = "/docs",
) {
  const parent = resolve(".velveteen/prerender");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "contract-"));
  const write = async (entries: Record<string, string>) => {
    for (const [path, text] of Object.entries(entries)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await Bun.write(file, text);
    }
  };
  await write({
    "routes/+layout.ts": "export const prerender=true;",
    "routes/+page.svelte": "<h1>Static home</h1>",
    "static/public.txt": "Public A",
    ...files,
  });
  const build = () =>
    buildProduction({
      projectDirectory: root,
      routesDirectory: join(root, "routes"),
      staticDirectory: join(root, "static"),
      outputDirectory: join(root, "production"),
      basePath,
    });
  return {
    root,
    outputDirectory: join(root, "static-output"),
    write,
    build,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
