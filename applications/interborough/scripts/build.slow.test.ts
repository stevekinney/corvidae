/**
 * The real production build (`scripts/build.ts`): bundling takes seconds, so it runs in the slow
 * lane (`test:slow`). The file makes exactly one bundle of the real application, in file setup
 * (a top-level `await`, so no test's own time limit pays for it), written into a scratch directory
 * so it races nothing that builds `build/`. Every assertion that reads a build's output shares it.
 * The retention tests exercise what `buildApplication` does around the bundler, not the bundler,
 * so each rebuilds a one-line entry through the real `Bun.build` and the real build options, and
 * seeds its "previous build" by copying the shared one. Nothing asserts on how long a build takes.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ApplicationBuild, BUILD_ASSET_DIRECTORY, buildApplication } from './build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-build-slow-'));
const outdir = join(scratch, 'build');

/** The most real bundles of the application this file may make: the shared production build. */
const MAXIMUM_BUNDLES = 1;
let bundles = 0;

/** `Bun.build`, counted, so that no test quietly adds a bundle and pushes the file toward Bun's limit. */
function counted(configuration: Bun.BuildConfig): Promise<Bun.BuildOutput> {
  bundles += 1;
  return Bun.build(configuration);
}

const sharedBuild: ApplicationBuild = await buildApplication({ outdir, bundle: counted });

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  expect(bundles).toBeLessThanOrEqual(MAXIMUM_BUNDLES);
});

const GRAMMAR_MODULE = /@shikijs\/langs\/dist\/([^/]+)\.mjs$/;
const THEME_MODULE = /@shikijs\/themes\/dist\/([^/]+)\.mjs$/;

/** The names a metafile's `outputs[*].inputs` keys yield for `pattern`, sorted. */
function emittedModules(metafile: Bun.BuildMetafile, pattern: RegExp): string[] {
  const names = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      const name = pattern.exec(input)?.[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names].toSorted();
}

describe('buildApplication', () => {
  it('writes index.html and hashed JavaScript and CSS into the output directory', async () => {
    const result = sharedBuild;

    expect(result.directory).toBe(outdir);
    expect(result.files).toContain('index.html');
    const assets = result.files.filter((file) => file !== 'index.html');
    expect(assets.length).toBeGreaterThan(0);
    for (const file of assets) {
      expect(file).toMatch(
        new RegExp(`^${BUILD_ASSET_DIRECTORY}/[^/]+-[a-z0-9]{8}\\.(?:js|css|wasm)$`),
      );
      expect(existsSync(join(result.directory, file)), file).toBe(true);
    }
    expect(assets.some((file) => file.endsWith('.js'))).toBe(true);
    expect(assets.some((file) => file.endsWith('.css'))).toBe(true);

    const html = await Bun.file(join(result.directory, 'index.html')).text();
    expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/[^"]+\.js">/);
    expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/);
    expect(html).not.toContain('main.ts');
    // The metafile is returned, never written into the directory the host serves.
    expect(result.files.some((file) => file.includes('metafile'))).toBe(false);
    // A successful build leaves no staging directory of its own behind.
    expect(readdirSync(scratch)).toEqual(['build']);
  });

  it('emits exactly the grammars and themes the highlighters register', async () => {
    const { metafile } = sharedBuild;

    // `src/lib/code-highlighter.ts` registers `json` and `typescript` and two themes. Chat renders
    // messages with Markdown, which registers its own curated set (`BUNDLED_LANGUAGES` in
    // `packages/markdown/src/rendering/highlighter.ts`) and the grammars those embed (`postcss`
    // for CSS inside Svelte and HTML, `shellscript` for the shell family). The complete registries
    // Cinder offers are never reachable: `curatedShikiPlugin` (`build.ts`) resolves them to
    // `src/lib/curated-shiki-registries.ts`, whose tables Chat's highlighter reads.
    expect(emittedModules(metafile, GRAMMAR_MODULE)).toEqual([
      'bash',
      'css',
      'diff',
      'html',
      'javascript',
      'json',
      'markdown',
      'postcss',
      'python',
      'shellscript',
      'sql',
      'svelte',
      'typescript',
      'yaml',
    ]);
    expect(emittedModules(metafile, THEME_MODULE)).toEqual(['github-dark', 'github-light']);
  });
});

describe('buildApplication Chat highlighting', () => {
  it('gives Chat’s highlighter the curated registries and not Shiki’s complete ones', async () => {
    const { metafile } = sharedBuild;

    const inputs = Object.values(metafile.outputs).flatMap((output) => Object.keys(output.inputs));
    expect(inputs.some((input) => input.endsWith('src/lib/curated-shiki-registries.ts'))).toBe(
      true,
    );
    expect(inputs.some((input) => /shiki\/dist\/(?:langs|themes)/.test(input))).toBe(false);
  });
});

describe('buildApplication asset retention', () => {
  /**
   * A rebuild over a copy of the shared build, with a file from "the build before" planted in the
   * copy. The copy stands in for the previous build, and the rebuild bundles a one-line entry with
   * the application's real build options, because retention is decided by the files around the
   * bundle and not by what the bundler is given.
   */
  async function replacedBuild(development: boolean): Promise<string> {
    const outdir = join(mkdtempSync(join(scratch, 'retention-')), 'build');
    cpSync(sharedBuild.directory, outdir, { recursive: true });
    const entry = join(scratch, 'retention-entry.ts');
    writeFileSync(entry, 'export const answer = 42;\n');
    writeFileSync(join(outdir, BUILD_ASSET_DIRECTORY, 'previous-generation-aaaaaaaa.js'), '');
    await buildApplication({
      outdir,
      development,
      bundle: (configuration) => Bun.build({ ...configuration, entrypoints: [entry] }),
    });
    return join(outdir, BUILD_ASSET_DIRECTORY, 'previous-generation-aaaaaaaa.js');
  }

  it('keeps the previous build’s assets in development', async () => {
    expect(existsSync(await replacedBuild(true))).toBe(true);
  });

  it('keeps nothing of the previous build in production', async () => {
    expect(existsSync(await replacedBuild(false))).toBe(false);
  });
});
