/// <reference lib="dom" />
import { setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resetScrollLock } from '../../_internal/overlay.ts';
import { emptySnippet, installModalDialogStubs, textSnippet } from './modal-test-helpers.ts';

setupHappyDom();
installModalDialogStubs();
const { cleanup, render } = await import('@testing-library/svelte');
const { default: Modal } = await import('./modal.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
});

/**
 * Ids come from a per-render counter, so the markup is compared with them numbered by position.
 * Svelte's empty `<!---->` anchors mark where a block sits, not content, and the removed desktop
 * branch was one such block, so they and the whitespace around them are not compared.
 */
function normalizedMarkup(): string {
  const ids = new Map<string, string>();
  const stable = (id: string): string => {
    if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
    return ids.get(id)!;
  };
  return document.body.innerHTML
    .replaceAll('<!---->', '')
    .replace(/\b(id|for|aria-labelledby|aria-describedby)="([^"]+)"/g, (_match, name, value) => {
      return `${name}="${value
        .split(' ')
        .map((part: string) => stable(part))
        .join(' ')}"`;
    })
    .replace(/\s+/g, ' ')
    .replace(/> </g, '>\n<');
}

const fixturePath = new URL('./modal-markup.fixture.txt', import.meta.url);

/**
 * The markup a Modal renders on the web, where no desktop host ever mounts. The fixture was
 * captured before the desktop titlebar branch was removed; it must not change when the branch goes.
 */
describe('Modal markup', () => {
  test('a titled modal renders the markup captured before the desktop branch was removed', () => {
    render(Modal, {
      props: {
        open: true,
        title: 'Connect Anthropic',
        description: 'Paste an API key, then test it.',
        children: textSnippet('Body'),
        footer: emptySnippet,
      },
    });

    expect(normalizedMarkup()).toBe(readFileSync(fixturePath, 'utf8'));
  });
});
