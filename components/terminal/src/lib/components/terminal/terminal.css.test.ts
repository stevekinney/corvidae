import { describe, expect, test } from 'bun:test';

const css = await Bun.file(new URL('./terminal.css', import.meta.url)).text();

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`No rule for ${selector}`);
  return match[1]!;
}

// happy-dom has no layout or cascade, so these pin the declarations the browser proof found
// missing (COR-474); `terminal-layout.playwright.ts` proves the rendered result in three engines.
describe('the terminal stylesheet', () => {
  test('the engine’s opaque scrollable viewport takes the themed surface', () => {
    // The engine's own stylesheet is unlayered, so this rule is too: a layered rule would lose.
    const rule = declarations('.cinder-terminal__viewport .xterm .xterm-viewport');
    expect(rule).toContain('background-color: var(--cinder-surface-inset)');
    const before = css.slice(0, css.indexOf('.cinder-terminal__viewport .xterm .xterm-viewport'));
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth, 'the rule is outside every @layer block').toBe(0);
  });

  test('the action row wraps instead of clipping a control at a narrow width', () => {
    expect(declarations('.cinder-terminal__actions')).toContain('flex-wrap: wrap');
  });

  test('the focus ring is an overlay that paints above the engine surface', () => {
    const viewport = declarations('.cinder-terminal__viewport');
    expect(viewport).toContain('position: relative');
    const ring = declarations('.cinder-terminal__viewport:focus-within::after');
    for (const declaration of ['position: absolute', 'inset: 0', 'pointer-events: none']) {
      expect(ring).toContain(declaration);
    }
    expect(ring).toContain(
      'box-shadow: inset 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color)',
    );
    expect(css).not.toMatch(/\.cinder-terminal__viewport:focus-within\s*\{/);
  });
});
