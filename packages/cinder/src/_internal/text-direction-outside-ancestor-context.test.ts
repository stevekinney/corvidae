import { describe, expect, test } from 'bun:test';

import {
  createCssRule,
  createStyleRule,
  withComputedDirection,
  withDocumentStyleSheets,
} from './text-direction-test-helpers.ts';
import { elementDirectionStyleOverride, resolveTextDirection } from './text-direction.ts';

describe('resolveTextDirection', () => {
  test('general-sibling combinator (~) fails closed when no preceding sibling matches', () => {
    const wrapper = document.createElement('div');
    const nonMatching = document.createElement('div');
    const theme = document.createElement('section');
    theme.className = 'theme';
    const target = document.createElement('div');
    target.className = 'shell';
    theme.append(target);
    wrapper.append(nonMatching, theme);
    document.body.append(wrapper);
    const scopeRule = createCssRule({
      type: 0,
      cssText: '@scope (.theme) {}',
      cssRules: [createStyleRule({ selectorText: '.absent ~ :scope .shell', direction: 'ltr' })],
    });
    expect(
      withDocumentStyleSheets([{ cssRules: [scopeRule] }], () =>
        resolveTextDirection(target, 'rtl'),
      ),
    ).toBe('rtl');
    wrapper.remove();
  });

  test('evaluates each selector-list alternative independently around outside-ancestor context', () => {
    // `.shell, main :scope .other` — the SECOND alternative's `main`
    // outside-ancestor requirement must not gate the FIRST, unrelated
    // alternative. `.shell` matches the target directly regardless of
    // whether `main` is an ancestor of the scope root (it isn't, here).
    const theme = document.createElement('section');
    theme.className = 'theme';
    const target = document.createElement('div');
    target.className = 'shell';
    theme.append(target);
    document.body.append(theme);
    const scopeRule = createCssRule({
      type: 0,
      cssText: '@scope (.theme) {}',
      cssRules: [createStyleRule({ selectorText: '.shell, main :scope .other', direction: 'ltr' })],
    });
    expect(
      withDocumentStyleSheets([{ cssRules: [scopeRule] }], () =>
        resolveTextDirection(target, 'rtl'),
      ),
    ).toBe('ltr');
  });

  test('does not let a :scope nested inside :is() misread the selector as outside-ancestor context', () => {
    // `:is(main :scope .shell, .fallback)` — the `:scope` inside `:is()`
    // must not be treated as a TOP-LEVEL token: doing so slices `:is(main`
    // off as literal "outside-ancestor" text, which can never resolve
    // (`:is(main` isn't a real selector), losing the ordinary `.fallback`
    // alternative along with it.
    const theme = document.createElement('section');
    theme.className = 'theme';
    const target = document.createElement('div');
    target.className = 'fallback';
    theme.append(target);
    document.body.append(theme);
    const scopeRule = createCssRule({
      type: 0,
      cssText: '@scope (.theme) {}',
      cssRules: [
        createStyleRule({
          selectorText: ':is(main :scope .shell, .fallback)',
          direction: 'ltr',
        }),
      ],
    });
    expect(
      withDocumentStyleSheets([{ cssRules: [scopeRule] }], () =>
        resolveTextDirection(target, 'rtl'),
      ),
    ).toBe('ltr');
  });

  test('resolves a native CSS nesting parent selector before matching direction rules', () => {
    const originalWindowGetComputedStyle = window.getComputedStyle;
    const originalGlobalGetComputedStyle = globalThis.getComputedStyle;
    const getComputedStyleOverride = ((target: Element) => {
      let style = originalWindowGetComputedStyle(target);
      style = withComputedDirection(style, 'ltr');
      return style;
    }) as typeof window.getComputedStyle;
    window.getComputedStyle = getComputedStyleOverride;
    globalThis.getComputedStyle = getComputedStyleOverride;

    try {
      const shell = document.createElement('section');
      shell.className = 'nested-shell';
      const element = document.createElement('div');
      element.className = 'nested-menu';
      shell.appendChild(element);
      document.body.appendChild(shell);

      const nestedRule = createStyleRule({ selectorText: '& .nested-menu', direction: 'ltr' });
      const outerRule = createStyleRule({ selectorText: '.nested-shell', cssRules: [nestedRule] });
      Object.defineProperty(nestedRule, 'parentRule', { configurable: true, value: outerRule });

      expect(
        withDocumentStyleSheets([{ cssRules: [outerRule] }], () =>
          elementDirectionStyleOverride(element),
        ),
      ).toBe('ltr');
    } finally {
      window.getComputedStyle = originalWindowGetComputedStyle;
      globalThis.getComputedStyle = originalGlobalGetComputedStyle;
    }
  });
  test('resolves multiple native CSS nesting parent selectors', () => {
    const originalWindowGetComputedStyle = window.getComputedStyle;
    const originalGlobalGetComputedStyle = globalThis.getComputedStyle;
    const getComputedStyleOverride = ((target: Element) => {
      let style = originalWindowGetComputedStyle(target);
      style = withComputedDirection(style, 'ltr');
      return style;
    }) as typeof window.getComputedStyle;
    window.getComputedStyle = getComputedStyleOverride;
    globalThis.getComputedStyle = getComputedStyleOverride;

    try {
      const shell = document.createElement('section');
      shell.className = 'multi-nested-shell';
      const region = document.createElement('div');
      region.className = 'multi-nested-region';
      const element = document.createElement('div');
      element.className = 'multi-nested-menu';
      region.appendChild(element);
      shell.appendChild(region);
      document.body.appendChild(shell);

      const innerRule = createStyleRule({ selectorText: '& .multi-nested-menu', direction: 'ltr' });
      const middleRule = createStyleRule({
        selectorText: '& .multi-nested-region',
        cssRules: [innerRule],
      });
      const outerRule = createStyleRule({
        selectorText: '.multi-nested-shell',
        cssRules: [middleRule],
      });
      Object.defineProperty(innerRule, 'parentRule', { configurable: true, value: middleRule });
      Object.defineProperty(middleRule, 'parentRule', { configurable: true, value: outerRule });

      expect(
        withDocumentStyleSheets([{ cssRules: [outerRule] }], () =>
          elementDirectionStyleOverride(element),
        ),
      ).toBe('ltr');
    } finally {
      window.getComputedStyle = originalWindowGetComputedStyle;
      globalThis.getComputedStyle = originalGlobalGetComputedStyle;
    }
  });

  test('walks through conditional rules to the nearest nested style parent', () => {
    const originalWindowGetComputedStyle = window.getComputedStyle;
    const originalGlobalGetComputedStyle = globalThis.getComputedStyle;
    const getComputedStyleOverride = ((target: Element) => {
      let style = originalWindowGetComputedStyle(target);
      style = withComputedDirection(style, 'ltr');
      return style;
    }) as typeof window.getComputedStyle;
    window.getComputedStyle = getComputedStyleOverride;
    globalThis.getComputedStyle = getComputedStyleOverride;

    try {
      const shell = document.createElement('section');
      shell.className = 'conditional-nested-shell';
      const element = document.createElement('div');
      element.className = 'conditional-nested-menu';
      shell.appendChild(element);
      document.body.appendChild(shell);

      const nestedRule = createStyleRule({
        selectorText: '& .conditional-nested-menu',
        direction: 'ltr',
      });
      const mediaRule = createCssRule({
        cssText: '@media all {}',
        type: 4,
        conditionText: 'all',
        cssRules: [nestedRule],
      });
      const outerRule = createStyleRule({
        selectorText: '.conditional-nested-shell',
        cssRules: [mediaRule],
      });
      Object.defineProperty(nestedRule, 'parentRule', { configurable: true, value: mediaRule });
      Object.defineProperty(mediaRule, 'parentRule', { configurable: true, value: outerRule });

      expect(
        withDocumentStyleSheets([{ cssRules: [outerRule] }], () =>
          elementDirectionStyleOverride(element),
        ),
      ).toBe('ltr');
    } finally {
      window.getComputedStyle = originalWindowGetComputedStyle;
      globalThis.getComputedStyle = originalGlobalGetComputedStyle;
    }
  });
});
