import { expect, test } from 'bun:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

function artifactDirectory(): string {
  const directory = process.env['CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY'];
  if (!directory)
    throw new Error('Run bun scripts/verify-curated-build.ts to build this fixture first.');
  return directory;
}

const outputDirectory = artifactDirectory();

test('Vite curated Shiki fixture emits only configured language and theme candidates', async () => {
  const assets = await readdir(resolve(outputDirectory, 'assets'));
  const assetNames = assets.join('\n');
  expect(assetNames).toContain('typescript');
  expect(assetNames).toContain('github-light');
  expect(assetNames).not.toContain('javascript');
  expect(assetNames).not.toContain('github-dark');
  expect(assetNames).not.toContain('python');
  const styles = await Promise.all(
    assets
      .filter((asset) => asset.endsWith('.css'))
      .map((asset) => readFile(resolve(outputDirectory, 'assets', asset), 'utf8')),
  );
  const stylesheet = styles.join('\n');
  expect(stylesheet).toContain('.cinder-button');
  expect(stylesheet).not.toContain('.cinder-tree');
  const oversized = [];
  for (const asset of assets) {
    const metadata = await stat(resolve(outputDirectory, 'assets', asset));
    const size = metadata.size;
    if (size > 500 * 1024) oversized.push({ asset, size });
  }
  // The application emits the unchanged Oniguruma binary as a WASM asset.
  // No oversized base64 JavaScript chunk or unrelated stylesheet is needed.
  expect(assets.some((asset) => asset.endsWith('.wasm'))).toBe(true);
  expect(oversized).toHaveLength(0);
});
