/**
 * Regression test for the command-item active row: a soft accent tint with the label's own color
 * (row 03c), and the keyboard-cursor ring (WCAG 1.4.11) that comes from the shared row rule.
 *
 * The tint is too pale to be a cursor boundary on its own, so the inset `--cinder-ring-color` ring
 * of `_row-item.css` must keep applying to the active row. This file is parser-only: it pins the CSS
 * *declarations* (the tint, the unchanged text color, no `box-shadow` that would remove the ring,
 * and the forced-colors fallback) via `postcss`. happy-dom does not compute styles from stylesheets
 * and the package has no browser harness for unit CSS, so the contrast ratio of the ring token is
 * gated separately in `check-token-contrast.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import { parse, type AtRule, type Rule } from 'postcss';

function loadCss(relativePath: string): string {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFileSync(fullPath, 'utf8');
}

const commandItemCss = loadCss('./command-item.css');
const root = parse(commandItemCss);

/**
 * A rule is "effectively top-level" when the only at-rules between it and the
 * stylesheet root are `@layer` wrappers. Rules inside `@media` / `@supports` /
 * `@container` (e.g. the forced-colors block) are NOT top-level and are skipped
 * by this predicate.
 */
function isEffectivelyTopLevel(rule: Rule): boolean {
  let ancestor = rule.parent;
  while (ancestor && ancestor.type !== 'root') {
    if (ancestor.type === 'atrule' && (ancestor as AtRule).name !== 'layer') return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function findTopLevelRule(selector: string): Rule {
  let match: Rule | undefined;
  root.walkRules((rule) => {
    if (!isEffectivelyTopLevel(rule)) return undefined;
    if (rule.selectors.includes(selector)) {
      match = rule;
      return false;
    }
    return undefined;
  });
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match;
}

function declValue(rule: Rule, property: string): string | undefined {
  let value: string | undefined;
  rule.walkDecls(property, (decl) => {
    value = decl.value;
  });
  return value;
}

const ACTIVE_SELECTOR = '.cinder-command-item[data-cinder-active]';

describe('command-item active state — tint and WCAG 1.4.11 ring', () => {
  test('active rule is a soft accent tint, not the solid accent fill', () => {
    const rule = findTopLevelRule(ACTIVE_SELECTOR);
    expect(declValue(rule, 'background')).toBe('var(--cinder-accent-background)');
  });

  test('active rule keeps the default text color, so the highlight never recolors the label', () => {
    const rule = findTopLevelRule(ACTIVE_SELECTOR);
    expect(declValue(rule, 'color')).toBe('var(--cinder-text-default)');
  });

  test('active rule leaves the shared row ring in place instead of removing it', () => {
    // The tint is too pale to be the keyboard cursor's only boundary (WCAG 1.4.11), so the inset
    // `--cinder-ring-color` ring `_row-item.css` draws on every active row must keep applying: this
    // rule declares no `box-shadow` of its own that could replace or cancel it.
    const rule = findTopLevelRule(ACTIVE_SELECTOR);
    expect(declValue(rule, 'box-shadow')).toBeUndefined();
    const shared = loadCss('../../styles/components/_row-item.css');
    expect(shared).toMatch(
      /\.cinder-_row-item\[data-cinder-active\][\s\S]*?box-shadow:\s*inset\s+0\s+0\s+0\s+1px\s+var\(--cinder-ring-color\)/,
    );
  });

  test('forced-colors block retains system-color outline for the active item', () => {
    // The forced-colors rule resets box-shadow (system colors strip it) and
    // falls back to an `outline` using the system Highlight color. This must
    // remain present so keyboard position is still visible in Windows High
    // Contrast Mode.
    let forcedColorsRuleFound = false;
    let hasHighlightBackground = false;
    let hasOutline = false;

    root.walkRules((rule) => {
      if (!rule.selectors.includes(ACTIVE_SELECTOR)) return undefined;

      // Only look inside @media (forced-colors: active)
      let ancestor = rule.parent;
      let insideForcedColors = false;
      while (ancestor && ancestor.type !== 'root') {
        if (
          ancestor.type === 'atrule' &&
          (ancestor as AtRule).name === 'media' &&
          /forced-colors:\s*active/.test((ancestor as AtRule).params)
        ) {
          insideForcedColors = true;
          break;
        }
        ancestor = ancestor.parent;
      }
      if (!insideForcedColors) return undefined;

      forcedColorsRuleFound = true;
      rule.walkDecls('background', (decl) => {
        if (decl.value === 'Highlight') hasHighlightBackground = true;
      });
      rule.walkDecls('outline', (decl) => {
        if (/Highlight/.test(decl.value)) hasOutline = true;
      });
      return undefined;
    });

    expect(
      forcedColorsRuleFound,
      'a forced-colors rule for the active selector must be present',
    ).toBe(true);
    expect(hasHighlightBackground, 'forced-colors active rule must set background: Highlight').toBe(
      true,
    );
    expect(
      hasOutline,
      'forced-colors active rule must set an outline using the Highlight system color',
    ).toBe(true);
  });
});
