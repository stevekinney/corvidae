import { expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createReviewsClientSources, outputDirectory } from './generate.ts';

it('generates the same committed bytes twice', async () => {
  const first = await createReviewsClientSources();
  const second = await createReviewsClientSources();
  expect([...first]).toEqual([...second]);
  expect((await readdir(outputDirectory)).toSorted()).toEqual([...first.keys()].toSorted());
  for (const [name, source] of first)
    expect(await Bun.file(join(outputDirectory, name)).text()).toBe(source);
});
