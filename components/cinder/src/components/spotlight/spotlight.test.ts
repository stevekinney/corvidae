/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: Spotlight } = await import('./spotlight.svelte');

const caveat = createRawSnippet(() => ({ render: () => '<span>Updated 12 min ago</span>' }));

describe('Spotlight', () => {
  test('renders the value', () => {
    const { container } = render(Spotlight, { value: 'Ends in 45 min' });
    expect(container.querySelector('.cinder-spotlight__value')?.textContent).toBe('Ends in 45 min');
  });

  test('renders the caveat directly after the value', () => {
    const { container } = render(Spotlight, { value: '2 need you', caveat });
    const value = container.querySelector('.cinder-spotlight__value');
    const caveatElement = container.querySelector('.cinder-spotlight__caveat');
    expect(caveatElement?.textContent).toBe('Updated 12 min ago');
    expect(value?.nextElementSibling).toBe(caveatElement);
  });

  test('renders no caveat or status when none is given', () => {
    const { container } = render(Spotlight, { value: '2 need you' });
    expect(container.querySelector('.cinder-spotlight__caveat')).toBeNull();
    expect(container.querySelector('.cinder-status-dot')).toBeNull();
  });

  test('shows liveness as a status dot with a word', () => {
    const { container } = render(Spotlight, {
      value: '2 need you',
      status: 'online',
      statusLabel: 'Live',
    });
    const dot = container.querySelector('.cinder-status-dot');
    expect(dot?.textContent).toContain('Live');
    expect(dot?.getAttribute('data-cinder-status')).toBe('online');
  });

  test('value uses the default text colour, never the accent', () => {
    const css = readFileSync(new URL('./spotlight.css', import.meta.url), 'utf8');
    const valueRule = /\.cinder-spotlight__value \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(valueRule).toContain('color: var(--cinder-text-default)');
    expect(css).not.toContain('--cinder-accent');
  });
});
