/**
 * The catalog rows are handed to the Bureau as `models.catalog`, so no boot step plans against a
 * provider the configuration does not name. The test wraps `createBureau` to read the rows at the
 * moment the Bureau receives them, and the Bureau's own catalog once it exists.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Snapshot the real exports before mocking: Bun rebinds a live namespace when its module is
// mocked, and module mocks are process-wide, so the real module is restored after this file.
const actual = { ...(await import('@lostgradient/bureau')) };
const realCreateBureau = actual.createBureau;
const seenWhenCreated: { revision: number; pairs: string[]; sources: string[] }[] = [];

afterAll(() => {
  void mock.module('@lostgradient/bureau', () => actual);
});

void mock.module('@lostgradient/bureau', () => ({
  ...actual,
  createBureau: async (options: Parameters<typeof actual.createBureau>[0]) => {
    const rows = options.models?.catalog ?? [];
    const bureau = await realCreateBureau(options);
    const catalog = bureau.models.catalog();
    seenWhenCreated.push({
      revision: catalog.revision,
      pairs: rows.map((descriptor) => `${descriptor.provider}/${descriptor.model}`),
      sources: catalog.descriptors.map((descriptor) => descriptor.source),
    });
    return bureau;
  },
}));

const { startHost } = await import('./host.ts');

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the configured rows are the Bureau’s catalog from its first revision', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-order-'));
  directories.push(home);
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({ providers: { gemini: { models: ['pro'] } } }),
  );
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  bungalow.writeSecret('gemini-api-key', 'fixture-gemini-key');
  bungalow.close();

  seenWhenCreated.length = 0;
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  closers.push(() => host.close());

  expect(seenWhenCreated).toHaveLength(1);
  // Only the configured row, handed over as `models.catalog`, not the static seed.
  expect(seenWhenCreated[0]?.pairs).toEqual(['gemini/gemini-2.5-pro']);
  expect(seenWhenCreated[0]?.sources).toEqual(['operator-override']);
  expect(seenWhenCreated[0]?.revision).toBe(1);
});
