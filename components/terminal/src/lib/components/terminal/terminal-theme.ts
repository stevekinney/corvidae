/**
 * Bridges Cinder's design tokens into the engine's color theme. The engine paints with concrete
 * colors, not custom properties, so each token is resolved against the terminal's own element
 * where `color-scheme` and any `data-theme` override apply.
 */

/** The engine theme slot each Cinder token feeds. */
export const THEME_TOKENS = {
  foreground: '--cinder-text-default',
  background: '--cinder-surface-inset',
  cursor: '--cinder-text-default',
  cursorAccent: '--cinder-surface-inset',
  selectionBackground: '--cinder-accent-solid',
  selectionInactiveBackground: '--cinder-border-strong',
  black: '--cinder-terminal-ansi-black',
  red: '--cinder-terminal-ansi-red',
  green: '--cinder-terminal-ansi-green',
  yellow: '--cinder-terminal-ansi-yellow',
  blue: '--cinder-terminal-ansi-blue',
  magenta: '--cinder-terminal-ansi-magenta',
  cyan: '--cinder-terminal-ansi-cyan',
  white: '--cinder-terminal-ansi-white',
  brightBlack: '--cinder-terminal-ansi-bright-black',
  brightRed: '--cinder-terminal-ansi-bright-red',
  brightGreen: '--cinder-terminal-ansi-bright-green',
  brightYellow: '--cinder-terminal-ansi-bright-yellow',
  brightBlue: '--cinder-terminal-ansi-bright-blue',
  brightMagenta: '--cinder-terminal-ansi-bright-magenta',
  brightCyan: '--cinder-terminal-ansi-bright-cyan',
  brightWhite: '--cinder-terminal-ansi-bright-white',
} as const;

export type EngineThemeSlot = keyof typeof THEME_TOKENS;

/** A theme with only the slots whose token resolved to a color. */
export type EngineTheme = Partial<Record<EngineThemeSlot, string>>;

/** Resolves a custom property to the concrete color it currently paints, or `undefined`. */
export type ColorResolver = (token: string) => string | undefined;

/**
 * A resolver that paints each token on a hidden probe child of `host` and reads back the computed
 * color, which collapses `light-dark()`, `color-mix()`, and `var()` chains for the host's theme.
 * A value that is not a resolved color, such as an unresolved `var()`, is treated as missing.
 */
export function createElementColorResolver(host: HTMLElement): {
  resolve: ColorResolver;
  dispose: () => void;
} {
  const probe = host.ownerDocument.createElement('span');
  probe.hidden = true;
  probe.setAttribute('aria-hidden', 'true');
  host.append(probe);
  return {
    resolve(token) {
      probe.style.color = '';
      probe.style.color = `var(${token})`;
      const color = host.ownerDocument.defaultView?.getComputedStyle(probe).color ?? '';
      return color === '' || color.includes('var(') ? undefined : color;
    },
    dispose: () => probe.remove(),
  };
}

function isThemeSlot(key: string): key is EngineThemeSlot {
  return key in THEME_TOKENS;
}

/** The engine theme for the current tokens, leaving out any slot whose token did not resolve. */
export function resolveEngineTheme(resolve: ColorResolver): EngineTheme {
  const theme: EngineTheme = {};
  for (const slot of Object.keys(THEME_TOKENS)) {
    if (!isThemeSlot(slot)) continue;
    const color = resolve(THEME_TOKENS[slot]);
    if (color !== undefined) theme[slot] = color;
  }
  return theme;
}
