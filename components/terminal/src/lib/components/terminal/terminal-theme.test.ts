import { describe, expect, test } from 'bun:test';

import {
  THEME_TOKENS,
  createElementColorResolver,
  resolveEngineTheme,
  type EngineThemeSlot,
} from './terminal-theme.ts';

describe('THEME_TOKENS', () => {
  test('maps the whole ANSI ramp onto Cinder terminal tokens, in order', () => {
    const ramp: EngineThemeSlot[] = [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    ];
    expect(ramp.map((slot) => THEME_TOKENS[slot])).toEqual([
      '--cinder-terminal-ansi-black',
      '--cinder-terminal-ansi-red',
      '--cinder-terminal-ansi-green',
      '--cinder-terminal-ansi-yellow',
      '--cinder-terminal-ansi-blue',
      '--cinder-terminal-ansi-magenta',
      '--cinder-terminal-ansi-cyan',
      '--cinder-terminal-ansi-white',
      '--cinder-terminal-ansi-bright-black',
      '--cinder-terminal-ansi-bright-red',
      '--cinder-terminal-ansi-bright-green',
      '--cinder-terminal-ansi-bright-yellow',
      '--cinder-terminal-ansi-bright-blue',
      '--cinder-terminal-ansi-bright-magenta',
      '--cinder-terminal-ansi-bright-cyan',
      '--cinder-terminal-ansi-bright-white',
    ]);
  });

  test('takes the surface and text from the same tokens TerminalFrame paints with', () => {
    expect(THEME_TOKENS.background).toBe('--cinder-surface-inset');
    expect(THEME_TOKENS.foreground).toBe('--cinder-text-default');
  });
});

describe('resolveEngineTheme', () => {
  test('resolves each slot through its token', () => {
    const asked: string[] = [];
    const theme = resolveEngineTheme((token) => {
      asked.push(token);
      return `resolved(${token})`;
    });
    expect(Object.keys(theme).toSorted()).toEqual(Object.keys(THEME_TOKENS).toSorted());
    expect(theme.red).toBe('resolved(--cinder-terminal-ansi-red)');
    expect(asked).toHaveLength(Object.keys(THEME_TOKENS).length);
  });

  test('leaves out a slot whose token did not resolve', () => {
    const theme = resolveEngineTheme((token) =>
      token === '--cinder-terminal-ansi-red' ? undefined : '#123456',
    );
    expect('red' in theme).toBe(false);
    expect(theme.green).toBe('#123456');
  });
});

describe('createElementColorResolver', () => {
  test('resolves a token against the host, so a themed subtree gets its own colors', () => {
    const light = document.createElement('div');
    light.style.setProperty('--cinder-text-default', '#111111');
    const dark = document.createElement('div');
    dark.style.setProperty('--cinder-text-default', '#eeeeee');
    document.body.append(light, dark);
    const lightResolver = createElementColorResolver(light);
    const darkResolver = createElementColorResolver(dark);
    expect(lightResolver.resolve('--cinder-text-default')).toBe('#111111');
    expect(darkResolver.resolve('--cinder-text-default')).toBe('#eeeeee');
    lightResolver.dispose();
    darkResolver.dispose();
    light.remove();
    dark.remove();
  });

  test('treats an undefined token as missing, not as a color', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const resolver = createElementColorResolver(host);
    expect(resolver.resolve('--cinder-not-defined')).toBeUndefined();
    resolver.dispose();
    host.remove();
  });

  test('treats an unresolved var() as missing', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const resolver = createElementColorResolver(host);
    const window = host.ownerDocument.defaultView!;
    const original = window.getComputedStyle;
    window.getComputedStyle = (() => ({ color: 'var(--x)' })) as unknown as typeof original;
    try {
      expect(resolver.resolve('--x')).toBeUndefined();
    } finally {
      window.getComputedStyle = original;
    }
    resolver.dispose();
    host.remove();
  });

  test('keeps its probe hidden from assistive technology and removes it on dispose', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const resolver = createElementColorResolver(host);
    const probe = host.querySelector('span');
    expect(probe?.hidden).toBe(true);
    expect(probe?.getAttribute('aria-hidden')).toBe('true');
    resolver.dispose();
    expect(host.querySelector('span')).toBeNull();
    host.remove();
  });
});
