import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import { parse, type Declaration, type Rule } from 'postcss';

import { stylesheetImportPattern } from '@lostgradient/component-tooling/test/css.ts';

function loadCss(relativePath: string): string {
  const fullPath = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFileSync(fullPath, 'utf8');
}

function declarationValue(source: string, property: string): string {
  const root = parse(source);
  let value: string | undefined;
  root.walkDecls(property, (declaration: Declaration) => {
    value = declaration.value;
    return false;
  });
  if (!value) throw new Error(`declaration not found: ${property}`);
  return value;
}

function ruleDeclarationValue(source: string, selector: string, property: string): string {
  const root = parse(source);
  let value: string | undefined;
  root.walkRules(selector, (rule: Rule) => {
    rule.walkDecls(property, (declaration: Declaration) => {
      value = declaration.value;
      return false;
    });
    return false;
  });
  if (value === undefined) {
    throw new Error(`declaration not found: ${selector} { ${property} }`);
  }
  return value;
}

function compactCssValue(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

function lightDarkArms(value: string): [string, string] {
  const match = /^light-dark\(([\s\S]+)\)$/.exec(value.trim());
  if (!match?.[1]) throw new Error(`expected light-dark(), got: ${value}`);
  const inner = match[1];
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      return [inner.slice(0, index).trim(), inner.slice(index + 1).trim()];
    }
  }
  throw new Error(`light-dark() missing comma separator: ${value}`);
}

const tokensCss = loadCss('../../../../tokens/src/styles/tokens-base.css');
const colorPickerCss = loadCss('./color-picker.css');
const colorFieldCss = loadCss('../../../../core/src/components/color-field/color-field.css');
const inputCss = loadCss('../../../../input/src/components/input/input.css');

test('format controls keep their intended styling after copy-button styles load', () => {
  expect(colorPickerCss).toContain('.cinder-color-picker .cinder-color-picker__format');
});

test('format controls are at least 24 CSS px tall (WCAG 2.5.8 target size)', () => {
  let minimum: string | undefined;
  parse(colorPickerCss).walkRules('.cinder-color-picker .cinder-color-picker__format', (rule) => {
    rule.walkDecls('min-block-size', (declaration) => {
      minimum = declaration.value;
    });
  });
  expect(minimum).toBe('var(--_cinder-color-picker-row-height)');
  expect(
    ruleDeclarationValue(
      colorPickerCss,
      '.cinder-color-picker__footer',
      '--_cinder-color-picker-row-height',
    ),
  ).toBe('24px');
});

// Owner review: the current colour is a swatch in the first format row, at that row's height,
// not a separate block centred against the three rows.
test('the preview swatch shares the first format row and its height', () => {
  expect(ruleDeclarationValue(colorPickerCss, '.cinder-color-picker__footer', 'align-items')).toBe(
    'flex-start',
  );
  for (const property of ['inline-size', 'block-size']) {
    expect(ruleDeclarationValue(colorPickerCss, '.cinder-color-picker__preview', property)).toBe(
      'var(--_cinder-color-picker-row-height)',
    );
  }
  expect(
    ruleDeclarationValue(colorPickerCss, '.cinder-color-picker__preview', 'border-radius'),
  ).toBe('var(--cinder-radius-sm)');
});

test('composed color controls aggregate their dependency styles for à-la-carte consumers', () => {
  expect(colorFieldCss).not.toMatch(stylesheetImportPattern('button/button.css'));
  expect(colorFieldCss).toMatch(stylesheetImportPattern('color-picker/color-picker.css'));
  expect(colorFieldCss).toMatch(stylesheetImportPattern('popover/popover.css'));
  expect(colorPickerCss).toMatch(
    stylesheetImportPattern('color-swatch-picker/color-swatch-picker.css'),
  );
  expect(colorPickerCss).toMatch(stylesheetImportPattern('copy-button/copy-button.css'));
});
const colorSwatchPickerCss = loadCss(
  '../../../../color-swatch-picker/src/components/color-swatch-picker/color-swatch-picker.css',
);

