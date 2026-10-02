#!/usr/bin/env bun
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Renders `assets/icon.svg` into the `assets/icon.iconset` folder that
 * `electrobun.config.ts` points `build.mac.icons` at. Electrobun converts the
 * iconset to `.icns` with `iconutil` during `electrobun build`.
 *
 * Run it by hand after editing the SVG; the PNGs it writes are committed, so a
 * build never needs Inkscape. Each size is rendered from the vector source
 * rather than downscaled from the largest, which keeps the small sizes crisp.
 */
const projectRoot = path.dirname(import.meta.dir);
const source = path.join(projectRoot, 'assets', 'icon.svg');
const iconset = path.join(projectRoot, 'assets', 'icon.iconset');

/** The ten files `iconutil` expects in a macOS `.iconset`. */
const sizes = [16, 32, 128, 256, 512].flatMap((points) => [
  { name: `icon_${points}x${points}.png`, pixels: points },
  { name: `icon_${points}x${points}@2x.png`, pixels: points * 2 },
]);

await rm(iconset, { force: true, recursive: true });
await mkdir(iconset, { recursive: true });

for (const { name, pixels } of sizes) {
  const render = Bun.spawn(
    [
      'inkscape',
      source,
      '--export-type=png',
      `--export-filename=${path.join(iconset, name)}`,
      `--export-width=${pixels}`,
      `--export-height=${pixels}`,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  const exitCode = await render.exited;
  if (exitCode !== 0) {
    process.stderr.write(await new Response(render.stderr).text());
    throw new Error(`inkscape exited ${exitCode} while rendering ${name}`);
  }
}

console.log(`Rendered ${sizes.length} icon sizes into ${path.relative(projectRoot, iconset)}.`);
