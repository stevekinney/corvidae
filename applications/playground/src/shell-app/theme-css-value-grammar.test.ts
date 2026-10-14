import { describe, expect, test } from 'bun:test';

import { PROFILES } from '@lostgradient/cinder/tokens/runtime';

import {
  contractFor,
  validateCssUserValue,
  type CssValueContract,
  type SupportsFunction,
} from './theme-css-value-grammar.ts';

const color = contractFor('color', PROFILES['color']);
const height = contractFor('dimension', PROFILES['height']);
const width = contractFor('number', PROFILES['width']);
const ratio = contractFor('number', PROFILES['aspect-ratio']);
const spacing = contractFor('dimension', PROFILES['spacing']);
const duration = contractFor('duration', PROFILES['duration']);
const plainNumber = contractFor('number', PROFILES['opacity']);

const options = {
  supports: null,
  profileOfProperty: (property: string) =>
    ({ '--cinder-space-4': 'spacing', '--cinder-accent-solid': 'color' })[property],
};

const accepts = (text: string, contract: CssValueContract) =>
  validateCssUserValue(text, contract, options);

describe('typed serializations', () => {
  test.each([
    ['oklch(55% 0.2 270)', color],
    ['#3366ff', color],
    ['color-mix(in oklch, oklch(50% 0.1 20) 40%, oklch(100% 0 0))', color],
    ['light-dark(oklch(98% 0 0), oklch(20% 0.02 255))', color],
    ['oklch(from var(--cinder-accent-solid) l c h)', color],
    ['lab(50 -20 30)', color],
    ['4px', spacing],
    ['0', spacing],
    ['calc(1rem + 4px)', spacing],
    ['calc(var(--cinder-space-4) * 2)', spacing],
    ['200ms', duration],
    ['0.5', plainNumber],
  ])('accepts %s', (text, contract) => {
    expect(accepts(text, contract)).toEqual({ ok: true, value: text });
  });

  test('trims the stored value', () => {
    expect(accepts('  4px  ', spacing)).toEqual({ ok: true, value: '4px' });
  });

  test.each([
    ['', spacing],
    ['5', spacing],
    ['4 px', spacing],
    ['4px 8px', spacing],
    ['4furlong', spacing],
    ['4s', spacing],
    ['#fff', spacing],
    ['red', color],
    ['4px', color],
    ['10ms', plainNumber],
  ])('rejects %s', (text, contract) => {
    expect(accepts(text, contract).ok).toBe(false);
  });
});

describe('contract-specific words', () => {
  test('auto only for auto-capable sizes', () => {
    expect(accepts('auto', height).ok).toBe(true);
    expect(accepts('auto', width).ok).toBe(true);
    expect(accepts('auto', spacing).ok).toBe(false);
    expect(accepts('auto', color).ok).toBe(false);
  });

  test('percentages only for percentage-capable sizing', () => {
    expect(accepts('100%', width).ok).toBe(true);
    expect(accepts('50%', height).ok).toBe(true);
    expect(accepts('50%', spacing).ok).toBe(false);
    expect(accepts('calc(100% - 4px)', height).ok).toBe(true);
  });

  test('currentColor only for colors', () => {
    expect(accepts('currentColor', color).ok).toBe(true);
    expect(accepts('currentcolor', color).ok).toBe(true);
    expect(accepts('currentColor', spacing).ok).toBe(false);
  });

  test('aspect-ratio takes a positive a / b ratio and nothing else', () => {
    expect(accepts('16 / 9', ratio).ok).toBe(true);
    expect(accepts('1.5 / 1', ratio).ok).toBe(true);
    for (const text of ['16', '0 / 9', '16 / 0', '-1 / 2', '16 / 9 / 2', 'auto', '16/9px']) {
      expect(accepts(text, ratio).ok).toBe(false);
    }
  });
});

describe('references', () => {
  test('var() to a public same-contract target', () => {
    expect(accepts('var(--cinder-space-4)', spacing).ok).toBe(true);
    expect(accepts('var(--cinder-accent-solid)', color).ok).toBe(true);
  });

  test.each([
    ['var(--cinder-accent-solid)', spacing],
    ['var(--cinder-missing)', spacing],
    ['var(--other-space)', spacing],
    ['var(--cinder-space-4, 4px)', spacing],
    ['var(--_cinder-private)', spacing],
    ['var(--cinder-space-4', spacing],
  ])('rejects %s', (text, contract) => {
    expect(accepts(text, contract).ok).toBe(false);
  });
});

describe('lexical rejection', () => {
  const hostile = [
    'red; background: url(x)',
    '4px}',
    '{4px',
    '@import "x"',
    'url(https://example.com/a.png)',
    'URL(x)',
    'image-set(x 1x)',
    'paint(foo)',
    'attr(data-x)',
    'env(safe-area-inset-top)',
    '4px /* comment */',
    '4p\\78',
    '4px !important',
    'calc(1px + (2px)',
    'calc(1px + 2px))',
    '4px\u0000',
    '<script>',
    'https://example.com',
    'expression(alert(1))',
  ];
  test.each(hostile)('rejects %j for every contract', (text) => {
    for (const contract of [spacing, color, width, height, duration, plainNumber, ratio]) {
      expect(accepts(text, contract).ok).toBe(false);
    }
  });

  test('rejects a function that is not in the vocabulary', () => {
    for (const text of ['translate(1px)', 'min(1px, 2px)', 'env(x)', 'foo(1)']) {
      expect(accepts(text, spacing).ok).toBe(false);
    }
    expect(accepts('rgb(from url(x) r g b)', color).ok).toBe(false);
    expect(accepts('calc(1px + foo(2px))', spacing).ok).toBe(false);
  });

  test('rejects an over-long value and over-deep nesting', () => {
    expect(accepts(`calc(${'1px + '.repeat(1000)}1px)`, spacing).ok).toBe(false);
    expect(accepts(`${'calc('.repeat(12)}1px${')'.repeat(12)}`, spacing).ok).toBe(false);
  });

  test('rejects division by zero and non-finite numbers', () => {
    expect(accepts('calc(4px / 0)', spacing).ok).toBe(false);
    expect(accepts('1e999px', spacing).ok).toBe(false);
  });
});

describe('the browser stage', () => {
  test('asks supports about every recorded usage property', () => {
    const asked: Array<[string, string]> = [];
    const supports: SupportsFunction = (property, value) => {
      asked.push([property, value]);
      return true;
    };
    const result = validateCssUserValue('oklch(55% 0.2 270)', color, { ...options, supports });
    expect(result.ok).toBe(true);
    expect(asked.map(([property]) => property)).toEqual(PROFILES['color']!.cssUsage);
  });

  test('a failing property rejects the value and names it', () => {
    const supports: SupportsFunction = (property) => property !== 'fill';
    const result = validateCssUserValue('oklch(55% 0.2 270)', color, { ...options, supports });
    expect(result).toEqual({
      ok: false,
      message: '“oklch(55% 0.2 270)” is not a valid fill value.',
    });
  });

  test('supports is never reached for a value the grammar rejected', () => {
    let called = false;
    const supports: SupportsFunction = () => {
      called = true;
      return true;
    };
    validateCssUserValue('url(x)', color, { ...options, supports });
    expect(called).toBe(false);
  });
});
