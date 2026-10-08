import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { throwingRejectionOf } from '@lostgradient/testing';

import {
  createSvelteCompileCache,
  type CompiledSvelteModule,
  type SvelteCompileKey,
} from './svelte-compile-cache.ts';

let directory: string;
const warnings: string[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'svelte-compile-cache-'));
  warnings.length = 0;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function cacheWith(compilerFingerprint = 'compiler-1', cacheDirectory = directory) {
  return createSvelteCompileCache({
    directory: cacheDirectory,
    compilerFingerprint,
    warn: (message) => warnings.push(message),
  });
}

/** A compile function that counts how often the real compiler would have run. */
function countingCompiler(output = 'compiled') {
  const state = { calls: 0 };
  return {
    state,
    compile: (path = '/work/card.svelte'): CompiledSvelteModule => {
      state.calls += 1;
      return { contents: output, loader: 'js', resolveDir: dirname(path) };
    },
  };
}

const KEY: SvelteCompileKey = {
  path: '/work/card.svelte',
  source: '<p>card</p>',
  variant: 'server:css:prod',
};

function entryFiles(): string[] {
  return readdirSync(directory).filter((name) => !name.endsWith('.tmp'));
}

describe('createSvelteCompileCache', () => {
  it('compiles once and serves the stored output for the same source, path, and variant', async () => {
    const cache = cacheWith();
    const compiler = countingCompiler('first output');

    const first = await cache.compile(KEY, () => compiler.compile());
    const second = await cache.compile(KEY, () => compiler.compile());

    expect(compiler.state.calls).toBe(1);
    expect(second).toEqual(first);
    expect(second).toEqual({ contents: 'first output', loader: 'js', resolveDir: '/work' });
  });

  it('serves a hit to a different cache instance on the same directory, as a fresh process would', async () => {
    const compiler = countingCompiler('shared output');
    await cacheWith().compile(KEY, () => compiler.compile());

    const result = await cacheWith().compile(KEY, () => compiler.compile());

    expect(compiler.state.calls).toBe(1);
    expect(result.contents).toBe('shared output');
  });

  it('recompiles when the source changes, and keeps one entry per file and variant', async () => {
    const cache = cacheWith();
    const compiler = countingCompiler();

    await cache.compile(KEY, () => compiler.compile());
    await cache.compile({ ...KEY, source: '<p>edited</p>' }, () => compiler.compile());
    await cache.compile({ ...KEY, source: '<p>edited again</p>' }, () => compiler.compile());

    expect(compiler.state.calls).toBe(3);
    // The directory is bounded by the files compiled, not by the edits made to them.
    expect(entryFiles()).toHaveLength(1);
  });

  it('keeps a separate entry for every variant of the same file', async () => {
    const cache = cacheWith();
    const compiler = countingCompiler();
    const variants = ['server:css:prod', 'server:css:dev', 'server:nocss:prod', 'client:css:prod'];

    for (const variant of variants)
      await cache.compile({ ...KEY, variant }, () => compiler.compile());
    for (const variant of variants)
      await cache.compile({ ...KEY, variant }, () => compiler.compile());

    expect(compiler.state.calls).toBe(variants.length);
    expect(entryFiles()).toHaveLength(variants.length);
  });

  it('keeps a separate entry for every path', async () => {
    const cache = cacheWith();
    const compiler = countingCompiler();

    await cache.compile(KEY, () => compiler.compile());
    await cache.compile({ ...KEY, path: '/work/other.svelte' }, () => compiler.compile());
    await cache.compile(KEY, () => compiler.compile());

    expect(compiler.state.calls).toBe(2);
  });

  it('recompiles when the compiler fingerprint changes, so a new Svelte or plugin never reads old output', async () => {
    const compiler = countingCompiler();
    await cacheWith('svelte-5.57.0').compile(KEY, () => compiler.compile());

    await cacheWith('svelte-5.58.0').compile(KEY, () => compiler.compile());

    expect(compiler.state.calls).toBe(2);
  });

  it('treats a truncated or foreign entry as a miss and replaces it', async () => {
    const cache = cacheWith();
    const compiler = countingCompiler('good output');
    await cache.compile(KEY, () => compiler.compile());
    const [entry] = entryFiles();
    writeFileSync(join(directory, entry!), 'not an entry at all');

    const healed = await cache.compile(KEY, () => compiler.compile());
    const again = await cache.compile(KEY, () => compiler.compile());

    expect(compiler.state.calls).toBe(2);
    expect(healed.contents).toBe('good output');
    expect(again.contents).toBe('good output');
  });

  it('does not store a compile that throws, and the next attempt compiles again', async () => {
    const cache = cacheWith();
    let calls = 0;
    const failing = (): CompiledSvelteModule => {
      calls += 1;
      throw new Error('compile error');
    };

    expect(await throwingRejectionOf(cache.compile(KEY, failing))).toThrow('compile error');
    expect(await throwingRejectionOf(cache.compile(KEY, failing))).toThrow('compile error');

    expect(calls).toBe(2);
    expect(entryFiles()).toEqual([]);
  });

  it('never leaves a half-written entry behind when many processes store the same file at once', async () => {
    const compiler = countingCompiler('x'.repeat(50_000));

    const results = await Promise.all(
      Array.from({ length: 24 }, () => cacheWith().compile(KEY, () => compiler.compile())),
    );

    expect(new Set(results.map((result) => result.contents)).size).toBe(1);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const afterwards = countingCompiler('unused');
    const hit = await cacheWith().compile(KEY, () => afterwards.compile());
    expect(afterwards.state.calls).toBe(0);
    expect(hit.contents).toBe('x'.repeat(50_000));
  });

  it('still returns the compiled output, and says so once, when the directory cannot be written', async () => {
    const blocker = join(directory, 'blocker');
    writeFileSync(blocker, 'a file where the cache directory should be');
    const cache = cacheWith('compiler-1', join(blocker, 'cache'));
    const compiler = countingCompiler('uncached output');

    const first = await cache.compile(KEY, () => compiler.compile());
    const second = await cache.compile({ ...KEY, path: '/work/other.svelte' }, () =>
      compiler.compile('/work/other.svelte'),
    );

    expect(first.contents).toBe('uncached output');
    expect(second.contents).toBe('uncached output');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Svelte compile cache');
  });

  it('creates its directory on first use', async () => {
    const nested = join(directory, 'nested', 'cache');
    mkdirSync(dirname(nested), { recursive: true });
    const compiler = countingCompiler();

    await cacheWith('compiler-1', nested).compile(KEY, () => compiler.compile());

    expect(readdirSync(nested)).toHaveLength(1);
  });
});
