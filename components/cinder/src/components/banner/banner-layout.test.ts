/**
 * A Banner's actions sit at the inline end of the message row on a wide banner and drop under the
 * message below 560px of the banner's own width (owner decision 2026-11-13, reversing COR-2314's
 * actions-under-the-message at every width); the message is capped at 68 characters, and a button
 * label never wraps. happy-dom does not compute styles from stylesheets, so the layout is pinned
 * against the CSS source, as `callout.test.ts` does for Callout, and measured in a browser by
 * `scripts/browser-fixtures/tests/banner-actions-layout.playwright.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

import { declarationsFor } from '../../test/css.ts';

const css = await Bun.file(new URL('./banner.css', import.meta.url)).text();

/** The declarations of a rule nested in one at-rule, such as a container or media query. */
function atRuleDeclarations(name: string, params: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  parse(css).walkAtRules(name, (atRule) => {
    if (atRule.params !== params) return;
    atRule.walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, ' ').trim() !== selector) return;
      rule.walkDecls((declaration) => {
        found.set(declaration.prop, declaration.value);
      });
    });
  });
  return found;
}

describe('Banner layout', () => {
  test('the glyph, the message, the actions and the dismiss button share the first row', () => {
    const root = declarationsFor(css, '.cinder-banner');
    expect(root.get('display')).toBe('grid');
    expect(root.get('grid-template-columns')).toBe('auto minmax(0, 1fr) auto auto');
    expect(declarationsFor(css, '.cinder-banner__icon').get('grid-row')).toBe('1');
    expect(declarationsFor(css, '.cinder-banner__content').get('grid-row')).toBe('1');
    expect(declarationsFor(css, '.cinder-banner__dismiss').get('grid-row')).toBe('1');
  });

  test('the glyph is an inline box on the message baseline, centred on the capitals', () => {
    expect(declarationsFor(css, '.cinder-banner__icon').get('display')).toBe('block');
    expect(declarationsFor(css, '.cinder-banner__icon').get('block-size')).toBeUndefined();
    const glyph = declarationsFor(css, '.cinder-banner__icon > :where(svg)');
    expect(glyph.get('display')).toBe('inline-block');
    expect(glyph.get('block-size')).toBe('1rem');
    expect(glyph.get('vertical-align')).toBe('round(calc(0.5cap - 0.5rem), 1px)');
  });

  test('the message is capped at 68ch', () => {
    expect(declarationsFor(css, '.cinder-banner__content').get('max-inline-size')).toBe('68ch');
  });

  test('the banner is its own inline-size container, with a track for the trailing actions', () => {
    const root = declarationsFor(css, '.cinder-banner');
    expect(root.get('container-type')).toBe('inline-size');
    expect(root.get('container-name')).toBe('cinder-banner');
    expect(declarationsFor(css, '.cinder-banner__dismiss').get('grid-column')).toBe('4');
  });

  test('on a wide banner the actions sit at the inline end of the message row, on one line', () => {
    const actions = declarationsFor(css, '.cinder-banner > .cinder-banner__actions');
    expect(actions.get('grid-row')).toBe('1');
    expect(actions.get('grid-column')).toBe('3');
    expect(actions.get('display')).toBe('flex');
    expect(actions.get('flex-wrap')).toBe('nowrap');
    expect(actions.get('justify-self')).toBe('end');
    expect(actions.get('align-self')).toBe('center');
  });

  test('below 560px of its own width the actions drop under the message in a row that wraps', () => {
    const narrow = atRuleDeclarations(
      'container',
      'cinder-banner (max-width: 34.99rem)',
      '.cinder-banner > .cinder-banner__actions',
    );
    expect(narrow.get('grid-row')).toBe('2');
    expect(narrow.get('grid-column')).toBe('2');
    expect(narrow.get('flex-wrap')).toBe('wrap');
    expect(narrow.get('justify-self')).toBe('start');
    expect(narrow.get('margin-inline-start')).toBe('0');
  });

  test('stackActions puts each action on its own full-width line under the message on a phone', () => {
    const stacked = atRuleDeclarations(
      'media',
      '(max-width: 39.99rem)',
      ".cinder-banner > .cinder-banner__actions[data-cinder-stacked='true']",
    );
    expect(stacked.get('grid-row')).toBe('2');
    expect(stacked.get('grid-column')).toBe('2');
    expect(stacked.get('flex-direction')).toBe('column');
    expect(stacked.get('inline-size')).toBe('100%');
  });

  test('the feature variant takes the shared actions layout, not its own', () => {
    expect(css).not.toContain("[data-cinder-variant='feature'] > .cinder-banner__actions");
  });

  test('a button label never wraps', () => {
    for (const control of ['button', 'a']) {
      expect(declarationsFor(css, `.cinder-banner__actions ${control}`).get('white-space')).toBe(
        'nowrap',
      );
    }
  });
});
