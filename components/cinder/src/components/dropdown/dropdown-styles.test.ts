/**
 * COR-2680: the shape of a disabled Dropdown item's reason in CSS. A reason never reads brighter
 * than the disabled label it explains, so it takes the same disabled colour at a smaller size.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { parse, type Rule } from 'postcss';

const dropdownCss = readFileSync(fileURLToPath(new URL('./dropdown.css', import.meta.url)), 'utf8');

function ruleFor(selector: string): Rule | undefined {
  let match: Rule | undefined;
  parse(dropdownCss).walkRules((rule) => {
    if (rule.selectors.includes(selector)) match = rule;
  });
  return match;
}

function declaration(rule: Rule | undefined, property: string): string | undefined {
  let value: string | undefined;
  rule?.walkDecls(property, (decl) => {
    value = decl.value;
  });
  return value;
}

describe('dropdown item reason', () => {
  test('is drawn in the disabled colour, like the label it explains, at the extra-small size', () => {
    const reason = ruleFor('.cinder-dropdown-item__reason');
    expect(declaration(reason, 'color')).toBe('var(--cinder-text-disabled)');
    expect(declaration(reason, 'font-size')).toBe('var(--cinder-text-xs)');
    expect(declaration(ruleFor('.cinder-dropdown-item[data-disabled]'), 'color')).toBe(
      'var(--cinder-text-disabled)',
    );
  });
});
