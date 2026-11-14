/**
 * COR-2314: a Banner's actions stack under the message at every width, the message is capped at 68
 * characters, and a button label never wraps. happy-dom does not compute styles from stylesheets,
 * so the layout is pinned against the CSS source, as `callout.test.ts` does for Callout.
 */

import { describe, expect, test } from 'bun:test';

import { parse } from 'postcss';

import { declarationsFor } from '../../test/css.ts';

const css = await Bun.file(new URL('./banner.css', import.meta.url)).text();

describe('Banner layout', () => {
  test('the glyph, the message and the dismiss button share the first row of a grid', () => {
    const root = declarationsFor(css, '.cinder-banner');
    expect(root.get('display')).toBe('grid');
    expect(root.get('grid-template-columns')).toBe('auto minmax(0, 1fr) auto');
    expect(declarationsFor(css, '.cinder-banner__icon').get('grid-row')).toBe('1');
    expect(declarationsFor(css, '.cinder-banner__content').get('grid-row')).toBe('1');
    expect(declarationsFor(css, '.cinder-banner__dismiss').get('grid-row')).toBe('1');
  });

  test('the message is capped at 68ch', () => {
    expect(declarationsFor(css, '.cinder-banner__content').get('max-inline-size')).toBe('68ch');
  });

  test('the actions stack under the message in a row that wraps', () => {
    const actions = declarationsFor(css, '.cinder-banner__actions');
    expect(actions.get('grid-row')).toBe('2');
    expect(actions.get('grid-column')).toBe('2');
    expect(actions.get('display')).toBe('flex');
    expect(actions.get('flex-wrap')).toBe('wrap');
    expect(actions.get('margin-inline-start')).toBeUndefined();
  });

  // The ink is the letters: the line's own air (half of what its height leaves beside the
  // capitals) came off neither side, so the capitals stood about 17px under the top border and the
  // button 13px over the bottom one. Callout's round-one inset, applied to Banner.
  test('the capitals stand as far under the top border as the last ink stands over the bottom one', () => {
    const base = declarationsFor(css, '.cinder-banner');
    expect(base.get('--_cinder-banner-inset')).toBe('var(--cinder-space-3)');
    expect(base.get('padding-block')).toBe('var(--_cinder-banner-inset)');

    const ink = declarationsFor(css, ".cinder-banner:not([data-cinder-variant='feature'])");
    expect(ink.get('--_cinder-banner-first-air')).toBe('calc((1lh - 1cap) / 2)');
    expect(ink.get('--_cinder-banner-last-air')).toBe('calc((1lh - 1cap) / 2)');
    expect(ink.get('padding-block-start')).toBe(
      'calc(var(--_cinder-banner-inset) - var(--_cinder-banner-first-air))',
    );

    // With no action row the last ink is the text, so its air comes off the bottom too; an action
    // row ends in a button face, which has none to take out.
    const bare = declarationsFor(
      css,
      ".cinder-banner:not([data-cinder-variant='feature']):not(:has(> .cinder-banner__actions))",
    );
    expect(bare.get('padding-block-end')).toBe(
      'calc(var(--_cinder-banner-inset) - var(--_cinder-banner-last-air))',
    );

    expect(
      declarationsFor(
        css,
        ".cinder-banner:not([data-cinder-variant='feature']) > .cinder-banner__dismiss",
      ).get('margin-block-start'),
    ).toBe('var(--_cinder-banner-first-air)');
  });

  // A Banner that ends in a text link ("Change retention") has leading under the link's letters,
  // like any line of text, and kept 15px under the descender against 11px over the capitals.
  describe('a row of links', () => {
    const trimsBottomFor = (needle: string): boolean => {
      let found = false;
      parse(css).walkRules((rule) => {
        const selector = rule.selector.replace(/\s+/g, '');
        if (!selector.includes(needle)) return;
        rule.walkDecls('padding-block-end', (declaration) => {
          found =
            declaration.value ===
            'calc(var(--_cinder-banner-inset) - var(--_cinder-banner-last-air))';
        });
      });
      return found;
    };

    test('takes the air under the last baseline off the bottom inset, as a bare banner does', () => {
      expect(trimsBottomFor('>.cinder-banner__actions.cinder-link')).toBe(true);
    });

    test('keeps the inset whole when the row holds a button face, a field or a select', () => {
      let excluded = '';
      parse(css).walkRules((rule) => {
        const selector = rule.selector.replace(/\s+/g, '');
        if (selector.includes('>.cinder-banner__actions.cinder-link')) excluded = selector;
      });
      for (const box of ['button', 'input', 'select', 'textarea', '.cinder-button']) {
        expect(excluded).toContain(box);
      }
      expect(excluded).toContain(':not(:has(>.cinder-banner__actions:is(');
    });

    test('no rule trims the bottom for an action row on its own', () => {
      // The bare rule says there is no action row, and the link rule needs a link in it.
      const trimmed: string[] = [];
      parse(css).walkRules((rule) => {
        rule.walkDecls('padding-block-end', () => {
          trimmed.push(rule.selector.replace(/\s+/g, ''));
        });
      });
      expect(
        trimmed.filter((selector) => selector.includes('actions') && !selector.includes('link')),
      ).toEqual([
        ".cinder-banner:not([data-cinder-variant='feature']):not(:has(>.cinder-banner__actions))",
      ]);
    });
  });

  test('a button label never wraps', () => {
    for (const control of ['button', 'a']) {
      expect(declarationsFor(css, `.cinder-banner__actions ${control}`).get('white-space')).toBe(
        'nowrap',
      );
    }
  });
});
