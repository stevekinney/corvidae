import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  createTemporaryDirectory,
  createTemporaryPath,
  removeTemporaryPath,
  uniqueFileName,
} from './temporary-path.ts';

const made: string[] = [];

afterEach(() => {
  for (const path of made.splice(0)) removeTemporaryPath(path);
});

function track(path: string): string {
  made.push(path);
  return path;
}

describe('createTemporaryPath', () => {
  it('returns a path that does not exist yet, inside a fresh directory under the temporary directory', () => {
    const path = track(createTemporaryPath('temporary-path-test', '.sqlite'));

    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(true);
    expect(relative(tmpdir(), path).startsWith('..')).toBe(false);
    expect(path.endsWith('.sqlite')).toBe(true);
  });

  it('never returns the path of another call, so a database an earlier run left is never reopened', () => {
    // The regression: names built from the process id plus a per-process counter repeat across
    // runs, so a later run opened the earlier run's file and inherited its rows.
    const first = track(createTemporaryPath('temporary-path-test', '.sqlite'));
    writeFileSync(first, 'rows left by an earlier run');
    const second = track(createTemporaryPath('temporary-path-test', '.sqlite'));

    expect(second).not.toBe(first);
    expect(dirname(second)).not.toBe(dirname(first));
    expect(existsSync(second)).toBe(false);
  });

  it('takes no part of its name from the process id', () => {
    const path = track(createTemporaryPath('temporary-path-test'));

    expect(path).not.toContain(`-${process.pid}-`);
    expect(path).not.toContain(`-${process.pid}.`);
  });
});

describe('removeTemporaryPath', () => {
  it('removes the database together with its write-ahead log and shared-memory files', () => {
    const path = createTemporaryPath('temporary-path-test', '.sqlite');
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(`${path}${suffix}`, 'x');

    removeTemporaryPath(path);

    expect(existsSync(dirname(path))).toBe(false);
  });

  it('removes a store that makes a directory of its own', () => {
    const path = createTemporaryPath('temporary-path-test');
    mkdirSync(join(path, 'nested'), { recursive: true });
    writeFileSync(join(path, 'nested', 'data.mdb'), 'x');

    removeTemporaryPath(path);

    expect(existsSync(dirname(path))).toBe(false);
  });

  it('is harmless to call twice', () => {
    const path = createTemporaryPath('temporary-path-test');

    removeTemporaryPath(path);

    expect(() => removeTemporaryPath(path)).not.toThrow();
  });

  it('refuses a path it did not hand out', () => {
    const directory = track(createTemporaryDirectory('temporary-path-test'));
    const stranger = join(directory, 'stranger');
    writeFileSync(stranger, 'x');

    expect(() => removeTemporaryPath(stranger)).toThrow('was not made by createTemporaryPath');
    expect(existsSync(stranger)).toBe(true);
  });
});

describe('createTemporaryDirectory', () => {
  it('makes a distinct existing directory on every call and removes it by its own path', () => {
    const first = createTemporaryDirectory('temporary-path-test');
    const second = createTemporaryDirectory('temporary-path-test');

    expect(first).not.toBe(second);
    expect(existsSync(first) && existsSync(second)).toBe(true);

    removeTemporaryPath(first);
    removeTemporaryPath(second);

    expect(existsSync(first) || existsSync(second)).toBe(false);
  });
});

describe('uniqueFileName', () => {
  it('names a file with a UUID and the extension, and differs on every call', () => {
    const names = new Set(Array.from({ length: 50 }, () => uniqueFileName('.ssr-test', '.mjs')));

    expect(names.size).toBe(50);
    for (const name of names) {
      expect(name).toMatch(/^\.ssr-test-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.mjs$/);
    }
  });
});
