/**
 * The skeleton fill is `--cinder-skeleton-background`, a 12% alpha step over the border ink in both
 * themes, so a bar is the same visible step over any surface it sits on. It replaced an opaque
 * surface fill (the inset in light, raised in dark) that vanished on a ground of its own colour:
 * light bars on the surface a list or card body paints, dark bars on a raised statistic card.
 */
import { describe, expect, test } from 'bun:test';

const skeletonCss = await Bun.file(new URL('./skeleton.css', import.meta.url)).text();
const tokens = await Bun.file(new URL('../../styles/tokens-base.css', import.meta.url)).text();

const INK_STEP =
  '--cinder-skeleton-background: color-mix(in oklch, var(--cinder-border-ink), transparent 88%);';

describe('skeleton fill token', () => {
  test('the token is an ink step at :root and in every scoped theme block', () => {
    const flat = tokens.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
    // :root, [data-theme='dark'] and [data-theme='light'] all carry the same recipe.
    expect(flat.split(INK_STEP).length - 1).toBeGreaterThanOrEqual(3);
    expect(tokens).not.toContain('--cinder-skeleton-background: var(--cinder-surface');
  });

  test('every bar paints the token, including the reduced-motion fallbacks', () => {
    expect(
      skeletonCss.match(/var\(--cinder-skeleton-background\)/g)?.length,
    ).toBeGreaterThanOrEqual(4);
  });

  test('no component overrides the fill with a private one', () => {
    expect(skeletonCss).not.toContain('--_cinder-skeleton-fill');
  });
});

describe('skeleton list rows with no status word', () => {
  test('keep the marker beside the text in a narrow container (row 76x): it is the row leading cell, not the status', async () => {
    // The row's own layout keeps a leading cell beside the title at every width, and only a status
    // moves to line two, so the placeholder borrows that instead of a container query of its own.
    const markup = await Bun.file(new URL('./skeleton.svelte', import.meta.url)).text();
    expect(markup).toContain(
      '<div class="cinder-stacked-list-item__leading cinder-skeleton-row-status">',
    );
    expect(markup).toContain("!statusColumn && 'cinder-stacked-list-item--has-leading'");
    expect(skeletonCss).not.toContain('@container cinder-skeleton (');
  });
});
