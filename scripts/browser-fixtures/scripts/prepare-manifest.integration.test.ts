import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { outcomeOf, rethrow } from '../../module-scope-scenario.test-support.ts';
import {
  defaultManifestLayout,
  hashManifestInputs,
  manifestInputFiles,
  manifestOutputPaths,
  prepareManifest,
  type ManifestLayout,
} from './prepare-manifest.ts';

const fixtureFile = (name: string) =>
  `export default [{ name: '${name}', props: { label: '${name}' } }];\n`;

// The command line is the behavior here, so its real process runs at module scope, off the
// per-test clock, through the hang guard. It reads the repository's own tree: the first run
// regenerates the outputs if they are stale, and the second must then leave them alone. The
// lane runs its files one at a time (no `--parallel`), so no sibling test reads the manifest while
// a stale first run rewrites it.
const commandLineOutcome = await outcomeOf(async () => {
  const script = resolve(import.meta.dirname, 'prepare-manifest.ts');
  const paths = manifestOutputPaths(defaultManifestLayout);
  const outputs = [paths.manifest, paths.moduleMap, paths.inputHash];
  const first = await runWithHangGuard([process.execPath, script]);
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  const before = await Promise.all(outputs.map((path) => stat(path)));
  const second = await runWithHangGuard([process.execPath, script]);
  expect(second.exitCode, second.stderr.toString()).toBe(0);
  expect(second.stdout.toString().trim()).toBe('manifest up to date');
  const after = await Promise.all(outputs.map((path) => stat(path)));
  expect(after.map((status) => status.mtimeMs)).toEqual(before.map((status) => status.mtimeMs));
});

test('the script run twice from the command line skips the second time', () =>
  rethrow(commandLineOutcome));

let directory: string;
let layout: ManifestLayout;
let logged: string[];
let restoreLog: () => void;

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await Bun.write(join(directory, path), contents);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'corvidae-prepare-manifest-'));
  await write('roots/cinder/widget/widget-fixtures.ts', fixtureFile('primary'));
  await write('roots/chat/pane/pane-fixtures.ts', fixtureFile('open'));
  await write('src/fixtures/panel.svelte', '<p>panel</p>\n');
  await write('code/rules.ts', 'export const rules = 1;\n');
  layout = {
    repositoryRoot: directory,
    fixtureRoots: [join(directory, 'roots/cinder'), join(directory, 'roots/chat')],
    sourceRoot: join(directory, 'src'),
    appFixtureRoot: join(directory, 'src/fixtures'),
    appFixtureDeclarations: { panel: ['assertion'] },
    codeInputs: ['code/*.ts'],
    outputDirectory: join(directory, '.playwright'),
  };
  logged = [];
  const spy = spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    logged.push(values.join(' '));
  });
  restoreLog = () => spy.mockRestore();
});

afterEach(async () => {
  restoreLog();
  await rm(directory, { recursive: true, force: true });
});

const outputPaths = () => Object.values(manifestOutputPaths(layout));
const longAgo = new Date('2000-01-01T00:00:00Z');

/** Dates every output long ago, so a rewrite shows as a newer modification time. */
async function ageOutputs(): Promise<void> {
  for (const path of outputPaths()) await utimes(path, longAgo, longAgo);
}

async function outputsAreUntouched(): Promise<boolean> {
  const statuses = await Promise.all(outputPaths().map((path) => stat(path)));
  return statuses.every((status) => status.mtimeMs === longAgo.getTime());
}

test('the first run writes the outputs and a hash of the inputs beside them', async () => {
  expect(await prepareManifest(layout)).toBe('prepared');
  const paths = manifestOutputPaths(layout);
  expect(await Bun.file(paths.inputHash).text()).toBe(`${await hashManifestInputs(layout)}\n`);
  expect(await Bun.file(paths.inputHash).text()).toMatch(/^[a-f0-9]{64}\n$/);
  const manifest = await Bun.file(paths.manifest).json();
  expect(manifest.entries.map((entry: { slug: string }) => entry.slug).toSorted()).toEqual([
    'pane',
    'panel',
    'widget',
  ]);
  expect(logged.join('\n')).toContain('prepared 3 fixture groups');
});

test('a second run on an unchanged tree reports the manifest current and rewrites nothing', async () => {
  await prepareManifest(layout);
  await ageOutputs();
  logged = [];
  expect(await prepareManifest(layout)).toBe('current');
  expect(logged).toEqual(['manifest up to date']);
  expect(await outputsAreUntouched()).toBe(true);
});

