import { describe, expect, test } from 'bun:test';

const kbdCss = await Bun.file(new URL('./kbd.css', import.meta.url)).text();
const tokens = await Bun.file(new URL('../../styles/tokens-base.css', import.meta.url)).text();

function block(selector: string): string {
  const start = kbdCss.indexOf(selector);
  if (start === -1) throw new Error(`Missing rule ${selector}`);
  return kbdCss.slice(kbdCss.indexOf('{', start), kbdCss.indexOf('}', start));
}

describe('Kbd inside a Button', () => {
  for (const variant of ['primary', 'danger']) {
    test(`${variant}: inherits the variant contrast color with a translucent edge and no fill`, () => {
      const body = block(`.cinder-button[data-cinder-variant='${variant}'] .cinder-kbd`);
      expect(body).toContain('color: inherit;');
      expect(body).toContain('background: transparent;');
      expect(body).toContain('border-color: color-mix(in oklch, currentColor, transparent 60%);');
      expect(body).toContain('box-shadow: none;');
    });
  }

  for (const variant of ['secondary', 'ghost']) {
    test(`${variant}: uses muted text`, () => {
      const body = block(`.cinder-button[data-cinder-variant='${variant}'] .cinder-kbd`);
      expect(body).toContain('color: var(--cinder-text-muted);');
    });
  }

  test('the contrast colors the hint inherits are defined for light and dark themes', () => {
    for (const token of ['--cinder-accent-contrast', '--cinder-status-danger-contrast']) {
      expect(tokens).toContain(`${token}: light-dark(`);
    }
  });
});
