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

// COR-2329 round two: Home copied Section's header in page CSS to set "Open Reviews ›" beside the
// Spotlight. The action is the Spotlight's own.
describe('Spotlight action', () => {
  const action = createRawSnippet(() => ({ render: () => '<a href="/reviews">Open Reviews</a>' }));

  test('follows the value, before the caveat, and marks the Spotlight', () => {
    const { container } = render(Spotlight, { value: '2 need you', action, caveat });
    const root = container.querySelector('.cinder-spotlight');
    expect(root?.classList.contains('cinder-spotlight--action')).toBe(true);
    const value = container.querySelector('.cinder-spotlight__value');
    const slot = container.querySelector('.cinder-spotlight__action');
    expect(slot?.querySelector('a')?.textContent).toBe('Open Reviews');
    expect(value?.nextElementSibling).toBe(slot);
    expect(slot?.nextElementSibling).toBe(container.querySelector('.cinder-spotlight__caveat'));
  });

  test('without an action the Spotlight renders what it always did', () => {
    const plain = render(Spotlight, { value: '2 need you', caveat });
    expect(plain.container.querySelector('.cinder-spotlight')?.className).toBe('cinder-spotlight');
    expect(plain.container.querySelector('.cinder-spotlight__action')).toBeNull();
    expect(
      [...(plain.container.querySelector('.cinder-spotlight')?.children ?? [])].map(
        (child) => child.className,
      ),
    ).toEqual(['cinder-spotlight__value', 'cinder-spotlight__caveat']);
  });

  test('the action sits at the end of the value’s first line, centred on it, and wraps only when it must', () => {
    const css = readFileSync(new URL('./spotlight.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(css).toMatch(
      /\.cinder-spotlight\.cinder-spotlight--action \{ display: flex; flex-wrap: wrap; align-items: flex-start;/,
    );
    const slot = /\.cinder-spotlight__action \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(slot).toContain('align-items: center;');
    expect(slot).toContain('margin-inline-start: auto;');
    expect(slot).toContain('min-block-size: calc(2rem * 1.1);');
  });
});