test.each([
  ['a fixture declaration changes', 'roots/cinder/widget/widget-fixtures.ts', fixtureFile('other')],
  ['a fixture declaration is added', 'roots/chat/extra/extra-fixtures.ts', fixtureFile('extra')],
  ['a host component is added', 'roots/cinder/widget/widget.fixture.svelte', '<p>host</p>\n'],
  ['an application fixture changes', 'src/fixtures/panel.svelte', '<p>changed</p>\n'],
  ['a code input changes', 'code/rules.ts', 'export const rules = 2;\n'],
  ['a code input is added', 'code/more.ts', 'export const more = 1;\n'],
])('regenerates once %s', async (_description, path, contents) => {
  await prepareManifest(layout);
  const before = await Bun.file(manifestOutputPaths(layout).inputHash).text();
  await write(path, contents);
  await ageOutputs();
  logged = [];
  expect(await prepareManifest(layout)).toBe('prepared');
  expect(logged.join('\n')).not.toContain('manifest up to date');
  expect(await outputsAreUntouched()).toBe(false);
  expect(await Bun.file(manifestOutputPaths(layout).inputHash).text()).not.toBe(before);
  // The new record vouches for the new tree.
  expect(await prepareManifest(layout)).toBe('current');
});

test('a changed fixture reaches the manifest, not only the record', async () => {
  await prepareManifest(layout);
  await write('roots/cinder/widget/widget-fixtures.ts', fixtureFile('renamed'));
  await prepareManifest(layout);
  const text = await Bun.file(manifestOutputPaths(layout).manifest).text();
  expect(text).toContain('renamed');
  expect(text).not.toContain('primary');
});

test('a removed input regenerates', async () => {
  await prepareManifest(layout);
  await rm(join(directory, 'roots/chat/pane/pane-fixtures.ts'));
  expect(await prepareManifest(layout)).toBe('prepared');
  expect(await Bun.file(manifestOutputPaths(layout).manifest).text()).not.toContain('"pane"');
});

test.each([
  ['missing', undefined],
  ['empty', ''],
  ['corrupt', 'not a digest\n'],
  ['truncated', '9b045ec2'],
])('a %s hash file regenerates', async (_description, contents) => {
  await prepareManifest(layout);
  const { inputHash } = manifestOutputPaths(layout);
  if (contents === undefined) await rm(inputHash);
  else await Bun.write(inputHash, contents);
  expect(await prepareManifest(layout)).toBe('prepared');
  expect(await Bun.file(inputHash).text()).toBe(`${await hashManifestInputs(layout)}\n`);
});

test.each(['manifest', 'moduleMap'] as const)(
  'a deleted %s regenerates although the hash file still matches',
  async (output) => {
    await prepareManifest(layout);
    const paths = manifestOutputPaths(layout);
    await rm(paths[output]);
    logged = [];
    expect(await prepareManifest(layout)).toBe('prepared');
    expect(logged.join('\n')).not.toContain('manifest up to date');
    expect(await Bun.file(paths[output]).exists()).toBe(true);
  },
);

test('a run that fails leaves no record, so reverting the input cannot read as current', async () => {
  await prepareManifest(layout);
  const original = await Bun.file(join(directory, 'roots/cinder/widget/widget-fixtures.ts')).text();
  await write('roots/cinder/widget/widget-fixtures.ts', 'export default notAnArray;\n');
  expect(await rejectionOf(prepareManifest(layout))).toBeInstanceOf(Error);
  expect(await Bun.file(manifestOutputPaths(layout).inputHash).exists()).toBe(false);
  await write('roots/cinder/widget/widget-fixtures.ts', original);
  expect(await prepareManifest(layout)).toBe('prepared');
});

test('an input pattern that matches nothing fails instead of hashing less', () => {
  expect(() => manifestInputFiles({ ...layout, codeInputs: ['code/missing.ts'] })).toThrow(
    /matches no file/,
  );
});

test('the hash depends on paths as well as contents', async () => {
  const before = await hashManifestInputs(layout);
  await rm(join(directory, 'code/rules.ts'));
  await write('code/renamed.ts', 'export const rules = 1;\n');
  expect(await hashManifestInputs(layout)).not.toBe(before);
});

test('every module the manifest code imports is among the inputs that are hashed', async () => {
  // Without this, a new import in `scripts/browser-fixtures/src/` or the extractor would change
  // the manifest while the hash, and so the skip, stayed blind to it.
  const inputs = new Set(manifestInputFiles(defaultManifestLayout));
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const missing: string[] = [];
  for (const path of inputs) {
    if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;
    for (const { path: specifier } of transpiler.scanImports(await Bun.file(path).text())) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(path), specifier);
      if (!inputs.has(target)) {
        missing.push(`${relative(defaultManifestLayout.repositoryRoot, path)} -> ${specifier}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
