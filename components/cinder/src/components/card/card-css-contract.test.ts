/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { parse, type AtRule } from 'postcss';

setupHappyDom();

describe('Card CSS contract', () => {
  test('default body uses the panel surface', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    expect(css).toMatch(/\.cinder-card__body\s*\{[^}]*background:\s*var\(--cinder-surface\)/s);
  });

  test('padding="none" targets only the body', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();

    expect(css).toContain(".cinder-card__body[data-cinder-padding='none']");
    expect(css).not.toContain(".cinder-card[data-cinder-padding='none']");
  });

  test('title uses the primary text token', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const titleBlock = css.match(/\.cinder-card__title\s*\{[^}]*\}/)?.[0] ?? '';
    expect(titleBlock).toContain('color: var(--cinder-text-default)');
    expect(titleBlock).not.toContain('color: var(--cinder-text-muted)');
  });

  test('well footer preserves an explicit muted tone', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();

    expect(css).toContain(".cinder-card__footer:not([data-cinder-tone='muted'])");
  });

  test('danger cards preserve explicit muted body and footer tones', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();

    expect(css).toContain(".cinder-card__body:not([data-cinder-tone='muted'])");
    expect(css).toContain(".cinder-card__footer:not([data-cinder-tone='muted'])");
  });

  test('danger tone paints the container surface, border, and icon', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const dangerBlock =
      css.match(/\.cinder-card\[data-cinder-tone='danger'\]\s*\{[^}]*\}/)?.[0] ?? '';
    const iconBlock = css.match(/\.cinder-card__risk-icon\s*\{[^}]*\}/)?.[0] ?? '';

    expect(dangerBlock).toContain('background');
    expect(dangerBlock).toContain('border-color');
    expect(dangerBlock).toContain('var(--cinder-status-danger-background)');
    expect(dangerBlock).toContain('var(--cinder-status-danger-border)');
    expect(css).toContain(".cinder-card[data-cinder-tone='danger'] > .cinder-card__header");
    expect(css).toContain(
      ".cinder-card[data-cinder-tone='danger'] > .cinder-card__header .cinder-card__title",
    );
    expect(css).toContain(".cinder-card[data-cinder-tone='danger'] > .cinder-card__footer");
    expect(iconBlock).toContain('var(--cinder-status-danger-text)');
  });

  test('a resting card draws a border and no shadow, and transitions border/shadow/background', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const baseBlock = css.match(/\.cinder-card\s*\{[^}]*\}/)?.[0] ?? '';
    expect(baseBlock).toContain('border: 1px solid var(--cinder-border)');
    expect(baseBlock).toContain('box-shadow: none');
    expect(baseBlock).toMatch(/transition:[^;]*border-color var\(--cinder-duration-fast\)/s);
    expect(baseBlock).toMatch(/transition:[^;]*box-shadow var\(--cinder-duration-fast\)/s);
    expect(baseBlock).toMatch(/transition:[^;]*background-color var\(--cinder-duration-fast\)/s);
  });

  test('hover strengthens only the edge the card has, under a hover-capable pointer', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const hoverSection = css.match(/@media \(hover: hover\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    const borderHover =
      hoverSection.match(
        /\.cinder-card\[data-cinder-edge='border'\]\[data-cinder-interactive\]:hover\s*\{[^}]*\}/,
      )?.[0] ?? '';
    const shadowHover =
      hoverSection.match(
        /\.cinder-card\[data-cinder-edge='shadow'\]\[data-cinder-interactive\]:hover\s*\{[^}]*\}/,
      )?.[0] ?? '';
    expect(borderHover).toContain('border-color: var(--cinder-border-strong)');
    expect(borderHover).not.toContain('box-shadow');
    expect(shadowHover).toContain('box-shadow: var(--cinder-shadow-md)');
    expect(shadowHover).not.toContain('border-color');
  });

  test('focus-visible paints the ring on the card for both the anchor and stretched-action cases', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const anchorFocusBlock =
      css.match(/\.cinder-card\[data-cinder-interactive\]:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
    const actionFocusBlock =
      css.match(
        /\.cinder-card\[data-cinder-interactive\]:has\(\.cinder-card__action:focus-visible\)\s*\{[^}]*\}/,
      )?.[0] ?? '';
    expect(anchorFocusBlock).toContain('var(--_cinder-focus-ring-shadow)');
    expect(actionFocusBlock).toContain('var(--_cinder-focus-ring-shadow)');
    // The stretched hit-target button itself must never show its own ring — the
    // parent .cinder-card owns it, so this case is visible on the card, not the control.
    const actionOwnRing = css.match(/\.cinder-card__action:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
    expect(actionOwnRing).toContain('outline: none');
  });

  test('a card never draws a border and a shadow together', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const root = parse(css);

    function declarations(selector: string): Map<string, string> {
      const found = new Map<string, string>();
      root.walkRules((rule) => {
        if (rule.parent?.type === 'atrule' && (rule.parent as AtRule).name === 'media') return;
        if (!rule.selectors.includes(selector)) return;
        rule.walkDecls((declaration) => {
          found.set(declaration.prop, declaration.value);
        });
      });
      return found;
    }

    const border = new Map([
      ...declarations('.cinder-card'),
      ...declarations(".cinder-card[data-cinder-edge='border']"),
    ]);
    const shadow = new Map([
      ...declarations('.cinder-card'),
      ...declarations(".cinder-card[data-cinder-edge='shadow']"),
    ]);

    // The border edge: a visible border and no shadow.
    expect(border.get('border')).toBe('1px solid var(--cinder-border)');
    expect(border.get('box-shadow')).toBe('none');
    // The shadow edge: a shadow and a transparent border (the 1px stays in the box).
    expect(shadow.get('box-shadow')).toBe('var(--cinder-shadow-sm)');
    expect(shadow.get('border-color')).toBe('transparent');
  });

  test('the shadow edge wins over the danger border colour', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const danger = css.indexOf(".cinder-card[data-cinder-tone='danger'] {");
    const shadowEdge = css.indexOf(".cinder-card[data-cinder-edge='shadow'] {");
    expect(danger).toBeGreaterThan(-1);
    expect(shadowEdge).toBeGreaterThan(danger);
  });

  test('the elevation range and its flat well/danger exceptions are gone', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    expect(css).not.toContain('data-cinder-elevation');
  });

  test('the header divider is opt-in', async () => {
    const css = await Bun.file(new URL('./card.css', import.meta.url)).text();
    const header = css.match(/\.cinder-card__header\s*\{[^}]*\}/)?.[0] ?? '';
    const divider =
      css.match(/\.cinder-card__header\[data-cinder-divider\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(header).not.toContain('border');
    expect(divider).toContain('border-bottom: 1px solid var(--cinder-border-muted)');
    expect(css).not.toMatch(
      /\.cinder-card\[data-cinder-tone='danger'\] > \.cinder-card__header\s*\{[^}]*border-bottom/s,
    );
  });
});
