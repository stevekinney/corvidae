/**
 * Tests for `scripts/build.ts`: the atomic directory swap, the clean-build check, the bundler
 * options, the WebAssembly plugin, and the staging, retention and replacement that surround the
 * bundler (driven through a fake bundler). The real build, which bundles for seconds, is in
 * `build.slow.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';

import {
  assertCleanBuild,
  assertSafeOutputDirectory,
  browserBuildOptions,
  BUILD_ASSET_DIRECTORY,
  buildApplication,
  CURATED_SHIKI_REGISTRIES,
  curatedShikiPlugin,
  DEFAULT_BUILD_DIRECTORY,
  ENTRY_HTML_PATH,
  PACKAGE_DIRECTORY,
  parseBuildArguments,
  replaceDirectory,
  REPOSITORY_ROOT,
  RETAINED_ASSETS_FILE,
  retainPreviousAssets,
  runBuildCommand,
  wasmPlugin,
} from './build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-build-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('replaceDirectory', () => {
  /** A parent directory holding `build/` (when `previous` is given) and `staging/`. */
  function directories(previous: string | undefined): {
    parent: string;
    directory: string;
    staging: string;
  } {
    const parent = mkdtempSync(join(scratch, 'replace-'));
    const directory = join(parent, 'build');
    const staging = join(parent, 'staging');
    if (previous !== undefined) {
      mkdirSync(directory);
      writeFileSync(join(directory, 'index.html'), previous);
    }
    mkdirSync(staging);
    writeFileSync(join(staging, 'index.html'), 'new');
    return { parent, directory, staging };
  }

  it('puts the staged tree in place and deletes the previous one', async () => {
    const { parent, directory, staging } = directories('old');
    await replaceDirectory(staging, directory);
    expect(await Bun.file(join(directory, 'index.html')).text()).toBe('new');
    expect(readdirSync(parent)).toEqual(['build']);
  });

  it('puts the staged tree in place when nothing was there before', async () => {
    const { parent, directory, staging } = directories(undefined);
    await replaceDirectory(staging, directory);
    expect(await Bun.file(join(directory, 'index.html')).text()).toBe('new');
    expect(readdirSync(parent)).toEqual(['build']);
  });

  it('restores the previous tree when the staged tree cannot be renamed into place', async () => {
    const { parent, directory, staging } = directories('old');
    const failure = new Error('rename failed');
    const renames: [string, string][] = [];
    const rejection = await rejectionOf(
      replaceDirectory(staging, directory, {
        rename: async (from, to) => {
          renames.push([from, to]);
          if (from === staging) throw failure;
          await rename(from, to);
        },
        rm,
      }),
    );
    expect(rejection).toBe(failure);
    expect(renames).toHaveLength(3);
    expect(renames[0]?.[0]).toBe(directory);
    expect(renames[2]).toEqual([renames[0]?.[1] ?? '', directory]);
    expect(await Bun.file(join(directory, 'index.html')).text()).toBe('old');
    expect(readdirSync(parent).toSorted()).toEqual(['build', 'staging']);
  });

  it('leaves the previous tree alone when it cannot be moved aside', async () => {
    const { directory, staging } = directories('old');
    const failure = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const rejection = await rejectionOf(
      replaceDirectory(staging, directory, {
        rename: async () => {
          throw failure;
        },
        rm,
      }),
    );
    expect(rejection).toBe(failure);
    expect(await Bun.file(join(directory, 'index.html')).text()).toBe('old');
  });
});

type BuildLog = Bun.BuildOutput['logs'][number];

describe('assertCleanBuild', () => {
  const metafile: Bun.BuildMetafile = { inputs: {}, outputs: {} };
  const warning = { level: 'warning', message: 'unused selector' } as unknown as BuildLog;
  const failure = { level: 'error', message: 'syntax error' } as unknown as BuildLog;

  function output(fields: Partial<Bun.BuildOutput>): Bun.BuildOutput {
    return { success: true, outputs: [], logs: [], metafile, ...fields };
  }

  it('returns the metafile of a clean build', () => {
    expect(assertCleanBuild(output({}))).toBe(metafile);
  });

  it('fails a build that did not succeed', () => {
    expect(() => assertCleanBuild(output({ success: false, logs: [failure] }))).toThrow(
      'Browser compilation failed',
    );
  });

  it('fails a build that logged a warning', () => {
    expect(() => assertCleanBuild(output({ logs: [warning] }))).toThrow(
      'Browser compilation emitted warnings',
    );
  });

  it('fails a build without a metafile', () => {
    const { metafile: _metafile, ...withoutMetafile } = output({});
    expect(() => assertCleanBuild(withoutMetafile)).toThrow(
      'Browser compilation did not emit module provenance',
    );
  });
});

