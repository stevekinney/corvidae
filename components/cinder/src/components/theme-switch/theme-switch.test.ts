/// <reference lib="dom" />
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import, because testing-library
// reads `globalThis.document` at module-init.
setupHappyDom();

const { render, fireEvent, cleanup, screen } = await import('@testing-library/svelte');
const { default: ThemeSwitch } = await import('./theme-switch.svelte');

const themeSwitchCss = readFileSync(new URL('./theme-switch.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

type Position = 'light' | 'system' | 'dark';
const POSITIONS: readonly Position[] = ['light', 'system', 'dark'];
const NAMES: Record<Position, string> = { light: 'Light', system: 'System', dark: 'Dark' };

function radio(position: Position): HTMLButtonElement {
  return screen.getByRole('radio', { name: NAMES[position] });
}

function checked(): Position[] {
  return POSITIONS.filter((position) => radio(position).getAttribute('aria-checked') === 'true');
}

describe('ThemeSwitch — structure', () => {
  test('is a radiogroup named Theme with Light, System and Dark radios', () => {
    render(ThemeSwitch);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group.classList.contains('cinder-theme-switch')).toBe(true);
    expect(screen.getAllByRole('radio').map((button) => button.getAttribute('aria-label'))).toEqual(
      ['Light', 'System', 'Dark'],
    );
  });

  test('defaults to System and selects exactly one position', () => {
    render(ThemeSwitch);
    expect(checked()).toEqual(['system']);
  });

  test.each(POSITIONS)('value="%s" selects that position', (value) => {
    render(ThemeSwitch, { props: { value } });
    expect(checked()).toEqual([value]);
    expect(screen.getByRole('radiogroup').getAttribute('data-cinder-value')).toBe(value);
  });

  test('label names the radiogroup and id lands on it', () => {
    render(ThemeSwitch, { props: { label: 'Color theme', id: 'theme' } });
    const group = screen.getByRole('radiogroup', { name: 'Color theme' });
    expect(group.id).toBe('theme');
  });

  test('only the selected position is in the tab order (roving tabindex)', () => {
    render(ThemeSwitch, { props: { value: 'dark' } });
    expect(POSITIONS.map((position) => radio(position).getAttribute('tabindex'))).toEqual([
      '-1',
      '-1',
      '0',
    ]);
  });

  test('a value outside the three positions reads as System', () => {
    render(ThemeSwitch, { props: { value: 'auto' as never } });
    expect(checked()).toEqual(['system']);
  });

  test('icons are decorative', () => {
    const { container } = render(ThemeSwitch);
    const icons = container.querySelectorAll('.cinder-theme-switch__option svg');
    expect(icons.length).toBe(3);
    for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ThemeSwitch — pointer selects each position and reports the value', () => {
  test.each(POSITIONS)('clicking %s selects it and reports it', async (position) => {
    const onValueChange = mock((_next: Position) => {});
    // Start on the opposite end, so every position is a real change.
    render(ThemeSwitch, {
      props: { value: position === 'light' ? 'dark' : 'light', onValueChange },
    });
    await fireEvent.click(radio(position));
    expect(checked()).toEqual([position]);
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(position);
  });

  test('clicking the selected position reports nothing', async () => {
    const onValueChange = mock((_next: Position) => {});
    render(ThemeSwitch, { props: { value: 'light', onValueChange } });
    await fireEvent.click(radio('light'));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(checked()).toEqual(['light']);
  });
});

describe('ThemeSwitch — keyboard selects each position and reports the value', () => {
  async function press(key: string, from: Position, onValueChange = mock((_next: Position) => {})) {
    render(ThemeSwitch, { props: { value: from, onValueChange } });
    radio(from).focus();
    await fireEvent.keyDown(radio(from), { key });
    return onValueChange;
  }

  test.each([
    ['ArrowRight', 'light', 'system'],
    ['ArrowDown', 'light', 'system'],
    ['ArrowRight', 'system', 'dark'],
    ['ArrowLeft', 'dark', 'system'],
    ['ArrowUp', 'dark', 'system'],
    ['ArrowLeft', 'system', 'light'],
  ] as const)('%s from %s moves to %s', async (key, from, to) => {
    const onValueChange = await press(key, from);
    expect(checked()).toEqual([to]);
    expect(onValueChange).toHaveBeenCalledWith(to);
    expect(document.activeElement).toBe(radio(to));
  });

  test('arrows wrap from Dark to Light and from Light to Dark', async () => {
    const forward = await press('ArrowRight', 'dark');
    expect(forward).toHaveBeenCalledWith('light');
    expect(checked()).toEqual(['light']);
    cleanup();
    const backward = await press('ArrowLeft', 'light');
    expect(backward).toHaveBeenCalledWith('dark');
    expect(checked()).toEqual(['dark']);
  });

  test('Home selects Light and End selects Dark', async () => {
    const home = await press('Home', 'dark');
    expect(home).toHaveBeenCalledWith('light');
    cleanup();
    const end = await press('End', 'light');
    expect(end).toHaveBeenCalledWith('dark');
    expect(checked()).toEqual(['dark']);
    expect(document.activeElement).toBe(radio('dark'));
  });

  test('keys the group does not own are left alone', async () => {
    const onValueChange = await press('a', 'system');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(checked()).toEqual(['system']);
  });

  test('positions are native buttons, so Space and Enter activate them as a click', async () => {
    const onValueChange = mock((_next: Position) => {});
    render(ThemeSwitch, { props: { value: 'light', onValueChange } });
    // A native <button> turns Space and Enter into a click, which the pointer tests cover; the
    // radio is a real button so no key handler of ours is needed.
    expect(radio('dark').tagName).toBe('BUTTON');
    expect(radio('dark').getAttribute('type')).toBe('button');
  });
});

describe('ThemeSwitch — disabled', () => {
  test('disables every position and ignores pointer and keys', async () => {
    const onValueChange = mock((_next: Position) => {});
    render(ThemeSwitch, { props: { value: 'light', disabled: true, onValueChange } });
    expect(screen.getByRole('radiogroup').getAttribute('aria-disabled')).toBe('true');
    for (const position of POSITIONS) expect(radio(position).disabled).toBe(true);
    await fireEvent.click(radio('dark'));
    await fireEvent.keyDown(radio('light'), { key: 'ArrowRight' });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(checked()).toEqual(['light']);
  });
});

describe('ThemeSwitch — quiet sky and night track', () => {
  test('colors are oklch values or tokens, never hex or legacy color functions', () => {
    expect(themeSwitchCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(themeSwitchCss).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch)\(/);
  });

  function declaration(value: string, property: string): string | undefined {
    return new RegExp(
      `\\.cinder-theme-switch\\[data-cinder-value='${value}'\\]\\s*\\{[^}]*${property}:\\s*([^;]+);`,
    ).exec(themeSwitchCss)?.[1];
  }

  test('each position paints the agreed track and border: pale sky, neutral, deep night', () => {
    const track = '--_cinder-theme-switch-track';
    const border = 'border-color';
    expect(declaration('light', track)).toBe('oklch(93% 0.04 235)');
    expect(declaration('light', border)).toBe('oklch(84% 0.05 235)');
    expect(declaration('dark', track)).toBe('oklch(25% 0.05 265)');
    expect(declaration('dark', border)).toBe('oklch(38% 0.05 265)');
    expect(declaration('system', track)).toBeUndefined();
    expect(themeSwitchCss).toContain('--_cinder-theme-switch-track: var(--cinder-surface-inset);');
    expect(themeSwitchCss).toContain('border: 1px solid var(--cinder-border);');
  });

  test('the raised thumb is white behind Light and a lifted night blue behind Dark', () => {
    expect(declaration('light', '--_cinder-theme-switch-thumb')).toBe('oklch(100% 0 255)');
    expect(declaration('dark', '--_cinder-theme-switch-thumb')).toBe('oklch(42% 0.06 265)');
    expect(declaration('dark', '--_cinder-theme-switch-icon-selected')).toBe('oklch(97% 0.01 265)');
    expect(declaration('dark', '--_cinder-theme-switch-icon')).toBe('oklch(80% 0.03 265)');
  });

  test('each position is 34px by 26px with a 15px icon, in a 32px track', () => {
    expect(themeSwitchCss).toContain('--_cinder-theme-switch-segment-inline: 2.125rem;');
    expect(themeSwitchCss).toContain('--_cinder-theme-switch-segment-block: 1.625rem;');
    expect(themeSwitchCss).toMatch(/\.cinder-theme-switch__icon\s*\{[^}]*inline-size: 0\.9375rem/);
  });

  test('the thumb slides by a logical offset and honours reduced motion and forced colors', () => {
    expect(themeSwitchCss).toContain('inset-inline-start: calc(');
    expect(themeSwitchCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(themeSwitchCss).toContain('@media (forced-colors: active)');
  });
});

describe('ThemeSwitch element references', () => {
  test('binds its option buttons through reactive state, so Svelte raises no non-reactive binding warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(ThemeSwitch, { props: { value: 'system', onValueChange: () => {} } });
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(
        messages.filter((message) => message.includes('binding_property_non_reactive')),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
