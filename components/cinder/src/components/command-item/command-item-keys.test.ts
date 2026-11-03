/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Harness } = await import('./command-item-keys-harness.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('CommandItem keys (row 03d)', () => {
  test('a sequence reads "G then H", each key in a Kbd', () => {
    const { container } = render(Harness, { keys: ['G', 'H'] });
    const keys = container.querySelector('.cinder-command-item__keys');
    expect(keys?.querySelectorAll('kbd')).toHaveLength(2);
    expect(
      [...(keys?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent?.trim()),
    ).toEqual(['G', 'H']);
    expect(keys?.textContent?.replace(/\s+/g, ' ').trim()).toBe('G then H');
    expect(keys?.querySelectorAll('.cinder-command-item__then')).toHaveLength(1);
  });

  test('a single key shows alone, with no "then"', () => {
    const { container } = render(Harness, { keys: ['C'] });
    const keys = container.querySelector('.cinder-command-item__keys');
    expect(keys?.textContent?.replace(/\s+/g, ' ').trim()).toBe('C');
    expect(keys?.querySelector('.cinder-command-item__then')).toBeNull();
  });

  test('the keys are text in the row, not hidden from the option name', () => {
    const { container } = render(Harness, { keys: ['G', 'H'] });
    const option = container.querySelector('[role="option"]');
    expect(option?.textContent?.replace(/\s+/g, ' ')).toContain('Go to Home');
    expect(option?.textContent?.replace(/\s+/g, ' ')).toContain('G then H');
    expect(
      container.querySelector('.cinder-command-item__keys')?.closest('[aria-hidden="true"]'),
    ).toBeNull();
    // A sequence is not a chord, so it does not set aria-keyshortcuts.
    expect(option?.getAttribute('aria-keyshortcuts')).toBeNull();
  });

  test('renders nothing without keys', () => {
    const { container } = render(Harness, {});
    expect(container.querySelector('.cinder-command-item__keys')).toBeNull();
  });
});