describe('retainPreviousAssets', () => {
  /** A `build/` and a `staging/` tree whose `assets/` hold the named files. */
  function generation(built: string[], staged: string[]): { directory: string; staging: string } {
    const parent = mkdtempSync(join(scratch, 'retain-'));
    const directory = join(parent, 'build');
    const staging = join(parent, 'staging');
    for (const [root, names] of [
      [directory, built],
      [staging, staged],
    ] as const) {
      mkdirSync(join(root, BUILD_ASSET_DIRECTORY), { recursive: true });
      for (const name of names) {
        writeFileSync(join(root, BUILD_ASSET_DIRECTORY, name), `${root}:${name}`);
      }
    }
    return { directory, staging };
  }

  function assetNames(root: string): string[] {
    return readdirSync(join(root, BUILD_ASSET_DIRECTORY)).toSorted();
  }

  it("keeps the previous build's hashed assets beside the new build's own", async () => {
    const { directory, staging } = generation(['chunk-old11111.js'], ['chunk-new22222.js']);
    await retainPreviousAssets(staging, directory);
    await replaceDirectory(staging, directory);
    expect(assetNames(directory)).toEqual(['chunk-new22222.js', 'chunk-old11111.js']);
  });

  it('keeps only one generation: assets the previous build carried over are dropped', async () => {
    const first = generation(['chunk-first111.js'], ['chunk-second22.js']);
    await retainPreviousAssets(first.staging, first.directory);
    await replaceDirectory(first.staging, first.directory);
    expect(assetNames(first.directory)).toEqual(['chunk-first111.js', 'chunk-second22.js']);

    const third = join(first.directory, '..', 'staging-third');
    mkdirSync(join(third, BUILD_ASSET_DIRECTORY), { recursive: true });
    writeFileSync(join(third, BUILD_ASSET_DIRECTORY, 'chunk-third333.js'), 'third');
    await retainPreviousAssets(third, first.directory);
    await replaceDirectory(third, first.directory);

    expect(assetNames(first.directory)).toEqual(['chunk-second22.js', 'chunk-third333.js']);
  });

  it('never overwrites a file the new build emitted under the same name', async () => {
    const { directory, staging } = generation(['shared-abcd1234.css'], ['shared-abcd1234.css']);
    await retainPreviousAssets(staging, directory);
    expect(await Bun.file(join(staging, BUILD_ASSET_DIRECTORY, 'shared-abcd1234.css')).text()).toBe(
      `${staging}:shared-abcd1234.css`,
    );
  });

  it('retains nothing when there was no build before', async () => {
    const parent = mkdtempSync(join(scratch, 'retain-first-'));
    const staging = join(parent, 'staging');
    mkdirSync(staging);
    expect(await retainPreviousAssets(staging, join(parent, 'build'))).toEqual([]);
  });
});

