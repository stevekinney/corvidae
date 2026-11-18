import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// COR-2445 AC10 (COR-2306 AC2): a row is a link and its title is never underlined, not at rest and
// not on hover; the row's own tint says it is the target.
const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

describe('StackedListItem title link', () => {
  test('draws no underline at rest or on hover', () => {
    expect(stylesheet).not.toMatch(/text-decoration:\s*underline/);
    const rules = [...stylesheet.matchAll(/([^{}]*__title-link[^{}]*)\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      if (/:hover/.test(selector ?? '')) expect(body).not.toMatch(/text-decoration/);
    }
    expect(stylesheet).toMatch(/__title-link \{[^}]*text-decoration: none/);
  });
});
