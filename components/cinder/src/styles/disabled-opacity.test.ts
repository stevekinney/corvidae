/**
 * COR-2303: a disabled Cinder component is repainted with colour tokens, never faded with
 * `opacity`.
 *
 * An opacity fade composites the whole element through the surface behind it, so the disabled text
 * colour (chosen to clear 4.5:1 on its own) lands near 2:1 and a screen of disabled controls, the
 * offline state, reads as broken rather than unavailable. The fix is per property: the text takes
 * `--cinder-text-disabled`, a surface takes `--cinder-surface-inset` or `--cinder-fill-disabled`,
 * and a graphic with no text takes a `filter`.
 *
 * This reads every stylesheet under `src` and fails on a fractional `opacity` declaration in a
 * rule whose selector names a disabled state, and on any use of the `--cinder-opacity-disabled`
 * token as a value. `opacity: 0` and `opacity: 1` are not fades (an entry state and a forced-colors
 * restore), and a selector that mentions disabled only inside `:not()` is an enabled-state rule.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Glob } from 'bun';
import { expect, test } from 'bun:test';
import { parse, type AtRule, type Rule } from 'postcss';

const sourceDirectory = join(import.meta.dir, '..');
const STYLESHEETS = new Glob('**/*.css');
const NOT_PSEUDO = /:not\((?:[^()]|\([^()]*\))*\)/g;
const DISABLED_SELECTOR = /disabled/i;
const FADE_TOKEN = '--cinder-opacity-disabled';

function isFraction(value: string): boolean {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 && number < 1;
}

function insideKeyframes(rule: Rule): boolean {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && /keyframes$/i.test((parent as AtRule).name)) return true;
  }
  return false;
}

/** Every disabled-state fade in a stylesheet, as `selector { declaration }`. */
function disabledFades(source: string): string[] {
  const offenders: string[] = [];
  parse(source).walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    const selector = rule.selector.replaceAll(NOT_PSEUDO, '');
    const disabled = DISABLED_SELECTOR.test(selector);
    rule.walkDecls((declaration) => {
      const fade =
        declaration.prop === 'opacity' &&
        disabled &&
        (isFraction(declaration.value) || declaration.value.includes(FADE_TOKEN));
      const token = declaration.prop !== FADE_TOKEN && declaration.value.includes(FADE_TOKEN);
      if (fade || token) {
        offenders.push(
          `${rule.selector.replaceAll(/\s+/g, ' ')} { ${declaration.prop}: ${declaration.value} }`,
        );
      }
    });
  });
  return offenders;
}

test('no Cinder stylesheet fades a disabled state with opacity', () => {
  const offenders: string[] = [];
  for (const path of STYLESHEETS.scanSync({ cwd: sourceDirectory })) {
    for (const offender of disabledFades(readFileSync(join(sourceDirectory, path), 'utf8'))) {
      offenders.push(`${path}  ${offender}`);
    }
  }
  expect(
    offenders,
    'A disabled state takes colour tokens (--cinder-text-disabled, --cinder-surface-inset, ' +
      '--cinder-fill-disabled) or a filter, never an opacity fade.',
  ).toEqual([]);
});

test('the matcher catches the shapes it exists for', () => {
  for (const css of [
    '.a:disabled { opacity: 0.6; }',
    ".a[aria-disabled='true'] .b { opacity: .5; }",
    '.a[data-cinder-disabled] { opacity: var(--cinder-opacity-disabled); }',
    '.a--disabled { opacity: 0.4 }',
    '.a { opacity: var(--cinder-opacity-disabled); }',
  ]) {
    expect(disabledFades(css), css).toHaveLength(1);
  }
});

test('the matcher leaves alone what is not a disabled fade', () => {
  for (const css of [
    '.a:disabled { color: var(--cinder-text-disabled); }',
    '.a:not(:disabled):hover { opacity: 0.9; }',
    ".a:not([aria-disabled='true']) { opacity: 0.8; }",
    '.a[forced-colors] .b:disabled { opacity: 1; }',
    '.a:disabled { opacity: 0; }',
    '@keyframes disabled-pulse { 50% { opacity: 0.3; } }',
    '.a { opacity: 0.55; }',
    ':root { --cinder-opacity-disabled: 0.55; }',
  ]) {
    expect(disabledFades(css), css).toEqual([]);
  }
});