describe('browserBuildOptions', () => {
  const entrypoints = ['index.html'];

  it('compiles NODE_ENV in and the Svelte plugin for the mode asked for', () => {
    const production = browserBuildOptions({ entrypoints, outdir: 'out', development: false });
    const development = browserBuildOptions({ entrypoints, outdir: 'out', development: true });

    expect(production.define).toEqual({ 'process.env.NODE_ENV': '"production"' });
    expect(development.define).toEqual({ 'process.env.NODE_ENV': '"development"' });
    for (const options of [production, development]) {
      expect(options.entrypoints).toBe(entrypoints);
      expect(options.outdir).toBe('out');
      expect(options.conditions).toEqual(['browser', 'svelte', 'unwasm']);
      expect(options.splitting).toBe(true);
      expect(options.metafile).toBe(true);
      expect(options.plugins?.[0]).toBe(wasmPlugin);
      expect(options.plugins?.[1]).toBe(curatedShikiPlugin);
      expect(options.plugins).toHaveLength(3);
      expect(options.naming).toEqual({
        entry: '[name].[ext]',
        chunk: `${BUILD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
        asset: `${BUILD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
      });
    }
  });
});

describe('wasmPlugin', () => {
  type Hook = (arguments_: { path: string }) => unknown;

  /** Run the plugin's `setup` against a builder that records the hooks it registers. */
  function registeredHooks(): { onLoad: Hook[]; onResolve: Hook[] } {
    const hooks = { onLoad: [] as Hook[], onResolve: [] as Hook[] };
    wasmPlugin.setup({
      onLoad: (_constraints: unknown, callback: Hook) => hooks.onLoad.push(callback),
      onResolve: (_constraints: unknown, callback: Hook) => hooks.onResolve.push(callback),
    } as unknown as Bun.PluginBuilder);
    return hooks;
  }

  it('turns a .wasm import into a module that instantiates the emitted asset', async () => {
    const { onLoad, onResolve } = registeredHooks();
    expect(onLoad).toHaveLength(2);
    expect(onResolve).toHaveLength(1);

    const module = (await onLoad[0]?.({ path: '/modules/engine.wasm' })) as {
      loader: string;
      contents: string;
    };
    expect(module.loader).toBe('js');
    expect(module.contents).toContain('import url from "wasm-asset:/modules/engine.wasm"');
    expect(module.contents).toContain('WebAssembly.instantiateStreaming(fetch(url), imports)');
  });

  it('resolves the asset import to a distinct binary path and loads the file’s bytes', async () => {
    const { onLoad, onResolve } = registeredHooks();
    const file = join(scratch, 'engine.wasm');
    writeFileSync(file, new Uint8Array([0, 97, 115, 109]));

    const resolved = (await onResolve[0]?.({ path: `wasm-asset:${file}` })) as {
      path: string;
      namespace: string;
    };
    expect(resolved).toEqual({ path: `${file}.binary.wasm`, namespace: 'wasm-asset' });

    const loaded = (await onLoad[1]?.({ path: resolved.path })) as {
      contents: Uint8Array;
      loader: string;
    };
    expect(loaded.loader).toBe('file');
    expect([...loaded.contents]).toEqual([0, 97, 115, 109]);
  });
});

describe('curatedShikiPlugin', () => {
  type Hook = (arguments_: { path: string }) => unknown;

  function registered() {
    const constraints: Array<{ filter: RegExp; namespace?: string }> = [];
    const hooks: Hook[] = [];
    curatedShikiPlugin.setup({
      onResolve: (constraint: { filter: RegExp }, callback: Hook) => {
        constraints.push(constraint);
        hooks.push(callback);
      },
      onLoad: (constraint: { filter: RegExp; namespace?: string }, callback: Hook) => {
        constraints.push(constraint);
        hooks.push(callback);
      },
    } as unknown as Bun.PluginBuilder);
    return { constraints, hooks };
  }

  it('claims only the complete language and theme registries', () => {
    const { constraints } = registered();

    expect(constraints[0]?.filter.test('shiki/langs')).toBe(true);
    expect(constraints[0]?.filter.test('shiki/themes')).toBe(true);
    expect(constraints[0]?.filter.test('shiki/core')).toBe(false);
    expect(constraints[0]?.filter.test('@shikijs/langs/typescript')).toBe(false);
  });

  it('resolves each registry to the module of curated tables, which are not empty', async () => {
    const { hooks } = registered();

    for (const path of ['shiki/langs', 'shiki/themes']) {
      expect(await hooks[0]?.({ path })).toEqual({ path: CURATED_SHIKI_REGISTRIES });
    }
    // Empty tables once broke Chat's highlighter, which renders every block as plain text then.
    const registries = await import(CURATED_SHIKI_REGISTRIES);
    expect(Object.keys(registries.bundledLanguages)).toContain('json');
    expect(Object.keys(registries.bundledThemes)).toContain('github-light');
  });
});

describe('buildApplication', () => {
  /** A bundler that writes `files` into the staging directory it is given, as `Bun.build` would. */
  function fakeBundle(
    files: Record<string, string>,
    overrides: Partial<Bun.BuildOutput> = {},
  ): {
    bundle: (configuration: Bun.BuildConfig) => Promise<Bun.BuildOutput>;
    calls: Bun.BuildConfig[];
  } {
    const calls: Bun.BuildConfig[] = [];
    return {
      calls,
      bundle: async (configuration) => {
        calls.push(configuration);
        const outdir = configuration.outdir ?? '';
        for (const [name, contents] of Object.entries(files)) {
          mkdirSync(join(outdir, name, '..'), { recursive: true });
          writeFileSync(join(outdir, name), contents);
        }
        return {
          success: true,
          outputs: Object.keys(files).map((name) => ({ path: join(outdir, name) })),
          logs: [],
          metafile: { inputs: {}, outputs: {} },
          ...overrides,
        } as unknown as Bun.BuildOutput;
      },
    };
  }

  function outputDirectory(): string {
    return join(mkdtempSync(join(scratch, 'build-')), 'build');
  }

  it('builds the production application into the output directory and lists its files', async () => {
    const outdir = outputDirectory();
    const { bundle, calls } = fakeBundle({
      'index.html': 'page',
      [`${BUILD_ASSET_DIRECTORY}/main-aaaaaaaa.js`]: 'main',
    });

    const result = await buildApplication({ outdir, bundle });

    expect(result.directory).toBe(resolve(outdir));
    expect(result.files).toEqual(['assets/main-aaaaaaaa.js', 'index.html']);
    expect(result.metafile).toEqual({ inputs: {}, outputs: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entrypoints).toEqual([ENTRY_HTML_PATH]);
    expect(calls[0]?.minify).toBe(true);
    expect(calls[0]?.define).toEqual({ 'process.env.NODE_ENV': '"production"' });
    expect(await Bun.file(join(outdir, 'index.html')).text()).toBe('page');
    // The staging directory is gone: only the build remains beside it.
    expect(readdirSync(join(outdir, '..'))).toEqual(['build']);
  });

  it('keeps the previous build’s assets in development and drops them in production', async () => {
    const outdir = outputDirectory();
    const planted = join(outdir, BUILD_ASSET_DIRECTORY, 'previous-generation-aaaaaaaa.js');
    const files = { 'index.html': 'page', [`${BUILD_ASSET_DIRECTORY}/main-bbbbbbbb.js`]: 'main' };

    await buildApplication({ outdir, development: true, bundle: fakeBundle(files).bundle });
    writeFileSync(planted, '');
    const development = fakeBundle(files);
    await buildApplication({ outdir, development: true, bundle: development.bundle });
    expect(existsSync(planted)).toBe(true);
    expect(development.calls[0]?.minify).toBe(false);
    expect(development.calls[0]?.define).toEqual({
      'process.env.NODE_ENV': '"development"',
    });
    expect(existsSync(join(outdir, RETAINED_ASSETS_FILE))).toBe(true);

    await buildApplication({ outdir, bundle: fakeBundle(files).bundle });
    expect(existsSync(planted)).toBe(false);
    expect(existsSync(join(outdir, RETAINED_ASSETS_FILE))).toBe(false);
  });

  it('leaves the previous build intact and no staging directory when the build fails', async () => {
    const outdir = outputDirectory();
    await buildApplication({ outdir, bundle: fakeBundle({ 'index.html': 'old' }).bundle });

    const rejection = await rejectionOf(
      buildApplication({
        outdir,
        bundle: fakeBundle({ 'index.html': 'half-written' }, { success: false }).bundle,
      }),
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(await Bun.file(join(outdir, 'index.html')).text()).toBe('old');
    expect(readdirSync(join(outdir, '..'))).toEqual(['build']);
  });
});

describe('runBuildCommand', () => {
  it('builds with the default options and logs where and how many files it wrote', async () => {
    const lines: string[] = [];
    const build = { directory: DEFAULT_BUILD_DIRECTORY, files: ['index.html'], metafile: {} };
    const result = await runBuildCommand(
      (line) => lines.push(line),
      async () => build as unknown as Awaited<ReturnType<typeof buildApplication>>,
    );

    expect(result).toBe(build as unknown as typeof result);
    expect(lines).toEqual([`Built Interborough into ${DEFAULT_BUILD_DIRECTORY} (1 files)`]);
  });

  it('passes the parsed command-line arguments to the build', async () => {
    const received: unknown[] = [];
    await runBuildCommand(
      () => {},
      async (options) => {
        received.push(options);
        return { directory: 'x', files: [], metafile: {} } as unknown as Awaited<
          ReturnType<typeof buildApplication>
        >;
      },
      ['--development'],
    );
    expect(received).toEqual([{ development: true }]);
  });
});

describe('parseBuildArguments', () => {
  it('builds for production into the default directory when given nothing', () => {
    expect(parseBuildArguments([])).toEqual({ development: false, exitWithParent: false });
  });

  it('reads --development and --outdir', () => {
    expect(parseBuildArguments(['--development', '--outdir', '/tmp/somewhere'])).toEqual({
      development: true,
      exitWithParent: false,
      outdir: '/tmp/somewhere',
    });
  });

  it('reads --exit-with-parent, which the build itself never sees', async () => {
    expect(parseBuildArguments(['--exit-with-parent']).exitWithParent).toBe(true);
    const received: unknown[] = [];
    await runBuildCommand(
      () => {},
      async (options) => {
        received.push(options);
        return { directory: 'x', files: [], metafile: {} } as unknown as Awaited<
          ReturnType<typeof buildApplication>
        >;
      },
      ['--exit-with-parent'],
    );
    expect(received).toEqual([{ development: false }]);
  });

  it('refuses an unknown argument and an --outdir without a directory', () => {
    expect(() => parseBuildArguments(['--watch'])).toThrow('Unknown build argument: --watch');
    expect(() => parseBuildArguments(['--outdir'])).toThrow('--outdir needs a directory');
  });
});

describe('the output directory guard', () => {
  it('rejects a blank or whitespace-only --outdir before anything resolves it', () => {
    expect(() => parseBuildArguments(['--outdir', ''])).toThrow('--outdir needs a directory');
    expect(() => parseBuildArguments(['--outdir', '  \t'])).toThrow('--outdir needs a directory');
    expect(() => assertSafeOutputDirectory('')).toThrow('must not be blank');
    expect(() => assertSafeOutputDirectory('   ')).toThrow('must not be blank');
  });

  it('refuses the working directory, however it is spelled', () => {
    const working = mkdtempSync(join(scratch, 'working-'));
    expect(() => assertSafeOutputDirectory(working, working)).toThrow('Refusing to build into');
    expect(() => assertSafeOutputDirectory(join(working, '.'), working)).toThrow('Refusing');
    expect(() => assertSafeOutputDirectory(dirname(working), working)).toThrow('Refusing');
  });

  it('refuses the repository root, the application, their parents, and any source directory', () => {
    for (const refused of [
      REPOSITORY_ROOT,
      dirname(REPOSITORY_ROOT),
      PACKAGE_DIRECTORY,
      join(PACKAGE_DIRECTORY, 'src'),
      join(PACKAGE_DIRECTORY, 'scripts'),
      join(REPOSITORY_ROOT, 'packages'),
      join(REPOSITORY_ROOT, 'packages', 'weft', 'src'),
      '/',
    ]) {
      expect(() => assertSafeOutputDirectory(refused, scratch)).toThrow('Refusing to build into');
    }
  });

  it('refuses a symbolic link that points at the application', () => {
    const link = join(mkdtempSync(join(scratch, 'link-')), 'build');
    symlinkSync(PACKAGE_DIRECTORY, link);
    expect(() => assertSafeOutputDirectory(link, scratch)).toThrow('Refusing to build into');
  });

  it('allows a directory outside the repository and the default build directory', () => {
    const outside = join(mkdtempSync(join(scratch, 'outside-')), 'build');
    expect(assertSafeOutputDirectory(outside, scratch)).toBe(outside);
    expect(assertSafeOutputDirectory(DEFAULT_BUILD_DIRECTORY, scratch)).toBe(
      DEFAULT_BUILD_DIRECTORY,
    );
  });

  it('builds nothing and creates nothing when buildApplication is given a blank or unsafe directory', async () => {
    let bundled = false;
    const bundle = async (): Promise<Bun.BuildOutput> => {
      bundled = true;
      throw new Error('The bundler must not run.');
    };
    for (const outdir of ['', ' ', PACKAGE_DIRECTORY, join(PACKAGE_DIRECTORY, 'src')]) {
      const rejection = await buildApplication({ outdir, bundle }).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
    }
    expect(bundled).toBe(false);
    expect(existsSync(join(PACKAGE_DIRECTORY, 'src', 'host', 'host.ts'))).toBe(true);
  });
});
