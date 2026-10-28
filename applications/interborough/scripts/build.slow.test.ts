/**
 * The real production build (`scripts/build.ts`): bundling takes seconds, so it runs in the slow
 * lane (`test:slow`). The file builds the application once, at module scope, because three tests
 * read one production bundle, and it writes into a scratch directory so it races nothing that
 * builds `build/`. {@link outcomeOf} caps a hang with the module-scope hang guard and records a
 * build failure, which {@link rethrow} reports under each test that reads the build. The retention
 * tests exercise what `buildApplication` does around the bundler, not the bundler, so each
 * rebuilds a one-line entry through the real `Bun.build` and the real build options, and seeds its
 * "previous build" by copying the shared one. Nothing asserts on how long a build takes.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '@lostgradient/testing';

import {
  type ApplicationBuild,
  BUILD_ASSET_DIRECTORY,
  buildApplication,
  linkedStylesheets,
  PACKAGE_DIRECTORY,
  REPOSITORY_ROOT,
} from './build.ts';

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

let builtOutput: ApplicationBuild | undefined;
const buildOutcome = await outcomeOf(async () => {
  builtOutput = await buildApplication({ outdir, bundle: counted });
});

/** The shared build, or the failure or hang that stopped it, thrown under the reading test. */
function sharedBuild(): ApplicationBuild {
  rethrow(buildOutcome);
  if (builtOutput === undefined) throw new Error('the shared build produced nothing');
  return builtOutput;
}

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
    const result = sharedBuild();

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
    // Production ships no source maps and links none.
    expect(result.files.some((file) => file.endsWith('.map'))).toBe(false);
    for (const file of assets.filter((name) => name.endsWith('.js'))) {
      expect(await Bun.file(join(result.directory, file)).text(), file).not.toContain(
        'sourceMappingURL',
      );
    }

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
    const { metafile } = sharedBuild();

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

describe('buildApplication stylesheets', () => {
  /** The first custom property Cinder's token stylesheet declares, which opens its root block. */
  function firstCinderToken(): string {
    const tokens = readFileSync(
      join(REPOSITORY_ROOT, 'components', 'cinder', 'src', 'styles', 'tokens-base.css'),
      'utf8',
    );
    const property = /^\s*(--[\w-]+)\s*:/m.exec(tokens)?.[1];
    if (property === undefined) throw new Error('tokens-base.css declares no custom property');
    return property;
  }

  async function emittedStylesheets(result: ApplicationBuild): Promise<Map<string, string>> {
    const sheets = new Map<string, string>();
    for (const file of result.files.filter((name) => name.endsWith('.css'))) {
      sheets.set(file, await Bun.file(join(result.directory, file)).text());
    }
    return sheets;
  }

  it('emits Cinder’s root token block in exactly one stylesheet, and the page links it', async () => {
    const result = sharedBuild();
    const sheets = await emittedStylesheets(result);
    const token = `${firstCinderToken()}:`;

    const holders = [...sheets].filter(([, css]) => css.includes(token)).map(([file]) => file);
    expect(holders).toHaveLength(1);
    // Every stylesheet on disk is the one the page links: lazy routes make no copies of their own.
    expect([...sheets.keys()]).toEqual(holders);
    const html = await Bun.file(join(result.directory, 'index.html')).text();
    expect(linkedStylesheets(html).map((href) => href.replace(/^\//, ''))).toEqual(holders);
    // The disk holds nothing the build did not report.
    const onDisk = readdirSync(join(result.directory, BUILD_ASSET_DIRECTORY)).map(
      (name) => `${BUILD_ASSET_DIRECTORY}/${name}`,
    );
    expect(onDisk.filter((file) => file.endsWith('.css'))).toEqual(holders);
  });

  it('keeps the CSS of lazily imported routes in that one stylesheet', () => {
    const { files, metafile } = sharedBuild();

    const [stylesheet] = files.filter((file) => file.endsWith('.css'));
    const inputs = Object.keys(metafile.outputs[`./${stylesheet}`]?.inputs ?? {});
    // `workflow-detail.css` is imported only by a lazily loaded route.
    expect(
      inputs.some((input) => input.endsWith('routes/workflows/detail/workflow-detail.css')),
    ).toBe(true);
  });

  it('still injects component style blocks into the JavaScript of the component that owns them', async () => {
    const result = sharedBuild();
    const component = readFileSync(
      join(PACKAGE_DIRECTORY, 'src', 'routes', 'settings', 'setting-row.svelte'),
      'utf8',
    );
    const selector = /<style>\s*(\.[\w-]+)/.exec(component)?.[1];
    if (selector === undefined) throw new Error('setting-row.svelte has no leading style rule');

    let injected = false;
    for (const file of result.files.filter((name) => name.endsWith('.js'))) {
      const code = await Bun.file(join(result.directory, file)).text();
      // Svelte scopes the rule with a `svelte-<hash>` class and keeps the hash beside the CSS.
      if (code.includes(`${selector}.svelte-`)) injected = true;
    }
    expect(injected, selector).toBe(true);
  });
});

describe('buildApplication Chat highlighting', () => {
  it('gives Chat’s highlighter the curated registries and not Shiki’s complete ones', async () => {
    const { metafile } = sharedBuild();

    const inputs = Object.values(metafile.outputs).flatMap((output) => Object.keys(output.inputs));
    expect(inputs.some((input) => input.endsWith('src/lib/curated-shiki-registries.ts'))).toBe(
      true,
    );
    expect(inputs.some((input) => /shiki\/dist\/(?:langs|themes)/.test(input))).toBe(false);
  });
});

describe('buildApplication source maps', () => {
  /**
   * A build through the real `Bun.build` and the application's real build options over a two-file
   * entry whose dynamic import makes a chunk, because the map must land beside the chunk under
   * `assets/`. The entry is small on purpose: the shared production build is the only full bundle
   * this file makes.
   */
  async function builtFiles(development: boolean): Promise<ApplicationBuild> {
    const source = mkdtempSync(join(scratch, 'sourcemap-entry-'));
    const entry = join(source, 'entry.ts');
    writeFileSync(entry, "export const load = () => import('./lazy.ts');\n");
    writeFileSync(join(source, 'lazy.ts'), 'export const answer: number = 42;\n');
    return buildApplication({
      outdir: join(mkdtempSync(join(scratch, 'sourcemap-')), 'build'),
      development,
      bundle: (configuration) => Bun.build({ ...configuration, entrypoints: [entry] }),
    });
  }

  it('writes a linked map beside each chunk in development', async () => {
    const result = await builtFiles(true);

    const chunks = result.files.filter((file) => file.endsWith('.js'));
    expect(chunks.some((file) => file.startsWith(`${BUILD_ASSET_DIRECTORY}/`))).toBe(true);
    for (const chunk of chunks) {
      const map = `${chunk}.map`;
      expect(result.files, chunk).toContain(map);
      expect(existsSync(join(result.directory, map)), map).toBe(true);
      const code = await Bun.file(join(result.directory, chunk)).text();
      expect(code, chunk).toContain(`//# sourceMappingURL=/${map}`);
    }
  });

  it('writes no map and no link in production', async () => {
    const result = await builtFiles(false);

    expect(result.files.some((file) => file.endsWith('.map'))).toBe(false);
    for (const chunk of result.files.filter((file) => file.endsWith('.js'))) {
      expect(await Bun.file(join(result.directory, chunk)).text(), chunk).not.toContain(
        'sourceMappingURL',
      );
    }
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
    cpSync(sharedBuild().directory, outdir, { recursive: true });
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
