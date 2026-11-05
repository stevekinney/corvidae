/**
 * The composer's Settings fold: the controls stand in the row while the composer is wide, and one
 * Settings control holds them once it is `folded`, so the row never wraps or overlaps.
 */
/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: ChatComposerSettings } = await import('./chat-composer-settings.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const controls = createRawSnippet(() => ({
  render: () => '<button type="button" data-testid="effort">Effort Medium</button>',
}));

describe('ChatComposerSettings', () => {
  test('leaves the controls in the row while the composer is wide', () => {
    const { container, queryByRole } = render(ChatComposerSettings, {
      folded: false,
      children: controls,
    });

    expect(container.querySelector('[data-testid="effort"]')).not.toBeNull();
    expect(queryByRole('button', { name: /^Settings/ })).toBeNull();
  });

  test('draws one Settings control in its place once folded, and the controls open from it', async () => {
    const { container, getByRole } = render(ChatComposerSettings, {
      folded: true,
      children: controls,
    });

    expect(container.querySelector('[data-testid="effort"]')).toBeNull();
    const trigger = getByRole('button', { name: 'Settings: Model, Effort and Permissions' });
    expect(trigger.textContent).toContain('Settings');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');

    await fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[data-testid="effort"]')).not.toBeNull();
  });

  test('takes the name and the word a host gives it', () => {
    const { getByRole } = render(ChatComposerSettings, {
      folded: true,
      children: controls,
      label: 'Chat settings',
      word: 'Options',
    });

    expect(getByRole('button', { name: 'Chat settings' }).textContent).toContain('Options');
  });
});
