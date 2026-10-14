import { expect, test } from 'bun:test';
import { join } from 'node:path';

type TurboTask = { readonly outputs?: readonly string[]; readonly dependsOn?: readonly string[] };

const turbo = JSON.parse(
  await Bun.file(join(import.meta.dir, '../../../../turbo.json')).text(),
) as { readonly tasks: Record<string, TurboTask> };

/**
 * The cleanup evidence test writes `test-results/cleanup.json`. A cache hit replays only declared
 * outputs, so a task that omits them skips the write and leaves the evidence stale or missing.
 */
for (const task of ['test', 'test:coverage']) {
  test(`@lostgradient/ventriloquist#${task} caches the cleanup evidence it writes`, () => {
    const definition = turbo.tasks[`@lostgradient/ventriloquist#${task}`];
    expect(definition?.outputs).toContain('test-results/**');
    expect(definition?.dependsOn).toContain('transit');
  });
}
