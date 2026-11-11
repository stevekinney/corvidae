/**
 * COR-2010 (B02, rows 02m to 02q, 03b): the shape of the sidebar row's CSS. A sidebar row is one
 * 30px control whose hover, focus and active fill paint the whole box; the media queries and the
 * forced-colors fallbacks cannot be evaluated here, so these pin the declarations.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { parse, type Rule } from 'postcss';

import { isUnderForcedColors } from '../../test/focus-ring-helpers.ts';

function loadCss(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const navigationItemCss = loadCss('../navigation-item/navigation-item.css');
const sideNavigationItemCss = loadCss('./side-navigation-item.css');

function rulesFor(css: string, selector: string): Rule[] {
  const matches: Rule[] = [];
  const squashed = selector.replaceAll(/\s+/g, ' ');
  parse(css).walkRules((rule) => {
    if (rule.selectors.some((candidate) => candidate.replaceAll(/\s+/g, ' ') === squashed)) {
      matches.push(rule);
    }
  });
  return matches;
}

function declaration(rule: Rule | undefined, property: string): string | undefined {
  let value: string | undefined;
  rule?.walkDecls(property, (decl) => {
    value = decl.value.replaceAll(/\s+/g, ' ');
  });
  return value;
}

const VERTICAL = ".cinder-navigation-item[data-variant='vertical']";
const ACTIVE = `${VERTICAL}[data-active='true']`;

describe('vertical navigation item: one 30px control (rows 02m, 02n)', () => {
  const [row] = rulesFor(navigationItemCss, VERTICAL);

  test('is 30px tall, raised to the list-row minimum by a coarse pointer', () => {
    expect(declaration(row, 'min-block-size')).toBe(
      'max(1.875rem, var(--cinder-list-row-min-height))',
    );
  });

  test('has the row radius, padding, gap, weight and a real line height', () => {
    expect(declaration(row, 'border-radius')).toBe('var(--cinder-radius-sm)');
    expect(declaration(row, 'padding-inline')).toBe('var(--cinder-space-2)');
    expect(declaration(row, 'padding-block')).toBe('0');
    expect(declaration(row, 'gap')).toBe('var(--cinder-space-2)');
    expect(declaration(row, 'font-weight')).toBe('var(--cinder-font-medium)');
    expect(declaration(row, 'line-height')).toBe('1.25rem');
  });

  test('paints no fill of its own and reads as secondary text until hovered', () => {
    expect(declaration(row, 'background')).toBeUndefined();
    expect(declaration(row, 'background-color')).toBeUndefined();
    const [base] = rulesFor(navigationItemCss, '.cinder-navigation-item');
    expect(declaration(base, 'color')).toBe('var(--cinder-text-muted)');
    expect(declaration(base, 'cursor')).toBe('pointer');
  });

  test('hover tints the whole row and turns the text primary', () => {
    const hover = rulesFor(
      navigationItemCss,
      ".cinder-navigation-item:hover:not([aria-disabled='true'])",
    );
    expect(declaration(hover[0], 'color')).toBe('var(--cinder-text-default)');
    expect(declaration(hover[0], 'background-color')).toBe('var(--cinder-surface-hover)');
  });

  test('a sidebar row hovers to a neutral ink tint lighter than the active row, never the accent wash of --cinder-surface-hover', () => {
    const strip = (selector: string) => selector.replaceAll(/\s+/g, '');
    const wanted = strip(`${VERTICAL}:hover:not([aria-disabled='true'],[data-active='true'])`);
    let tint: string | undefined;
    parse(navigationItemCss).walkRules((rule) => {
      if (rule.selectors.some((candidate) => strip(candidate) === wanted)) {
        tint = declaration(rule, 'background-color');
      }
    });
    expect(tint).toBe('color-mix(in oklch, var(--cinder-border-ink), transparent 96%)');
    expect(tint).not.toContain('accent');
    expect(tint).not.toContain('surface-hover');
  });
});

describe('vertical navigation item: active (rows 02n, 02p, COR-2315)', () => {
  const RAISED_PILL = 'var(--cinder-surface-raised)';
  // The pill's shadow reads a private hook first, so a surface that drops the pill (the phone
  // drawer, `sidebar.css`) sets the hook and never `box-shadow`, and keeps the focus ring.
  const SHADOW = 'var(--_cinder-navigation-item-pill-shadow, var(--cinder-shadow-sm))';

  test('is a raised white pill with the hairline shadow, default text and semibold weight (AC2, AC9)', () => {
    const rule = rulesFor(navigationItemCss, ACTIVE).find(
      (candidate) => !isUnderForcedColors(candidate),
    );
    expect(declaration(rule, 'background-color')).toBe(RAISED_PILL);
    expect(declaration(rule, 'box-shadow')).toBe(SHADOW);
    expect(declaration(rule, 'color')).toBe('var(--cinder-text-default)');
    expect(declaration(rule, 'font-weight')).toBe('var(--cinder-font-semibold)');
  });

  test('keeps the pill shadow beside the focus ring when the active row is focused', () => {
    const rule = rulesFor(navigationItemCss, `${ACTIVE}:focus-visible`).find(
      (candidate) => !isUnderForcedColors(candidate),
    );
    const shadow = declaration(rule, 'box-shadow');
    expect(shadow).toContain('inset 0 0 0 var(--cinder-ring-width)');
    expect(shadow).toContain('var(--_cinder-navigation-item-ring, var(--cinder-ring-color))');
    expect(shadow).toEndWith(SHADOW);
  });

  test('never paints the accent: the accent is for actions and links', () => {
    for (const rule of rulesFor(navigationItemCss, ACTIVE).concat(
      rulesFor(navigationItemCss, `${ACTIVE}:hover`),
    )) {
      if (isUnderForcedColors(rule)) continue;
      expect(declaration(rule, 'background-color')).not.toContain('accent');
      expect(declaration(rule, 'color')).not.toContain('accent');
    }
  });

  test('takes no hover change', () => {
    const rule = rulesFor(navigationItemCss, `${ACTIVE}:hover`).find(
      (candidate) => !isUnderForcedColors(candidate),
    );
    expect(declaration(rule, 'background-color')).toBe(RAISED_PILL);
    expect(declaration(rule, 'color')).toBe('var(--cinder-text-default)');
  });

  test('keeps the system selected-item pair under forced colors, hovered or not', () => {
    const rule = rulesFor(navigationItemCss, ACTIVE).find((candidate) =>
      isUnderForcedColors(candidate),
    );
    expect(declaration(rule, 'background-color')).toBe('SelectedItem');
    expect(declaration(rule, 'color')).toBe('SelectedItemText');
    const hovered = rulesFor(navigationItemCss, `${ACTIVE}:hover`).find((candidate) =>
      isUnderForcedColors(candidate),
    );
    expect(declaration(hovered, 'background-color')).toBe('SelectedItem');
  });
});

describe('vertical navigation item: keyboard focus (row 02o)', () => {
  test('wraps the whole row in the quiet ring, on keyboard focus only', () => {
    const rule = rulesFor(navigationItemCss, `${VERTICAL}:focus-visible`).find(
      (candidate) => !isUnderForcedColors(candidate),
    );
    expect(declaration(rule, 'box-shadow')).toContain('inset 0 0 0 var(--cinder-ring-width)');
    expect(declaration(rule, 'box-shadow')).toContain('var(--cinder-ring-color)');
    // No bare `:focus` rule paints the ring, so a mouse click never shows it.
    expect(rulesFor(navigationItemCss, `${VERTICAL}:focus`)).toEqual([]);
  });
});

describe('side navigation item: indicators and the collapsed rail (rows 02q, 03b)', () => {
  const COLLAPSED = '.cinder-side-navigation-item[data-cinder-collapsed][data-cinder-has-icon]';

  test('the count is plain muted 13px text at the trailing edge, never a pill; the dot sits against the label', () => {
    const [count] = rulesFor(sideNavigationItemCss, '.cinder-side-navigation-item__count');
    expect(declaration(count, 'margin-inline-start')).toBe('auto');
    expect(declaration(count, 'color')).toBe('var(--cinder-text-subtle)');
    expect(declaration(count, 'font-size')).toBe('var(--cinder-text-sm)');
    expect(declaration(count, 'text-align')).toBe('end');
    expect(declaration(count, 'background')).toBeUndefined();
    expect(declaration(count, 'border-radius')).toBeUndefined();
  });

  test('a collapsed row is a 40px target centred in the rail with its label clipped, not removed', () => {
    const [row] = rulesFor(sideNavigationItemCss, COLLAPSED);
    expect(declaration(row, 'inline-size')).toBe('2.5rem');
    expect(declaration(row, 'justify-content')).toBe('center');
    const [label] = rulesFor(
      sideNavigationItemCss,
      `${COLLAPSED} .cinder-side-navigation-item__label`,
    );
    expect(declaration(label, 'clip')).toBe('rect(0, 0, 0, 0)');
    expect(declaration(label, 'display')).toBeUndefined();
    expect(declaration(label, 'visibility')).toBeUndefined();
  });

  test('the collapsed count and dot ride the icon corner, the count as a small warning dot', () => {
    const [count] = rulesFor(
      sideNavigationItemCss,
      `${COLLAPSED} .cinder-side-navigation-item__count`,
    );
    expect(declaration(count, 'position')).toBe('absolute');
    expect(declaration(count, 'background')).toBe('var(--cinder-status-warning-solid)');
    expect(declaration(count, 'font-size')).toBe('0');
    expect(declaration(count, 'inline-size')).toBe(declaration(count, 'block-size'));
    const [dot] = rulesFor(sideNavigationItemCss, `${COLLAPSED} .cinder-side-navigation-item__dot`);
    expect(declaration(dot, 'position')).toBe('absolute');
  });

  test('carries the StatusDot and Tooltip styles it renders, and no Badge', () => {
    for (const sheet of ['status-dot/status-dot', 'tooltip/tooltip']) {
      expect(sideNavigationItemCss).toContain(`@import '../${sheet}.css';`);
    }
    expect(sideNavigationItemCss).not.toContain('badge/badge.css');
  });
});
