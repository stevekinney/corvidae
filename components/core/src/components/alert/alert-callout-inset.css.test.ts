/**
 * Alert and Callout start their text at one inset (COR-2195). A design review found the two 4px
 * apart: Alert padded its inline sides by `--cinder-space-4`, Callout by `--cinder-space-3`. Asserted
 * against the CSS source with `postcss`, because happy-dom does not compute styles from stylesheets.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'postcss';

/** The `padding-inline` the component's base rule declares, as written. */
function inlinePadding(stylesheetUrl: URL, selector: string): string | undefined {
  let value: string | undefined;
  parse(readFileSync(stylesheetUrl, 'utf8')).walkRules(selector, (rule) => {
    if (rule.parent?.type === 'atrule' && (rule.parent as { name?: string }).name === 'media') {
      return;
    }
    rule.walkDecls((declaration) => {
      if (declaration.prop === 'padding-inline') value ??= declaration.value;
      // A `padding` shorthand sets the inline sides too, and is the form the two had drifted in.
      if (declaration.prop === 'padding') value ??= `shorthand: ${declaration.value}`;
    });
  });
  return value;
}

describe('Alert and Callout inline padding', () => {
  const alert = inlinePadding(new URL('./alert.css', import.meta.url), '.cinder-alert');
  const callout = inlinePadding(
    new URL('../callout/callout.css', import.meta.url),
    '.cinder-callout',
  );

  test('both declare their inline padding, each as padding-inline', () => {
    expect(alert).toBeDefined();
    expect(callout).toBeDefined();
    expect(alert).not.toContain('shorthand');
    expect(callout).not.toContain('shorthand');
  });

  test('both use the same inline-padding token', () => {
    expect(alert).toBe('var(--cinder-space-3)');
    expect(alert).toBe(callout);
  });
});
