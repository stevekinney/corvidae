import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { rejectionOf } from '../helpers/promise-outcome.ts';
import {
  hashManifestInputs,
  manifestInputFiles,
  manifestOutputPaths,
  prepareManifest,
  type ManifestLayout,
} from './prepare-manifest.ts';

const fixtureFile = (name: string) =>
  `export default [{ name: '${name}', props: { label: '${name}' } }];\n`;

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
    appFixtureRoots: [join(directory, 'src/fixtures')],
    appFixtureDeclarations: { panel: ['assertion'] },
    codeInputs: ['code/*.ts'],
    outputDirectory: join(directory, '.playwright'),
  };
  logged = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    logged.push(String(chunk).trimEnd());
    return true;
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
