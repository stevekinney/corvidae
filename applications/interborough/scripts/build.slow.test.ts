/**
 * The real production build (`scripts/build.ts`): bundling takes seconds, so it runs in the slow
 * lane (`test:slow`). Every test here shares one build, written into a scratch directory so it
 * races nothing that builds `build/`. Nothing asserts on how long the build takes.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ApplicationBuild, BUILD_ASSET_DIRECTORY, buildApplication } from './build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-build-slow-'));
const outdir = join(scratch, 'build');
let build: Promise<ApplicationBuild> | undefined;

function builtApplication(): Promise<ApplicationBuild> {
  build ??= buildApplication({ outdir });
  return build;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
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
    const result = await builtApplication();

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

  it('emits exactly the grammars and themes the highlighter registers', async () => {
    const { metafile } = await builtApplication();

    // `src/lib/code-highlighter.ts` registers these two languages and two themes.
    expect(emittedModules(metafile, GRAMMAR_MODULE)).toEqual(['json', 'typescript']);
    expect(emittedModules(metafile, THEME_MODULE)).toEqual(['github-dark', 'github-light']);
  });
});

describe('buildApplication asset retention', () => {
  /** A finished build in a scratch directory, with a file from "the build before" planted in it. */
  async function replacedBuild(development: boolean): Promise<string> {
    const outdir = join(mkdtempSync(join(scratch, 'retention-')), 'build');
    await buildApplication({ outdir, development: true });
    writeFileSync(join(outdir, BUILD_ASSET_DIRECTORY, 'previous-generation-aaaaaaaa.js'), '');
    await buildApplication({ outdir, development });
    return join(outdir, BUILD_ASSET_DIRECTORY, 'previous-generation-aaaaaaaa.js');
  }

  it('keeps the previous build’s assets in development', async () => {
    expect(existsSync(await replacedBuild(true))).toBe(true);
  });

  it('keeps nothing of the previous build in production', async () => {
    expect(existsSync(await replacedBuild(false))).toBe(false);
  });
});
