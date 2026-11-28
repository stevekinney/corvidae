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
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { rejectionOf, waitUntil } from '@lostgradient/testing';

import { BUILD_INFO_FILE, publishedBrowserBuildDirectory } from '../src/host/build-info.ts';
import { CURATED_SHIKI_REGISTRIES, curatedShikiPlugin, wasmPlugin } from './browser-build.ts';
import {
  assertSafeOutputDirectory,
  buildApplication,
  buildInputPaths,
  DEFAULT_BUILD_DIRECTORY,
  exitWhenStandardInputCloses,
  PACKAGE_DIRECTORY,
  parseBuildArguments,
  REPOSITORY_ROOT,
  runBuildCommand,
  runBuildMain,
} from './build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-build-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
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

describe('native browser publication', () => {
  it('publishes the pair atomically and keeps the last good generation after a failed build', async () => {
    const directory = join(mkdtempSync(join(scratch, 'generation-')), 'build');
    const source = { commit: 'a'.repeat(40), changes: '' };
    const writeOutput = async (path: string, content: string) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'manifest.json'), content);
      return { directory: path, manifest: {} as never };
    };
    const settings = {
      outdir: directory,
      source,
      ensureGenerated: () => {},
      buildNative: (path: string) => writeOutput(path, 'native'),
      buildPrivate: ({ outputDirectory }: { outputDirectory: string }) =>
        writeOutput(outputDirectory, 'private'),
    };
    const first = await buildApplication(settings);
    expect(publishedBrowserBuildDirectory(directory)).toBe(first.directory);
    expect(first.files).toEqual([
      'build-info.json',
      'documents/manifest.json',
      'private/manifest.json',
    ]);
    const pointer = await Bun.file(join(directory, BUILD_INFO_FILE)).text();
    const failure = new Error('private graph failed');
    const result = await rejectionOf(
      buildApplication({
        ...settings,
        buildPrivate: async () => {
          throw failure;
        },
      }),
    );
    expect(result).toBe(failure);
    expect(await Bun.file(join(directory, BUILD_INFO_FILE)).text()).toBe(pointer);
    expect(await Bun.file(join(first.directory, 'documents/manifest.json')).text()).toBe('native');

    const next = await buildApplication({
      ...settings,
      buildNative: (path) => writeOutput(path, 'new'),
    });
    expect(next.directory).not.toBe(first.directory);
    expect(publishedBrowserBuildDirectory(directory)).toBe(next.directory);
    expect(await Bun.file(join(next.directory, 'documents/manifest.json')).text()).toBe('new');
    expect(await Bun.file(join(first.directory, 'documents/manifest.json')).text()).toBe('native');
    expect(readdirSync(dirname(directory))).toEqual(['build']);
  });
});

describe('runBuildCommand', () => {
  it('builds with the default options and logs where and how many files it wrote', async () => {
    const lines: string[] = [];
    const build = {
      directory: DEFAULT_BUILD_DIRECTORY,
      files: ['documents/current.json'],
      metafile: {},
    };
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

describe('the recorded build inputs', () => {
  const metafile = {
    inputs: {
      'src/app/native-document.svelte': { bytes: 1, imports: [] },
      'src/app/routes.ts': { bytes: 1, imports: [] },
      '../../components/chat/src/index.ts': { bytes: 1, imports: [] },
      'wasm-asset:/somewhere/onig.wasm.binary.wasm': { bytes: 1, imports: [] },
      '.cache/native-documents-generated/+layout.svelte': { bytes: 1, imports: [] },
      '/tmp/build/.velveteen-graph-generated/wrappers/browser.ts': { bytes: 1, imports: [] },
    },
    outputs: {},
  } as Bun.BuildMetafile;

  it('names every input as an absolute path, resolved against the working directory', () => {
    expect(buildInputPaths(metafile, '/repository/applications/interborough')).toEqual([
      '/repository/applications/interborough/src/app/native-document.svelte',
      '/repository/applications/interborough/src/app/routes.ts',
      '/repository/components/chat/src/index.ts',
    ]);
  });

  it('writes them to the --inputs-file when the command is given one, and only then', async () => {
    const inputsFile = join(scratch, 'inputs', 'inputs.json');
    mkdirSync(dirname(inputsFile), { recursive: true });
    const build = { directory: 'x', files: [], metafile } as unknown as Awaited<
      ReturnType<typeof buildApplication>
    >;
    const received: unknown[] = [];
    await runBuildCommand(
      () => {},
      async (options) => {
        received.push(options);
        return build;
      },
      ['--development', '--inputs-file', inputsFile],
    );

    expect(received).toEqual([{ development: true }]);
    expect(await Bun.file(inputsFile).json()).toEqual(buildInputPaths(metafile));
    expect(readdirSync(dirname(inputsFile))).toEqual(['inputs.json']);

    rmSync(inputsFile);
    await runBuildCommand(
      () => {},
      async () => build,
      ['--development'],
    );
    expect(existsSync(inputsFile)).toBe(false);
  });
});

describe('parseBuildArguments', () => {
  it('reads --inputs-file and refuses one without a file', () => {
    expect(parseBuildArguments(['--inputs-file', '/tmp/inputs.json']).inputsFile).toBe(
      '/tmp/inputs.json',
    );
    expect(() => parseBuildArguments(['--inputs-file'])).toThrow('--inputs-file needs a file');
    expect(() => parseBuildArguments(['--inputs-file', ' '])).toThrow('--inputs-file needs a file');
  });

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
    const buildNative: NonNullable<
      Parameters<typeof buildApplication>[0]
    >['buildNative'] = async () => {
      bundled = true;
      throw new Error('The bundler must not run.');
    };
    for (const outdir of ['', ' ', PACKAGE_DIRECTORY, join(PACKAGE_DIRECTORY, 'src')]) {
      const rejection = await buildApplication({
        outdir,
        buildNative,
        ensureGenerated: () => {},
      }).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
    }
    expect(bundled).toBe(false);
    expect(existsSync(join(PACKAGE_DIRECTORY, 'src', 'host', 'host.ts'))).toBe(true);
  });
});

describe('the build process entry', () => {
  const fakeBuild: typeof buildApplication = async () =>
    ({ directory: 'x', files: [], metafile: {} }) as unknown as Awaited<
      ReturnType<typeof buildApplication>
    >;

  it('builds and does not exit by itself when the parent is not watched', async () => {
    const exits: number[] = [];
    const lines: string[] = [];
    await runBuildMain(
      [],
      (code) => void exits.push(code),
      (line) => void lines.push(line),
      fakeBuild,
    );
    expect(exits).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it('exits 0 after a build that was asked to follow its parent, and 1 once standard input closes', async () => {
    const exits: number[] = [];
    let closeInput: () => void = () => {};
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        closeInput = () => controller.close();
      },
    });
    await runBuildMain(
      ['--exit-with-parent'],
      (code) => void exits.push(code),
      () => {},
      fakeBuild,
      input,
    );
    expect(exits).toEqual([0]);

    closeInput();
    await waitUntil(() => exits.length >= 2, { message: 'the second exit' });
    expect(exits).toEqual([0, 1]);
  });

  it('removes nothing and exits 1 when standard input closes with no build running', async () => {
    const exits: number[] = [];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    exitWhenStandardInputCloses(input, (code) => void exits.push(code));
    await waitUntil(() => exits.length >= 1, { message: 'the exit' });
    expect(exits).toEqual([1]);
  });
});
