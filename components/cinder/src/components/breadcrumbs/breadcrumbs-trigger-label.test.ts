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

/** The declarations of the top-level rule whose selector is exactly `selector`. */
function topLevelRule(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  parse(css).walkRules(selector, (rule) => {
    if (rule.parent?.type === 'atrule' && (rule.parent as { name?: string }).name !== 'layer') {
      return;
    }
    rule.walkDecls((declaration) => {
      found.set(declaration.prop, declaration.value);
    });
  });
  return found;
}

describe('Breadcrumbs item', () => {
  // The foundation's `:where(li)` bottom margin made the trail 4px taller than its words, so a bar
  // that centres the trail drew the crumbs 2px above its centre line (COR-2438).
  test('drops the foundation list item margin, so the trail is as tall as its words', async () => {
    expect(topLevelRule('.cinder-breadcrumbs__item').get('margin')).toBe('0');
    // The rule this guards against is still there, so the reset still matters.
    const foundation = parse(
      await Bun.file(new URL('../../styles/foundation.css', import.meta.url)).text(),
    );
    let listItemMargin = false;
    foundation.walkRules(':where(li)', (rule) => {
      rule.walkDecls('margin-bottom', () => {
        listItemMargin = true;
      });
    });
    expect(listItemMargin).toBe(true);
  });
});

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
