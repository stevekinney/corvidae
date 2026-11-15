import { describe, expect, test } from 'bun:test';

const kbdCss = await Bun.file(new URL('./kbd.css', import.meta.url)).text();
const buttonCss = await Bun.file(new URL('../button/button.css', import.meta.url)).text();
const tokens = await Bun.file(new URL('../../styles/tokens-base.css', import.meta.url)).text();

function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`Missing rule ${selector}`);
  return source.slice(source.indexOf('{', start), source.indexOf('}', start));
}

const variants = [
  'primary',
  'secondary',
  'soft',
  'danger',
  'soft-danger',
  'ghost',
  'ghost-danger',
  'ghost-accent',
];

describe('Kbd inside a Button', () => {
  test('one rule covers every variant and size: a quiet key chip in the button color', () => {
    const body = block(kbdCss, '.cinder-button .cinder-kbd,');
    for (const declaration of [
      'color: inherit;',
      'background: color-mix(in oklch, currentColor 14%, transparent);',
      'border: 0;',
      'border-radius: var(--cinder-radius-sm);',
      'box-shadow: none;',
      'padding: 0 0.4em;',
      'height: 1.6em;',
      'font-size: var(--cinder-text-2xs);',
      'font-family: inherit;',
    ]) {
      expect(body).toContain(declaration);
    }
    // The key's glyphs keep the button's text contrast: nothing dims them.
    expect(body).not.toContain('opacity');
    expect(body).not.toContain('border-color');
  });

  test('the rule outranks the size rules, so every size gets the same chip', () => {
    expect(kbdCss).toContain('.cinder-button .cinder-kbd[data-cinder-size] {');
  });

  test('forced colours give each key a 1px edge in place of the wash', () => {
    const media = kbdCss.lastIndexOf('@media (forced-colors: active)');
    expect(media).not.toBe(-1);
    expect(block(kbdCss.slice(media), '.cinder-button .cinder-kbd[data-cinder-size] {')).toContain(
      'border: 1px solid currentColor;',
    );
  });

  test('the chips sit a clear step after the label', () => {
    expect(block(buttonCss, '.cinder-button__shortcut {')).toContain(
      'margin-inline-start: var(--cinder-space-1);',
    );
  });

  for (const variant of variants) {
    test(`${variant}: has no variant-specific hint rule that could restore a border or fill`, () => {
      expect(kbdCss).not.toContain(`[data-cinder-variant='${variant}'] .cinder-kbd`);
    });
  }

  test('the separator and label inherit the button color', () => {
    const body = block(kbdCss, '.cinder-button .cinder-shortcut-hint__separator,');
    expect(body).toContain('color: inherit;');
  });

  test('the separator is dimmed like the keys', () => {
    const body = block(kbdCss, '.cinder-button .cinder-shortcut-hint__separator {');
    expect(body).toContain('opacity: 0.72;');
  });

  test('the shortcut slot is hidden on coarse-pointer and no-hover devices', () => {
    const media = buttonCss.indexOf('@media (pointer: coarse), (hover: none)');
    expect(media).not.toBe(-1);
    const slot = buttonCss.indexOf('.cinder-button__shortcut {', media);
    expect(slot).not.toBe(-1);
    expect(buttonCss.slice(slot, buttonCss.indexOf('}', slot))).toContain('display: none;');
    // The hiding rule follows the base `display` rule, so it wins at equal specificity.
    expect(buttonCss.indexOf('.cinder-button__shortcut {')).toBeLessThan(media);
  });

  test('the contrast colors the hint inherits are defined for light and dark themes', () => {
    for (const token of ['--cinder-accent-contrast', '--cinder-status-danger-contrast']) {
      expect(tokens).toContain(`${token}: light-dark(`);
    }
  });
});
