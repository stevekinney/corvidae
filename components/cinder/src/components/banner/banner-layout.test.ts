/**
 * COR-2314: a Banner's actions stack under the message at every width, the message is capped at 68
 * characters, and a button label never wraps. happy-dom does not compute styles from stylesheets,
 * so the layout is pinned against the CSS source, as `callout.test.ts` does for Callout.
 */

import { describe, expect, test } from 'bun:test';

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

  test('a button label never wraps', () => {
    for (const control of ['button', 'a']) {
      expect(declarationsFor(css, `.cinder-banner__actions ${control}`).get('white-space')).toBe(
        'nowrap',
      );
    }
  });
});
