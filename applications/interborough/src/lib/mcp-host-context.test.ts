/**
 * The host's theme as the MCP Apps spec carries it (COR-2215, K3): the info slots fill from
 * Cinder's `--cinder-status-info-*` tokens, and the host's map is the panel kit's map read the
 * other way, so a panel and the host that sends it a theme can never disagree about a slot.
 */
import { PANEL_TOKEN_MAP } from '@lostgradient/cinder/panel';
import { describe, expect, test } from 'bun:test';

import { readMcpHostContext, STYLE_MAP } from './mcp-host-context.ts';

function rootWith(styles: Record<string, string>): HTMLElement {
  const root = document.createElement('div');
  for (const [name, value] of Object.entries(styles)) root.style.setProperty(name, value);
  document.body.append(root);
  return root;
}

describe('STYLE_MAP', () => {
  test('is the panel kit token map, pair for pair and in order', () => {
    // Both as lists of two strings: the host's keys are the spec's key type, the kit's are text.
    expect<ReadonlyArray<readonly [string, string]>>(STYLE_MAP).toEqual(PANEL_TOKEN_MAP);
  });
});

describe('readMcpHostContext', () => {
  test('fills the info slots from the --cinder-status-info-* tokens', () => {
    const root = rootWith({
      '--cinder-status-info-background': 'rgb(1, 2, 3)',
      '--cinder-status-info-text': 'rgb(4, 5, 6)',
      '--cinder-status-info-border': 'rgb(7, 8, 9)',
    });
    const variables = readMcpHostContext(root).styles?.variables;
    expect(variables?.['--color-background-info']).toBe('rgb(1, 2, 3)');
    expect(variables?.['--color-text-info']).toBe('rgb(4, 5, 6)');
    expect(variables?.['--color-border-info']).toBe('rgb(7, 8, 9)');
    expect(variables?.['--color-ring-info']).toBeUndefined();
  });

  test('fills the secondary text slot from a color, never from the text-size token', () => {
    const root = rootWith({
      '--cinder-text-secondary': '0.8125rem',
      '--cinder-text-muted': 'rgb(10, 11, 12)',
      '--cinder-text-subtle': 'rgb(13, 14, 15)',
    });
    const variables = readMcpHostContext(root).styles?.variables;
    expect(variables?.['--color-text-secondary']).toBe('rgb(10, 11, 12)');
    expect(variables?.['--color-text-tertiary']).toBe('rgb(13, 14, 15)');
  });

  test('leaves a slot undefined when the host defines no token for it', () => {
    const variables = readMcpHostContext(rootWith({})).styles?.variables;
    expect(variables?.['--color-background-info']).toBeUndefined();
  });
});
