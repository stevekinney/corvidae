/**
 * The list pane's footer (COR-2195), asserted against the CSS source with `postcss`: happy-dom does
 * not compute styles from stylesheets. A design review of the Memory and Chats list panes found the
 * footer adding inline padding on top of the inset of the rows it wraps, and about 70px of space
 * after an empty state.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse, type Rule } from 'postcss';

const stylesheet = readFileSync(new URL('./list-detail.css', import.meta.url), 'utf8');

function rulesFor(selector: RegExp): Rule[] {
  const rules: Rule[] = [];
  parse(stylesheet).walkRules((rule) => {
    if (selector.test(rule.selector)) rules.push(rule);
  });
  return rules;
}

function declarationsOf(rule: Rule): Map<string, string> {
  const declarations = new Map<string, string>();
  rule.walkDecls((declaration) => {
    declarations.set(declaration.prop, declaration.value);
  });
  return declarations;
}

describe('ListDetail footer', () => {
  const footerRules = rulesFor(/^\.cinder-list-detail__footer$/);

  test('has no inline padding of its own beyond the rows it wraps', () => {
    expect(footerRules).toHaveLength(1);
    const declarations = declarationsOf(footerRules[0]!);
    expect(declarations.get('padding-inline')).toBe('0');
    // The shorthand would set the inline sides again.
    expect(declarations.has('padding')).toBe(false);
    expect(declarations.get('padding-block')).toBe('var(--cinder-space-2)');
  });

  test('the empty state above a footer gives up most of its bottom padding', () => {
    const rules = rulesFor(/data-list-empty/);
    const underFooter = rules.filter((rule) =>
      /\+ \.cinder-list-detail__footer/.test(rule.selector),
    );
    expect(underFooter).toHaveLength(1);
    expect(declarationsOf(underFooter[0]!).get('padding-block-end')).toBe('var(--cinder-space-2)');
  });
});

// Owner, 2026-11-19: on a light page the list, the detail and the page read as one pale grey.
describe('ListDetail panes', () => {
  test('are the content surface, white in light mode, against the canvas around them', () => {
    const panels = rulesFor(/^\.cinder-list-detail__panels$/);
    expect(panels).toHaveLength(1);
    expect(declarationsOf(panels[0]!).get('background')).toBe('var(--cinder-surface)');
  });
});
