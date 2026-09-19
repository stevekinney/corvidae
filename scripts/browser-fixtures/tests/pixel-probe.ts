import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';

export type Rgb = { r: number; g: number; b: number };
export type PositionedRgb = Rgb & { x: number; y: number };

const DEVICE_SCALE_FACTOR = 2;

function pixelAt(png: PNG, x: number, y: number): Rgb {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    throw new Error(
      `Sample point (${x}, ${y}) is outside the captured ${png.width}x${png.height} clip.`,
    );
  }
  const index = (png.width * y + x) << 2;
  const red = png.data[index];
  const green = png.data[index + 1];
  const blue = png.data[index + 2];
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Sample point (${x}, ${y}) has no complete pixel.`);
  }
  return { r: red, g: green, b: blue };
}

export async function readOnePixel(page: Page, point: { x: number; y: number }): Promise<Rgb> {
  const padding = 6;
  const clip = {
    x: point.x - padding,
    y: point.y - padding,
    width: padding * 2,
    height: padding * 2,
  };
  const png = PNG.sync.read(await page.screenshot({ clip }));
  return pixelAt(
    png,
    Math.round((point.x - clip.x) * DEVICE_SCALE_FACTOR),
    Math.round((point.y - clip.y) * DEVICE_SCALE_FACTOR),
  );
}

export async function readPixelRegion(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  padding = 2,
): Promise<PositionedRgb[]> {
  const clip = {
    x: Math.floor(box.x) - padding,
    y: Math.floor(box.y) - padding,
    width: Math.ceil(box.width) + padding * 2,
    height: Math.ceil(box.height) + padding * 2,
  };
  const png = PNG.sync.read(await page.screenshot({ clip }));
  const pixels: PositionedRgb[] = [];
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const color = pixelAt(png, x, y);
      pixels.push({
        ...color,
        x: clip.x + x / DEVICE_SCALE_FACTOR,
        y: clip.y + y / DEVICE_SCALE_FACTOR,
      });
    }
  }
  return pixels;
}
