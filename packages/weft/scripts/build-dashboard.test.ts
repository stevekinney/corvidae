/**
 * Tests for `scripts/build-dashboard.ts`: the production dashboard it writes into the default
 * `dashboard/` directory, the Shiki grammars and themes that reach that output, and the size
 * budget.
 *
 * Every test that needs a real build shares one, made through the command-line entry, because
 * the output lands in the package's real `dashboard/` directory: building it from two places at
 * once would race. Nothing here asserts on how long the build takes.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DASHBOARD_BUILD_COMMAND, defaultDashboardDirectory } from '../src/server/dashboard.ts';
import { throwingRejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  assertCleanBuild,
  DASHBOARD_ASSET_DIRECTORY,
  DEFAULT_DASHBOARD_DIRECTORY,
  PACKAGE_DIRECTORY,
  readMetafileArgument,
  runBuildDashboardCommand,
  type DashboardBuild,
} from './build-dashboard.ts';
import { runCheckDashboardSizeCommand } from './check-dashboard-size.ts';

/** A real build takes seconds of bundling, and much longer on a loaded host. */
const BUILD_TIMEOUT_MS = 180_000;

const scratch = mkdtempSync(join(tmpdir(), 'weft-build-dashboard-'));
const metafilePath = join(scratch, 'metafile.json');
const commandLog: string[] = [];
let build: Promise<DashboardBuild> | undefined;

/** Build once, through the command line entry, for every test that needs the real output. */
function builtDashboard(): Promise<DashboardBuild> {
  build ??= runBuildDashboardCommand(['--metafile', metafilePath], (line) => {
    commandLog.push(line);
  });
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

describe('buildDashboard', () => {
  it('is the script the missing-build error from dashboard() tells you to run', () => {
    // `bun scripts/build-dashboard.ts`, run in the @lostgradient/weft package.
    const [runtime, script, ...rest] = DASHBOARD_BUILD_COMMAND.split(' ');
    expect(runtime).toBe('bun');
    expect(rest).toEqual([]);
    expect(join(PACKAGE_DIRECTORY, script ?? '')).toBe(join(import.meta.dir, 'build-dashboard.ts'));
  });

  it(
    'writes index.html and hashed JavaScript and CSS into the default dashboard directory',
    async () => {
      const result = await builtDashboard();

      expect(result.directory).toBe(DEFAULT_DASHBOARD_DIRECTORY);
      expect(DEFAULT_DASHBOARD_DIRECTORY).toBe(defaultDashboardDirectory());
      expect(result.files).toContain('index.html');
      const assets = result.files.filter((file) => file !== 'index.html');
      expect(assets.length).toBeGreaterThan(0);
      for (const file of assets) {
        expect(file).toMatch(
          new RegExp(`^${DASHBOARD_ASSET_DIRECTORY}/[^/]+-[a-z0-9]{8}\\.(?:js|css|wasm)$`),
        );
        expect(existsSync(join(result.directory, file)), file).toBe(true);
      }
      expect(assets.some((file) => file.endsWith('.js'))).toBe(true);
      expect(assets.some((file) => file.endsWith('.css'))).toBe(true);

      const html = await Bun.file(join(result.directory, 'index.html')).text();
      expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/[^"]+\.js">/);
      expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/);
      expect(html).not.toContain('main.ts');

      // The metafile goes where --metafile points, never into the budgeted directory.
      expect(result.files.some((file) => file.includes('metafile'))).toBe(false);
      expect(await Bun.file(metafilePath).json()).toEqual(result.metafile);
      expect(commandLog).toEqual([
        `Wrote the build metafile to ${metafilePath}`,
        `Built Weft's dashboard into ${DEFAULT_DASHBOARD_DIRECTORY} (${result.files.length} files)`,
      ]);
      // A successful build leaves no staging directory behind.
      expect(
        readdirSync(join(DEFAULT_DASHBOARD_DIRECTORY, '..')).filter((name) =>
          name.startsWith('.dashboard-build-'),
        ),
      ).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'emits exactly the grammars and themes the UI highlighter registers',
    async () => {
      const { metafile } = await builtDashboard();

      // `src/ui/lib/code-highlighter.ts` registers these two languages and two themes.
      expect(emittedModules(metafile, GRAMMAR_MODULE)).toEqual(['json', 'typescript']);
      expect(emittedModules(metafile, THEME_MODULE)).toEqual(['github-dark', 'github-light']);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'is within the size budget',
    async () => {
      await builtDashboard();
      const errors: string[] = [];
      const output = { log: (_line: string) => {}, error: (line: string) => errors.push(line) };

      expect(await runCheckDashboardSizeCommand([], output)).toBe(0);
      expect(errors).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );
});

describe('readMetafileArgument', () => {
  const directory = join(scratch, 'dashboard');

  it('is undefined without --metafile', () => {
    expect(readMetafileArgument([], directory)).toBeUndefined();
  });

  it('resolves a path outside the dashboard directory', () => {
    expect(readMetafileArgument(['--metafile', join(scratch, 'meta.json')], directory)).toBe(
      join(scratch, 'meta.json'),
    );
  });

  it('refuses a missing path', () => {
    expect(() => readMetafileArgument(['--metafile'], directory)).toThrow(
      '--metafile needs a path outside the dashboard directory',
    );
    expect(() => readMetafileArgument(['--metafile', '--other'], directory)).toThrow(
      '--metafile needs a path outside the dashboard directory',
    );
  });

  it('refuses a path inside the dashboard directory, before anything is built', async () => {
    expect(() =>
      readMetafileArgument(['--metafile', join(directory, 'metafile.json')], directory),
    ).toThrow(`--metafile must point outside ${directory}`);
    expect(() => readMetafileArgument(['--metafile', directory], directory)).toThrow(
      `--metafile must point outside ${directory}`,
    );
    // The command line entry checks against the default directory before it builds.
    expect(
      await throwingRejectionOf(
        runBuildDashboardCommand(['--metafile', join(DEFAULT_DASHBOARD_DIRECTORY, 'meta.json')]),
      ),
    ).toThrow(`--metafile must point outside ${DEFAULT_DASHBOARD_DIRECTORY}`);
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
