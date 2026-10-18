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

import { assertCleanBuild, replaceDirectory } from './build.ts';

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
