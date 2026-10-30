import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { CHILD_FILE_STAGING_SUFFIX, publishChildFile, readChildJson } from './child-output-file';
import { createTemporaryDirectory, removeTemporaryPath } from './temporary-path';

const directories: string[] = [];
function scratchDirectory(): string {
  const directory = createTemporaryDirectory('child-output-file');
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) removeTemporaryPath(directory);
});

describe('publishChildFile and readChildJson', () => {
  it('round-trips a whole document and leaves no staging file behind', () => {
    const path = join(scratchDirectory(), 'marker.json');
    publishChildFile(path, JSON.stringify({ runId: 'run-1' }));
    publishChildFile(path, JSON.stringify({ runId: 'run-2' }));
    expect(readChildJson<{ runId: string }>(path)).toEqual({ runId: 'run-2' });
    expect(existsSync(`${path}${CHILD_FILE_STAGING_SUFFIX}`)).toBe(false);
  });

  it('keeps the path absent while the write is under way, so a reader sees all of it or none', async () => {
    const path = join(scratchDirectory(), 'marker.json');
    const text = JSON.stringify({ runId: 'run-1', padding: 'x'.repeat(4096) });
    const seenWhileStaged: Array<{ pathExists: boolean; stagedBytes: number }> = [];
    // The reader starts before the writer does and wakes only when the path appears, the way a
    // parent waiting on a crash child's marker does.
    const reader = waitUntil(() => existsSync(path), {
      message: 'the marker to be published',
    }).then(() => readChildJson<{ runId: string; padding: string }>(path));
    publishChildFile(path, text, {
      beforePublish: () => {
        seenWhileStaged.push({
          pathExists: existsSync(path),
          stagedBytes: readFileSync(`${path}${CHILD_FILE_STAGING_SUFFIX}`, 'utf8').length,
        });
      },
    });
    expect(seenWhileStaged).toEqual([{ pathExists: false, stagedBytes: text.length }]);
    expect(await reader).toEqual({ runId: 'run-1', padding: 'x'.repeat(4096) });
  });

  it('reports an empty file as incomplete instead of throwing a bare parse error', () => {
    const path = join(scratchDirectory(), 'marker.json');
    writeFileSync(path, '');
    expect(() => readChildJson(path)).toThrow(/is empty: it was read before it was complete/);
  });

  it('reports a truncated document as incomplete instead of parsing part of it', () => {
    const path = join(scratchDirectory(), 'marker.json');
    writeFileSync(path, '{"runId":"ru');
    expect(() => readChildJson(path)).toThrow(/\(12 bytes\) is not complete JSON/);
  });
});

describe('the crash-scenario children', () => {
  it('publish their output files through publishChildFile, never writeFileSync', () => {
    // A child that writes its marker with `writeFileSync` shows the parent an empty file on a loaded
    // host (COR-1928). Every child in this directory goes through `publishChildFile`.
    const root = import.meta.dir;
    const offenders: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          entry.name !== 'child-output-file.ts' &&
          /\bwriteFileSync\(/.test(readFileSync(path, 'utf8'))
        ) {
          offenders.push(relative(root, path));
        }
      }
    };
    visit(root);
    expect(offenders).toEqual([]);
  });
});
