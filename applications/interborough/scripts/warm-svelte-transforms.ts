import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Asset = { code: string; map: string | null; warnings: readonly unknown[] };
type Compiler = {
  compileComponent(source: string, options: object): Asset;
  compileRuneModule(source: string, options: object): Asset;
};

const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

/** Publish complete bytes at once; another build may publish the same value concurrently. */
async function publish(path: string, contents: string | Uint8Array): Promise<void> {
  const pending = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(pending, contents);
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

/** Bundle and execute the actual compiler closure. Its bytes, not a lockfile, identify it. */
async function compilerClosure(
  directory: string,
  entry: string,
): Promise<{ compiler: Compiler; digest: string }> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    metafile: true,
  });
  const metafile = result.metafile;
  if (
    !result.success ||
    result.logs.length ||
    result.outputs.length !== 1 ||
    !metafile ||
    Object.values(metafile.outputs).some((output) =>
      output.imports.some((edge) => 'external' in edge && edge.external === true),
    )
  ) {
    throw new AggregateError(result.logs, 'Could not seal the Svelte compiler closure');
  }
  const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer());
  const digest = hash(bytes);
  const path = join(directory, `compiler-${digest}.mjs`);
  // Replace even a damaged existing compiler file before importing it.
  await publish(path, bytes);
  return { compiler: (await import(pathToFileURL(path).href)) as Compiler, digest };
}

/** Cache only successful injected client transforms; Bun still resolves and links every build. */
export async function warmSvelteTransforms(
  directory: string,
  entry = fileURLToPath(import.meta.resolve('@lostgradient/velveteen/compiler')),
): Promise<{
  plugin: Bun.BunPlugin;
  statistics: { hits: number; misses: number };
}> {
  await mkdir(directory, { recursive: true });
  const { compiler, digest } = await compilerClosure(directory, entry);
  const statistics = { hits: 0, misses: 0 };
  const plugin: Bun.BunPlugin = {
    name: 'warm-svelte-transforms',
    setup(builder) {
      builder.onLoad({ filter: /\.svelte(?:\.[jt]s)?$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const rune = /\.svelte\.[jt]s$/.test(path);
        const key = hash(
          JSON.stringify([
            path,
            source,
            digest,
            Bun.version,
            rune,
            'client',
            'injected',
            true,
            false,
          ]),
        );
        const cacheFile = join(directory, key);
        try {
          const value: unknown = JSON.parse(await readFile(cacheFile, 'utf8'));
          if (
            typeof value === 'object' &&
            value !== null &&
            'contents' in value &&
            typeof value.contents === 'string' &&
            'digest' in value &&
            value.digest === hash(`${key}\0${value.contents}`)
          ) {
            statistics.hits += 1;
            return { contents: value.contents, loader: 'js' };
          }
        } catch (error) {
          if (
            !(error instanceof SyntaxError) &&
            !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
          )
            throw error;
        }
        statistics.misses += 1;
        const result = rune
          ? compiler.compileRuneModule(source, { filename: path, target: 'client', dev: true })
          : compiler.compileComponent(source, {
              filename: path,
              target: 'client',
              dev: true,
              hmr: false,
              css: 'injected',
            });
        if (result.warnings.length)
          throw new Error(
            `Svelte compiler warnings in ${path}: ${JSON.stringify(result.warnings)}`,
          );
        const sourceMap = result.map
          ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(result.map).toString('base64')}`
          : '';
        const contents = result.code + sourceMap;
        await publish(cacheFile, JSON.stringify({ contents, digest: hash(`${key}\0${contents}`) }));
        return { contents, loader: 'js' };
      });
    },
  };
  return { plugin, statistics };
}
