import { chromium } from '@playwright/test';
import { expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { environmentConfiguration } from '../../environment-configuration.ts';

function artifactDirectory(): string {
  const directory = environmentConfiguration().curatedHighlighterOutputDirectory;
  if (!directory)
    throw new Error('Run bun scripts/verify-curated-build.ts to build this fixture first.');
  return directory;
}

const outputDirectory = artifactDirectory();

test('the browser instantiates Oniguruma and renders highlighted TypeScript', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      return new Response(Bun.file(resolve(outputDirectory, pathname.slice(1) || 'index.html')));
    },
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
    });
    await page.goto(server.url.toString());
    await page.getByRole('button', { name: 'Highlight TypeScript' }).waitFor();
    expect(await page.locator('pre.shiki code').innerText()).toBe('const answer = 42;');
    expect(await page.locator('pre.shiki code span[style*="color"]').count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
});

test('Bun curated Shiki fixture emits only configured language and theme candidates', async () => {
  const assets = Array.from(
    new Bun.Glob('**/*').scanSync({ cwd: outputDirectory, absolute: true }),
  );
  const metadata = JSON.parse(
    await readFile(resolve(outputDirectory, 'metafile.json'), 'utf8'),
  ) as Bun.BuildMetafile;
  const emittedInputs = new Set(
    Object.values(metadata.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([path]) => path),
    ),
  );
  const languages = [...emittedInputs].filter((path) => path.includes('/@shikijs/langs/dist/'));
  const themes = [...emittedInputs].filter((path) => path.includes('/@shikijs/themes/dist/'));
  expect(languages.map((path) => path.split('/').at(-1))).toEqual(['typescript.mjs']);
  expect(themes.map((path) => path.split('/').at(-1))).toEqual(['github-light.mjs']);
  const styles = await Promise.all(
    assets.filter((asset) => asset.endsWith('.css')).map((asset) => readFile(asset, 'utf8')),
  );
  const stylesheet = styles.join('\n');
  expect(stylesheet).toContain('.cinder-button');
  expect(stylesheet).not.toContain('.cinder-tree');
  const oversized = [];
  for (const asset of assets) {
    const metadata = await stat(asset);
    const size = metadata.size;
    if (size > 500 * 1024) oversized.push({ asset, size });
  }
  // The application emits the unchanged Oniguruma binary as a WASM asset.
  // No oversized base64 JavaScript chunk or unrelated stylesheet is needed.
  expect(assets.some((asset) => asset.endsWith('.wasm'))).toBe(true);
  expect(oversized).toHaveLength(0);
});
