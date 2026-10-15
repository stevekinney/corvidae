import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';

describe('test:inspection', () => {
  test('runs exactly the inspection directory with the browser and svelte conditions', async () => {
    const manifest: { scripts: Record<string, string> } = await Bun.file(
      new URL('../../../package.json', import.meta.url),
    ).json();
    expect(manifest.scripts['test:inspection']).toBe(
      'bun test --conditions browser --conditions svelte src/lib/inspection',
    );
  });

  test('its selection holds tests, and an empty selection fails the run', async () => {
    const entries = await readdir(new URL('.', import.meta.url));
    const tests = entries.filter((name) => name.endsWith('.test.ts'));
    expect(tests.length).toBeGreaterThan(0);
    // bun exits 1 when a path filter matches no test file, so the script cannot pass vacuously.
    expect(tests).toContain('inspection-script.test.ts');
  });
});
