import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { warmSvelteTransforms } from './warm-svelte-transforms.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('reuses exact transforms while the linker observes changed resolution and source bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warm-transforms-'));
  directories.push(directory);
  const source = join(directory, 'fixture.svelte');
  const dependency = join(directory, 'dependency.js');
  const cache = join(directory, 'cache');
  await writeFile(source, '<script>import { marker } from "./dependency";</script><p>{marker}</p>');
  await writeFile(dependency, 'export const marker = "first";');
  const build = async () => {
    const transforms = await warmSvelteTransforms(cache);
    const result = await Bun.build({
      entrypoints: [source],
      target: 'browser',
      external: ['svelte', 'svelte/*'],
      plugins: [transforms.plugin],
    });
    return { result, statistics: transforms.statistics, text: await result.outputs[0]?.text() };
  };
  const cold = await build();
  const warm = await build();
  expect(cold.result.success).toBe(true);
  expect(cold.statistics).toEqual({ hits: 0, misses: 1 });
  expect(warm.statistics).toEqual({ hits: 1, misses: 0 });
  expect(warm.text).toBe(cold.text);
  // Bun prefers the new .ts shadow over .js; cached transforms must not freeze resolution.
  await writeFile(join(directory, 'dependency.ts'), 'export const marker = "shadow";');
  const shadow = await build();
  expect(shadow.statistics).toEqual({ hits: 1, misses: 0 });
  expect(shadow.text).toContain('shadow');
  const originalTimes = await Bun.file(source).stat();
  await writeFile(source, '<script>import { marker } from "./dependency";</script><b>{marker}</b>');
  await utimes(source, originalTimes.atime, originalTimes.mtime);
  const changed = await build();
  expect(changed.statistics).toEqual({ hits: 0, misses: 1 });
  expect(changed.text).not.toBe(shadow.text);
  const names = await readdir(cache);
  const entries = names.filter((name) => /^[a-f0-9]{64}$/.test(name));
  await Promise.all(entries.map((name) => writeFile(join(cache, name), '{')));
  const repaired = await build();
  expect(repaired.statistics).toEqual({ hits: 0, misses: 1 });
  expect(repaired.text).toBe(changed.text);
  const records = await Promise.all(
    entries.map(async (name) => ({ name, text: await readFile(join(cache, name), 'utf8') })),
  );
  const valid = records.find((entry) => entry.text !== '{');
  expect(valid).toBeDefined();
  await writeFile(
    join(cache, valid!.name),
    JSON.stringify({ contents: 'foreign', digest: 'wrong' }),
  );
  const foreign = await build();
  expect(foreign.statistics).toEqual({ hits: 0, misses: 1 });
  expect(foreign.text).toBe(changed.text);
});

test('concurrent builds publish complete entries and warnings remain failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warm-transforms-'));
  directories.push(directory);
  const source = join(directory, 'fixture.svelte');
  const cache = join(directory, 'cache');
  await writeFile(source, '<p>hello</p>');
  const build = async () => {
    const transforms = await warmSvelteTransforms(cache);
    return Bun.build({
      entrypoints: [source],
      target: 'browser',
      external: ['svelte', 'svelte/*'],
      plugins: [transforms.plugin],
    });
  };
  const results = await Promise.all([build(), build()]);
  expect(results.every((result) => result.success)).toBe(true);
  expect(await results[0].outputs[0]!.text()).toBe(await results[1].outputs[0]!.text());
  await writeFile(source, '<img src="image.png">');
  try {
    await build();
    throw new Error('Expected a compiler warning to fail the build');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect(
      (error as AggregateError).errors.some((entry: Error) =>
        entry.message.includes('Svelte compiler warnings'),
      ),
    ).toBe(true);
  }
});

test('a change in the executing compiler closure invalidates transforms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warm-transforms-'));
  directories.push(directory);
  const source = join(directory, 'fixture.svelte');
  const compiler = join(directory, 'compiler.ts');
  const cache = join(directory, 'cache');
  await writeFile(source, '<p>hello</p>');
  const setCompiler = (marker: string) =>
    writeFile(
      compiler,
      `export function compileComponent() { return { code: 'export default "${marker}"', map: null, warnings: [] }; }`,
    );
  const build = async () => {
    const transforms = await warmSvelteTransforms(cache, compiler);
    const result = await Bun.build({
      entrypoints: [source],
      target: 'browser',
      plugins: [transforms.plugin],
    });
    return { text: await result.outputs[0]!.text(), statistics: transforms.statistics };
  };
  await setCompiler('first');
  const first = await build();
  const warm = await build();
  expect(first.statistics.misses).toBe(1);
  expect(warm.statistics.hits).toBe(1);
  await setCompiler('second');
  const changed = await build();
  expect(changed.statistics).toEqual({ hits: 0, misses: 1 });
  expect(changed.text).toContain('second');
});
