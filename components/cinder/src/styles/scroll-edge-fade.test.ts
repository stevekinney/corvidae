import { describe, expect, test } from 'bun:test';

const cssPath = `${import.meta.dir}/components/_scroll-edge-fade.css`;

async function readCss(): Promise<string> {
  return (await Bun.file(cssPath).text()).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('scroll edge fade', () => {
  test('is a mask over the scroller, so it works over any background', async () => {
    const css = await readCss();
    expect(css).toMatch(/mask-image:\s*linear-gradient/);
    expect(css).not.toMatch(/background\s*:/);
  });

  test('an edge is crisp until the attachment reports content past it', async () => {
    const css = await readCss();
    expect(css).toMatch(/--_cinder-edge-fade-start:\s*0px/);
    expect(css).toMatch(/--_cinder-edge-fade-end:\s*0px/);
    for (const attribute of [
      'data-cinder-overflows-start',
      'data-cinder-overflows',
      'data-cinder-overflows-inline-start',
      'data-cinder-overflows-inline-end',
    ]) {
      expect(css).toContain(`[${attribute}]`);
    }
  });

  test('the fade is one and a half lines and a focused item scrolls clear of it', async () => {
    const css = await readCss();
    expect(css).toContain('--_cinder-edge-fade-size: 1.5lh');
    expect(css).toMatch(/scroll-padding-block:\s*var\(--_cinder-edge-fade-size\)/);
    expect(css).toMatch(/scroll-padding-inline:\s*var\(--_cinder-edge-fade-size\)/);
  });

  test('the inline fade flips for right-to-left', async () => {
    const css = await readCss();
    expect(css).toMatch(/\[data-cinder-edge-fade='inline'\]:dir\(rtl\)\s*\{[^}]*to left/);
  });
});
