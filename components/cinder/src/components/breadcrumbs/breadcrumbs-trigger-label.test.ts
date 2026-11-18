/**
 * The title switcher's label is centred on its capitals, not on its line box. A line box with a
 * fractional height (1.15 of 14px) puts the capitals about 1.5px above the middle of the 30px
 * trigger in Chromium, so where `text-box-trim` ships the label is trimmed to its capitals and
 * baseline and given clip room for ascenders and descenders. There is no layout engine here, so
 * these pin the declarations; the captures at 320 and 375 show the result.
 */
import { describe, expect, test } from 'bun:test';

import { parse } from 'postcss';

const css = await Bun.file(new URL('./breadcrumbs.css', import.meta.url)).text();

/** The declarations the label gets inside `@supports (text-box-trim: trim-both)`. */
function trimmedLabel(): Map<string, string> {
  const found = new Map<string, string>();
  parse(css).walkAtRules('supports', (atRule) => {
    if (atRule.params.replaceAll(/\s+/g, '') !== '(text-box-trim:trim-both)') return;
    atRule.walkRules('.cinder-breadcrumbs__trigger-label', (rule) => {
      rule.walkDecls((declaration) => {
        found.set(declaration.prop, declaration.value);
      });
    });
  });
  return found;
}

describe('Breadcrumbs title switcher label', () => {
  test('is trimmed to its capitals and baseline where text-box-trim ships', () => {
    expect(trimmedLabel().get('text-box')).toBe('trim-both cap alphabetic');
  });

  test('keeps room for ascenders and descenders inside its clip, and gives it back to layout', () => {
    const rule = trimmedLabel();
    expect(rule.get('padding-block')).toBe('0.25em');
    expect(rule.get('margin-block')).toBe('-0.25em');
  });
});
