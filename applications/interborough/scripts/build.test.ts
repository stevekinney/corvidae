/**
 * Tests for `scripts/build.ts`: the atomic directory swap and the clean-build check. The real
 * build, which bundles for seconds, is in `build.slow.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';

import {
  assertCleanBuild,
  BUILD_ASSET_DIRECTORY,
  replaceDirectory,
  retainPreviousAssets,
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
