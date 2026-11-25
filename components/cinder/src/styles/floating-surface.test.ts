import { describe, expect, test } from 'bun:test';

describe('floating surface shared recipe', () => {
  test('base surface keeps overflow visible so arrows are not clipped', async () => {
    const css = await Bun.file(`${import.meta.dir}/components/_floating-surface.css`).text();

    expect(css).toMatch(/\.cinder-_floating-surface\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(css).toMatch(
      /\.cinder-_floating-surface:where\(\[role='listbox'\], \[role='menu'\]\)\s*\{[\s\S]*?overflow:\s*auto;[\s\S]*?scrollbar-gutter:\s*stable;/,
    );
  });

  test('preserves a usable docked sheet without covering an ordinary bottom bar', async () => {
    const css = await Bun.file(`${import.meta.dir}/components/_floating-surface.css`).text();

    expect(css).toMatch(/--_cinder-sheet-min-height:\s*16rem;/);
    expect(css).toMatch(
      /--_cinder-sheet-bottom:\s*min\(\s*var\(--_cinder-docked-action-bar-height, 0px\),\s*max\(10dvh, calc\(100dvh - var\(--_cinder-sheet-min-height\)\)\)\s*\);/,
    );
    expect(css).toMatch(
      /--_cinder-sheet-max-height:\s*min\(90dvh, max\(0px, 100dvh - var\(--_cinder-sheet-bottom\)\)\);/,
    );
  });
});
