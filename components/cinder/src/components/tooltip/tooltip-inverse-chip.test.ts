/**
 * COR-2010 (B02, rows 07r and 08b): in dark mode the tooltip is the light chip, so it separates
 * from raised popovers. The chip is the text ink, its text is the plain surface, and there is no
 * border to draw.
 */
import { describe, expect, test } from 'bun:test';

const tokens = await Bun.file(new URL('../../styles/tokens-base.css', import.meta.url)).text();

describe('tooltip inverse chip tokens', () => {
  test('surface-inverse is the text ink in both themes, never the raised surface', () => {
    const declarations = [...tokens.matchAll(/--cinder-surface-inverse:\s*([^;]+);/g)].map(
      (match) => match[1]!.trim(),
    );
    expect(declarations.length).toBe(3);
    for (const declaration of declarations) expect(declaration).toBe('var(--cinder-text-default)');
  });

  test('text-inverse is the plain surface, so the chip text is dark on the light chip', () => {
    const declarations = [...tokens.matchAll(/--cinder-text-inverse:\s*([^;]+);/g)].map((match) =>
      match[1]!.trim(),
    );
    for (const declaration of declarations) expect(declaration).toBe('var(--cinder-surface)');
  });

  test('border-inverse is transparent', () => {
    expect(tokens).toContain('--cinder-border-inverse: transparent;');
    expect(tokens).not.toContain('--cinder-border-inverse: var(--cinder-border-strong)');
  });
});

describe('tooltip text wrapping', () => {
  const stylesheet = Bun.file(new URL('./tooltip.css', import.meta.url)).text();

  test('a long label wraps inside the max width instead of running past the chip', async () => {
    const css = await stylesheet;
    const block = css.match(/\.cinder-tooltip\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).toContain('max-width: 16rem');
    expect(block).toContain('white-space: normal');
    expect(block).toContain('overflow-wrap: anywhere');
    expect(block).not.toContain('nowrap');
  });
});
