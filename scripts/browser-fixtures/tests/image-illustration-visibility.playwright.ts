/**
 * CIN-61: the Image example's illustration must stay recognizable in both themes.
 *
 * An `<img>` renders its SVG as a separate document, so `currentColor` fills there
 * resolved to black rather than the host theme's foreground, and the sun and
 * mountains vanished into the dark theme's background. The illustration now carries
 * explicit opaque colors. This spec renders the `image` assertion fixture, which
 * must load the same illustration the playground's authored example does, and
 * samples the painted pixels in each theme at desktop and phone sizes.
 */
import { loadManifest, type Theme, type Viewport } from '@lostgradient/testing';
import { PNG } from 'pngjs';
import { expect, test } from './component-page-fixture.ts';

type Rgb = { r: number; g: number; b: number };

const authoredExampleUrl = new URL(
  '../../../applications/playground/src/examples/image/basic.example.svelte',
  import.meta.url,
);
const themes: Theme[] = ['light', 'dark'];
const viewports: Viewport[] = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
];
const background: Rgb = { r: 0xf1, g: 0xf5, b: 0xf9 };
const foreground: Rgb = { r: 0x0f, g: 0x17, b: 0x2a };
// Sample points in the illustration's own 600x338 coordinate space, each well inside
// its shape so `object-fit: cover` cropping and anti-aliasing cannot reach them.
const samples = {
  background: { x: 60, y: 40 },
  mountain: { x: 150, y: 300 },
  sun: { x: 455, y: 92 },
} as const;
const channelTolerance = 6;

function imageEntry() {
  const entry = loadManifest().find((candidate) => candidate.slug === 'image');
  if (entry === undefined) throw new Error('Missing image fixture entry.');
  const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (fixture === undefined) throw new Error('Missing image assertion fixture.');
  return { entry, fixture };
}

async function authoredIllustrationSource(): Promise<string> {
  const source = await Bun.file(authoredExampleUrl).text();
  const match = /"(data:image\/svg\+xml,[^"]+)"/.exec(source);
  if (match?.[1] === undefined) throw new Error('The authored Image example has no data URI.');
  return match[1];
}

function pixelAt(png: PNG, x: number, y: number): Rgb {
  const index = (png.width * Math.round(y) + Math.round(x)) << 2;
  return { r: png.data[index] ?? -1, g: png.data[index + 1] ?? -1, b: png.data[index + 2] ?? -1 };
}

function expectColor(actual: Rgb, expected: Rgb, label: string) {
  for (const channel of ['r', 'g', 'b'] as const) {
    expect(
      Math.abs(actual[channel] - expected[channel]),
      `${label} ${channel} channel: got ${JSON.stringify(actual)}`,
    ).toBeLessThanOrEqual(channelTolerance);
  }
}

for (const theme of themes) {
  for (const viewport of viewports) {
    test(`image illustration stays visible in ${theme} at ${viewport.width}x${viewport.height}`, async ({
      componentPage,
    }, testInfo) => {
      const { entry, fixture } = imageEntry();
      const page = await componentPage.open({
        entry,
        theme,
        viewport,
        fixtureName: fixture.name,
        fixtureContentHash: fixture.fixtureContentHash,
      });
      const root = page.locator('.cinder-image').first();
      await expect(root).toHaveAttribute('data-cinder-loaded', '');
      const image = root.locator('img');
      await expect(image).toHaveAttribute('alt', 'An illustration of mountains beneath a sun');

      const state = await image.evaluate((element: HTMLImageElement) => ({
        complete: element.complete,
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
        source: element.getAttribute('src'),
      }));
      expect(state).toEqual({
        complete: true,
        naturalWidth: 600,
        naturalHeight: 338,
        source: await authoredIllustrationSource(),
      });

      const capture = await image.screenshot();
      await testInfo.attach(`image-${theme}-${viewport.width}x${viewport.height}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      const png = PNG.sync.read(capture);
      const box = await image.boundingBox();
      if (box === null) throw new Error('The illustration has no rendered box.');
      // `object-fit: cover` scales by the larger ratio and centers the overflow.
      const scale = Math.max(box.width / 600, box.height / 338) * (png.width / box.width);
      const offsetX = (png.width - 600 * scale) / 2;
      const offsetY = (png.height - 338 * scale) / 2;
      const read = (point: { x: number; y: number }) =>
        pixelAt(png, offsetX + point.x * scale, offsetY + point.y * scale);

      expectColor(read(samples.background), background, 'background');
      expectColor(read(samples.mountain), foreground, 'mountain');
      expectColor(read(samples.sun), foreground, 'sun');
    });
  }
}