describe('color checker tokens', () => {
  test('checkerboard tokens keep the light arm and define a distinct dark arm', () => {
    const base = lightDarkArms(declarationValue(tokensCss, '--cinder-checker-base'));
    const tile = lightDarkArms(declarationValue(tokensCss, '--cinder-checker-tile'));

    expect(base).toEqual(['#fff', 'oklch(28% 0.02 245)']);
    expect(tile).toEqual(['#ccc', 'oklch(38% 0.02 245)']);
    expect(base[0]).not.toBe(base[1]);
    expect(tile[0]).not.toBe(tile[1]);
  });

  test('color components consume the public checker tokens without private checker aliases', () => {
    const componentSources = [colorPickerCss, colorFieldCss, colorSwatchPickerCss];

    for (const source of componentSources) {
      expect(source).toContain('var(--cinder-checker-base)');
      expect(source).toContain('var(--cinder-checker-tile)');
      expect(source).not.toContain('--_cinder-color-picker-checker-');
      expect(source).not.toContain('--_cinder-color-field-checker-');
      expect(source).not.toContain('--_cinder-color-swatch-picker-checker-');
    }
  });
});

describe('color picker thumb contrast outline', () => {
  test('thumb shadow keeps a dark edge and adds a dark-mode support ring', () => {
    const support = lightDarkArms(
      declarationValue(colorPickerCss, '--_cinder-color-picker-thumb-shadow-support'),
    ).map(compactCssValue);
    const shadow = compactCssValue(
      declarationValue(colorPickerCss, '--_cinder-color-picker-thumb-shadow'),
    );

    expect(declarationValue(colorPickerCss, '--_cinder-color-picker-thumb-border')).toBe('#fff');
    expect(
      compactCssValue(declarationValue(colorPickerCss, '--_cinder-color-picker-thumb-shadow-edge')),
    ).toBe('rgba(0, 0, 0, 0.5)');
    expect(
      declarationValue(colorPickerCss, '--_cinder-color-picker-thumb-shadow-support-light'),
    ).toBe('transparent');
    expect(
      compactCssValue(
        declarationValue(colorPickerCss, '--_cinder-color-picker-thumb-shadow-support-dark'),
      ),
    ).toBe('rgba(255, 255, 255, 0.65)');
    expect(support).toEqual([
      'var(--_cinder-color-picker-thumb-shadow-support-light)',
      'var(--_cinder-color-picker-thumb-shadow-support-dark)',
    ]);
    expect(shadow).toBe(
      '0 0 0 1px var(--_cinder-color-picker-thumb-shadow-edge), 0 0 0 2px var(--_cinder-color-picker-thumb-shadow-support)',
    );
  });
});

describe('color field swatch trigger', () => {
  // Owner review: the swatch is inset evenly inside the field and has no border of its own. Its
  // height is the slot's less the slot's own inline padding above and below.
  test('the swatch stretches to the slot with a block inset equal to the slot padding', () => {
    const selector = '.cinder-color-field__swatch-button';
    expect(ruleDeclarationValue(colorFieldCss, selector, 'align-self')).toBe('stretch');
    expect(ruleDeclarationValue(colorFieldCss, selector, 'margin-block')).toBe(
      'var(--_cinder-color-field-inset)',
    );
    expect(
      ruleDeclarationValue(colorFieldCss, '.cinder-color-field', '--_cinder-color-field-inset'),
    ).toBe('var(--cinder-space-1)');
    // The inline inset is the interactive trailing slot's own padding, so the two must agree.
    expect(
      ruleDeclarationValue(
        inputCss,
        '.cinder-input-group__leading:not([aria-hidden]),\n  .cinder-input-group__trailing:not([aria-hidden])',
        'padding-inline',
      ),
    ).toBe('var(--cinder-space-1)');
    expect(ruleDeclarationValue(colorFieldCss, selector, 'border')).toBe('0');
  });

  test('the swatch has no border outside forced colors', () => {
    const borders: string[] = [];
    parse(colorFieldCss).walkRules(/cinder-color-field__swatch/, (rule) => {
      if (rule.parent?.type === 'atrule' && (rule.parent as { name?: string }).name === 'media') {
        return;
      }
      rule.walkDecls(/^border(-width|-style|-color)?$/, (declaration) => {
        borders.push(`${rule.selector} { ${declaration.prop}: ${declaration.value} }`);
      });
    });
    expect(borders).toEqual(['.cinder-color-field__swatch-button { border: 0 }']);
  });
});

describe('color picker text hierarchy', () => {
  test('copy formats and the fallback hex value use the declared muted text token', () => {
    expect(
      ruleDeclarationValue(
        colorPickerCss,
        '.cinder-color-picker .cinder-color-picker__format',
        'color',
      ),
    ).toBe('var(--cinder-text-muted)');
    expect(ruleDeclarationValue(colorPickerCss, '.cinder-color-picker__hex-value', 'color')).toBe(
      'var(--cinder-text-muted)',
    );
    expect(colorPickerCss).not.toContain('--cinder-text-secondary');
  });
});
