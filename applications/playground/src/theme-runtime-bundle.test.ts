import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

/**
 * The browser-bundle gate for `@lostgradient/cinder/tokens/runtime`.
 *
 * The runtime is the one token kernel the generator scripts and the playground
 * share, so it must be bundleable for the browser as-is: nothing from Node or
 * Bun, no Prettier, no filesystem or network access, and no runtime code
 * generation (the schema validators are generated standalone modules, which
 * keeps it working under a Content-Security-Policy without `unsafe-eval`).
 *
 * The bundle is built from a playground-style entry that imports the package
 * subpath, so the check also covers the `exports` entry, not only the source.
 *
 * Bun's browser target replaces Node built-ins with stubs and polyfills, so the
 * bundle text alone cannot show that one was imported. The checks therefore read
 * the import specifiers of every source file the bundler pulled into the graph.
 *
 * This file calls `Bun.build`, so `scripts/run-tests.ts` runs it in its own
 * process.
 */

const SCRATCH_PARENT = join(import.meta.dir, '.tmp-theme-runtime-bundle');
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

type GraphFile = { path: string; source: string; imports: string[] };

let scratch = '';
let bundleText = '';
let graph: GraphFile[] = [];

function isHostSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    specifier.startsWith('bun:') ||
    specifier === 'bun' ||
    NODE_BUILTINS.has(specifier.split('/')[0]!)
  );
}

/** Every source file in the build's graph, with its import specifiers. */
async function readGraph(inputs: string[]): Promise<GraphFile[]> {
  const files: GraphFile[] = [];
  for (const input of inputs) {
    if (input.startsWith('node:') || !/\.(?:[cm]?[jt]s)$/.test(input)) continue;
    const path = resolve(process.cwd(), input);
    const source = await readFile(path, 'utf8');
    const loader = /\.[cm]?js$/.test(path) ? 'js' : 'ts';
    const imports = new Bun.Transpiler({ loader }).scanImports(source).map(({ path: p }) => p);
    files.push({ path, source, imports });
  }
  return files;
}

async function build(entry: string) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify: false,
    metafile: true,
    packages: 'bundle',
  });
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
  return {
    text: await result.outputs[0]!.text(),
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  };
}

beforeAll(async () => {
  await mkdir(SCRATCH_PARENT, { recursive: true });
  scratch = await mkdtemp(join(SCRATCH_PARENT, 'run-'));
  const entry = join(scratch, 'entry.ts');
  await writeFile(entry, "export * from '@lostgradient/cinder/tokens/runtime';\n");
  const built = await build(entry);
  bundleText = built.text;
  graph = await readGraph(built.inputs);
  await writeFile(join(scratch, 'bundle.js'), bundleText);
});

afterAll(async () => {
  await rm(SCRATCH_PARENT, { recursive: true, force: true });
});

describe('the token runtime browser bundle', () => {
  it('resolves the package subpath and bundles a non-trivial graph', () => {
    expect(bundleText.length).toBeGreaterThan(200_000);
    expect(graph.length).toBeGreaterThan(30);
    expect(
      graph.some((file) => file.path.endsWith('components/cinder/src/tokens/runtime/index.ts')),
    ).toBe(true);
  });

  it('imports no Node built-in or Bun module anywhere in its graph', () => {
    const offenders = graph.flatMap((file) =>
      file.imports.filter(isHostSpecifier).map((specifier) => `${file.path} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
    expect(bundleText).not.toMatch(/^\/\/ node:/m);
  });

  it('would notice a Node built-in if one were imported (control)', async () => {
    const entry = join(scratch, 'control.ts');
    await writeFile(
      entry,
      "import { readFileSync } from 'node:fs';\nimport { format } from 'node:path';\nexport const read = [readFileSync, format];\n",
    );
    const control = await readGraph((await build(entry)).inputs);
    expect(control.flatMap((file) => file.imports).filter(isHostSpecifier)).toEqual([
      'node:fs',
      'node:path',
    ]);
  });

  it('uses no Bun file or process API', () => {
    const offenders = graph.flatMap((file) =>
      [
        /\bBun\.(?:file|write|spawn|spawnSync|Glob|build|env|serve)\b/,
        /\bimport\.meta\.(?:dir|dirname|file|filename|main)\b/,
        /\bprocess\.(?:cwd|env|argv|exit)\b/,
      ]
        .filter((pattern) => pattern.test(file.source))
        .map((pattern) => `${file.path}: ${pattern}`),
    );
    expect(offenders).toEqual([]);
  });

  it('contains no Prettier, generator script, or other tooling module', () => {
    expect(bundleText).not.toMatch(/prettier/i);
    const tooling = graph.filter(
      (file) =>
        /\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:prettier|ajv|ajv-formats|postcss|stylelint)\//.test(
          file.path,
        ) || /\/components\/cinder\/scripts\//.test(file.path),
    );
    expect(tooling.map((file) => file.path)).toEqual([]);
  });

  it('does not fetch source at runtime', () => {
    expect(bundleText).not.toMatch(/\bfetch\s*\(/);
    expect(bundleText).not.toMatch(/\bXMLHttpRequest\b|\bnew WebSocket\b|\bimportScripts\b/);
    expect(bundleText).not.toMatch(/\bimport\s*\(/);
  });

  it('generates no code at runtime, so it works under a strict Content-Security-Policy', () => {
    expect(bundleText).not.toMatch(/\bnew Function\s*\(|\beval\s*\(|\bFunction\s*\(\s*["'`]/);
  });

  it('only pulls the runtime tree and its pure dependencies into the graph', () => {
    const outside = graph.filter(
      (file) =>
        !/\/components\/cinder\/src\/tokens\//.test(file.path) &&
        !/\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?postcss-value-parser\//.test(
          file.path,
        ) &&
        !file.path.endsWith('/entry.ts'),
    );
    expect(outside.map((file) => file.path)).toEqual([]);
  });

  it('runs: the bundled runtime evaluates the bundled Cinder base across all six contexts', async () => {
    const runtime: typeof import('@lostgradient/cinder/tokens/runtime') = await import(
      join(scratch, 'bundle.js')
    );
    const { CINDER_BASE, evaluateTheme } = runtime;
    const result = evaluateTheme({
      revision: 1,
      resolver: CINDER_BASE.resolver,
      documents: CINDER_BASE.documents,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contexts.map((context) => context.id)).toEqual([
      'light/default',
      'light/reduced',
      'light/forced-reduced-motion',
      'dark/default',
      'dark/reduced',
      'dark/forced-reduced-motion',
    ]);
    expect(Object.keys(result.properties['dark/default']!).length).toBeGreaterThan(300);
    expect(CINDER_BASE.sourceDigest).toMatch(/^sha256:/);
  });
});
