/**
 * What the panel specs send as the host's theme, and what they check a panel did with it
 * (COR-2218). A host sends the owner's palette as MCP Apps style variables and says light or dark;
 * a panel built on the Cinder kit follows both. The palette here is not Cinder's, so a panel that
 * ignored the host and painted Cinder's own colors would fail the checks, in either scheme.
 */
import type { McpUiHostContext, McpUiStyles } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, type FrameLocator } from '@playwright/test';

/** The two color schemes every panel spec runs under. */
export const SCHEMES = ['light', 'dark'] as const;

/** One of {@link SCHEMES}. */
export type Scheme = (typeof SCHEMES)[number];

const PALETTE: Record<Scheme, { readonly canvas: string; readonly text: string }> = {
  light: { canvas: 'rgb(253, 250, 240)', text: 'rgb(27, 36, 48)' },
  dark: { canvas: 'rgb(16, 24, 32)', text: 'rgb(240, 244, 248)' },
};

/**
 * The seconds in the first duration of a computed `transition-duration`. Chromium writes a tiny
 * duration in exponent form (`1e-05s`), so what a reduced-motion check compares is the number, not
 * the text. An empty value is no transition, zero.
 */
export function firstDurationSeconds(value: string): number {
  const first = (value.split(',')[0] ?? '').trim();
  if (first === '') return 0;
  const amount = Number.parseFloat(first);
  return first.endsWith('ms') ? amount / 1000 : amount;
}

/** The longest a transition may last under reduced motion: Cinder's `0.01ms`. */
export const REDUCED_MOTION_SECONDS = 0.00001;

/** The context a host in `scheme` sends: the theme, and a palette that is not Cinder's. */
export function hostContextFor(scheme: Scheme): McpUiHostContext {
  const { canvas, text } = PALETTE[scheme];
  return {
    theme: scheme,
    styles: {
      // The spec's list names every variable and lets each be absent; these two are the ones a
      // host that sends only a palette would send.
      variables: {
        '--color-background-primary': canvas,
        '--color-text-primary': text,
      } as McpUiStyles,
    },
  };
}

/**
 * Check that the panel in `app` follows the host in `scheme`: the document says which scheme it is
 * in, and the page is painted in the host's canvas and text colors, not Cinder's own.
 */
export async function expectFollowsHost(app: FrameLocator, scheme: Scheme): Promise<void> {
  const { canvas, text } = PALETTE[scheme];
  await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
  await expect(app.locator('html')).toHaveCSS('color-scheme', scheme);
  await expect(app.locator('body')).toHaveCSS('background-color', canvas);
  await expect(app.locator('body')).toHaveCSS('color', text);
}
