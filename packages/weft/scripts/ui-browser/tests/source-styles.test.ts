import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const expectedImportedSelectors = [
  '.weft-shell',
  '.weft-dashboard',
  '.weft-workflow-list__header-actions',
  '.weft-workers-route',
  '.weft-reviews-route',
  '.weft-storage-route',
];

test('source styles compile without discarded imports or other CSS warnings', async () => {
  const filename = fileURLToPath(new URL('../../../src/ui/styles/index.css', import.meta.url));
  const outputDirectory = await mkdtemp(`${tmpdir()}/weft-ui-css-`);
  try {
    const result = await Bun.build({
      entrypoints: [filename],
      outdir: outputDirectory,
      target: 'browser',
      metafile: true,
    });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    const stylesheet = result.outputs.find((output) => output.path.endsWith('.css'));
    expect(stylesheet).toBeDefined();
    if (stylesheet === undefined) throw new Error('Expected Bun to emit a stylesheet.');
    const stylesheetText = await Bun.file(stylesheet.path).text();
    for (const selector of expectedImportedSelectors) {
      expect(stylesheetText).toContain(selector);
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
