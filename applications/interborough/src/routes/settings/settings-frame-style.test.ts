import { describe, expect, test } from 'bun:test';

const source = await Bun.file(new URL('./settings-frame.svelte', import.meta.url)).text();

/** The declarations of the rule that styles `selector` in the component's own `<style>` block. */
function ruleOf(selector: string): string {
  const style = source.slice(source.indexOf('<style>'));
  const start = style.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return style.slice(start, style.indexOf('}', start));
}

describe('the settings frame', () => {
  test('adds no padding of its own around the page, because the shell outlet pads every page', () => {
    // The outlet is the one place that pads a page (`tests/e2e/37-visual-system.spec.ts`), so a
    // page root that pads itself doubles the space above its heading.
    expect(ruleOf('.weft-settings')).not.toMatch(/padding/);
  });
});
