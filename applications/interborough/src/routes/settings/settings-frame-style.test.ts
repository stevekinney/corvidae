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

  test('takes the wide measure from its measure property, and knows no page by name (COR-2509)', () => {
    const style = source.slice(source.indexOf('<style>'));
    // A page is never selected by its name: the page asks for the measure.
    expect(style).not.toMatch(/data-page/);
    expect(ruleOf(".weft-settings[data-measure='wide']")).toMatch(/--ib-settings-measure:\s*64rem/);
    // Every section keeps the one reading width unless it asks.
    expect(ruleOf('.weft-settings')).toMatch(
      /--ib-settings-measure:\s*var\(--ib-settings-content-width\)/,
    );
    expect(source).toMatch(/measure = 'default'/);
  });

  test('only the Plugins page asks for the wide measure', async () => {
    const pages = [
      './index.svelte',
      './plugins/index.svelte',
      './models/index.svelte',
      './a2a/index.svelte',
      './retention/index.svelte',
      './api-reference/index.svelte',
      './allowed-models.svelte',
    ];
    const wide: string[] = [];
    for (const path of pages) {
      const text = await Bun.file(new URL(path, import.meta.url)).text();
      if (/measure="wide"/.test(text)) wide.push(path);
    }
    expect(wide).toEqual(['./plugins/index.svelte']);
  });
});
