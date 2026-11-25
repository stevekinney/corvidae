import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fileSystem from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CINDER_GENERATED_OUTPUTS, cinderGeneratedStaleness } from './ensure-cinder-generated.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'corvidae-ensure-cinder-'));
  directories.push(root);
  const cinder = join(root, 'components/cinder');
  const touch = (path: string, seconds: number) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    utimesSync(path, seconds, seconds);
  };
  touch(join(cinder, 'src/tokens/sets/colors.tokens.json'), 1_000);
  mkdirSync(join(cinder, 'scripts'), { recursive: true });
  touch(join(root, 'internal/component-tooling/scripts/generate.ts'), 1_000);
  touch(join(root, 'internal/component-tooling/src/schema.ts'), 1_000);
  touch(join(root, 'package.json'), 1_000);
  touch(join(root, 'bun.lock'), 1_000);
  touch(join(root, 'internal/component-tooling/package.json'), 1_000);
  touch(join(cinder, 'package.json'), 1_000);
  for (const output of CINDER_GENERATED_OUTPUTS) touch(join(cinder, output), 2_000);
  return cinder;
}

test('changed metadata tooling and root package inputs invalidate Cinder outputs', () => {
  for (const relative of [
    'internal/component-tooling/scripts/generate.ts',
    'internal/component-tooling/src/schema.ts',
    'internal/component-tooling/package.json',
    'components/cinder/package.json',
    'package.json',
    'bun.lock',
  ]) {
    const cinder = fixture();
    const root = join(cinder, '..', '..');
    utimesSync(join(root, relative), 3_000, 3_000);
    expect(cinderGeneratedStaleness(cinder)).toBe('an input is newer than the oldest output');
  }
});

test('reports a missing output and leaves fresh output current', () => {
  const cinder = fixture();
  expect(cinderGeneratedStaleness(cinder)).toBeUndefined();
  rmSync(join(cinder, 'src/tokens/resolved/dark.json'));
  expect(cinderGeneratedStaleness(cinder)).toContain('resolved/dark.json is missing');
});

test('an input newer than the oldest output is stale, and a test file is not an input', () => {
  const cinder = fixture();
  const input = join(cinder, 'src/tokens/sets/colors.tokens.json');
  utimesSync(input, 3_000, 3_000);
  expect(cinderGeneratedStaleness(cinder)).toBe('an input is newer than the oldest output');
  const test = join(cinder, 'src/tokens/sets/colors.test.ts');
  writeFileSync(test, '');
  utimesSync(input, 1_000, 1_000);
  utimesSync(test, 3_000, 3_000);
  expect(cinderGeneratedStaleness(cinder)).toBeUndefined();
});

test('a temporary input removed after listing does not abort the freshness check', () => {
  const cinder = fixture();
  const temporary = join(cinder, 'src/.forbidden-style-fixture.svelte');
  writeFileSync(temporary, '<style>p { color: red; }</style>');
  const stat = fileSystem.statSync;
  const read = spyOn(fileSystem, 'statSync').mockImplementation(((...args) => {
    if (args[0] === temporary) rmSync(temporary);
    return stat(...args);
  }) as typeof stat);
  try {
    expect(cinderGeneratedStaleness(cinder)).toBeUndefined();
    expect(read.mock.calls.some(([path]) => path === temporary)).toBe(true);
  } finally {
    read.mockRestore();
  }
});
