/**
 * COR-2010 (B02, rows 07q and 08f): the skeleton fill is `--cinder-skeleton-background`, which is
 * the inset in light mode and the raised surface in dark mode, never the plain surface, so a bar
 * inside a card stays visible in dark.
 */
import { describe, expect, test } from 'bun:test';

const skeletonCss = await Bun.file(new URL('./skeleton.css', import.meta.url)).text();
const tokens = await Bun.file(new URL('../../styles/tokens-base.css', import.meta.url)).text();

describe('skeleton fill token', () => {
  test('the token is light-dark(inset, raised) at :root', () => {
    expect(tokens.replace(/\s+/g, ' ')).toContain(
      '--cinder-skeleton-background: light-dark( var(--cinder-surface-inset), var(--cinder-surface-raised) );',
    );
  });

  test('the scoped blocks carry the matching arm', () => {
    expect(tokens).toContain('--cinder-skeleton-background: var(--cinder-surface-inset);');
    expect(tokens).toContain('--cinder-skeleton-background: var(--cinder-surface-raised);');
  });

  test('every bar paints the token, including the reduced-motion fallbacks', () => {
    // The inset may only tint the list's day band as a mix with the surface; no rule paints it
    // as a plain background, which would hide a bar (the bars paint the inset in light mode).
    expect(skeletonCss).not.toContain('background: var(--cinder-surface-inset)');
    expect(skeletonCss).not.toContain('background-color: var(--cinder-surface-inset)');
    expect(
      skeletonCss.match(/var\(--cinder-skeleton-background\)/g)?.length,
    ).toBeGreaterThanOrEqual(4);
  });

  test('a card-variant ground is the plain surface, so the raised-colored bars stay visible', () => {
    const card = skeletonCss.match(
      /data-cinder-variant='card'\] > \.cinder-skeleton-lines \{[^}]*\}/,
    );
    expect(card?.[0]).toContain('background: var(--cinder-surface);');
  });
});
