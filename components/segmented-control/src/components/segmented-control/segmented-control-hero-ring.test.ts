import { describe, expect, test } from 'bun:test';

// COR-2445 AC6 (COR-2320 AC10): on the accent and night hero the segmented control's focus ring is
// at least 3:1 against the band (WCAG 1.4.11). The option reads a private ring hook, and the hero
// sets it to its white ring; the public ring token, indigo, is about 2.3:1 on the accent band.
const control = await Bun.file(new URL('./segmented-control.css', import.meta.url)).text();
const hero = await Bun.file(
  new URL('../../../../page-header/src/components/page-header/page-header.css', import.meta.url),
).text();

/** Relative luminance of an `oklch()` colour, through OKLab to linear sRGB. */
function luminance(lightness: number, chroma: number, hue: number): number {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const red = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s;
  const green = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s;
  const blue = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return 0.2126 * clamp(red) + 0.7152 * clamp(green) + 0.0722 * clamp(blue);
}

function contrast(first: number, second: number): number {
  const [light, dark] = first > second ? [first, second] : [second, first];
  return (light + 0.05) / (dark + 0.05);
}

const white = luminance(1, 0, 0);

describe('SegmentedControl focus ring on the hero', () => {
  test('every option ring reads the private hook, falling back to the public ring colour', () => {
    const rings = control.match(
      /var\(--cinder-ring-offset\) \+ var\(--cinder-ring-width\)\)\s*[^;]+;/g,
    );
    expect(rings?.length).toBeGreaterThanOrEqual(3);
    for (const ring of rings ?? []) {
      expect(ring).toContain('var(--_cinder-segmented-control-ring, var(--cinder-ring-color))');
    }
    expect(control).not.toMatch(/var\(--cinder-ring-width\)\)\s*var\(--cinder-ring-color\)/);
  });

  test('the accent and night bands set the hook to their white ring', () => {
    expect(hero).toMatch(
      /\.cinder-segmented-control \{\s*--_cinder-segmented-control-ring: var\(--_cinder-hero-ring\);/,
    );
    expect(hero).toMatch(/--_cinder-hero-ring: oklch\(100% 0 0\);/);
  });

  test('the white ring is at least 3:1 on the lightest stop of each band', () => {
    // The accent gradient's lighter stop and the night band's glow over its base, as declared.
    const accent = contrast(white, luminance(0.4, 0.19, 262));
    const glow = contrast(white, luminance(0.45, 0.17, 275));
    const night = contrast(white, luminance(0.17, 0.03, 275));
    expect(accent).toBeGreaterThanOrEqual(3);
    expect(glow).toBeGreaterThanOrEqual(3);
    expect(night).toBeGreaterThanOrEqual(3);
    // The stops the test reads are the ones the stylesheet declares.
    expect(hero).toContain('--_cinder-hero-from: oklch(40% 0.19 262)');
    expect(hero).toContain('--_cinder-hero-glow: oklch(45% 0.17 275 / 0.45)');
    expect(hero).toContain('--_cinder-hero-night: oklch(17% 0.03 275)');
  });
});
