/// <reference lib="dom" />
import { setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { resetScrollLock } from '../../_internal/overlay.ts';
import { emptySnippet, installModalDialogStubs } from './modal-test-helpers.ts';

setupHappyDom();
installModalDialogStubs();
const { cleanup, render } = await import('@testing-library/svelte');
const { default: Modal } = await import('./modal.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
});

function dialogOf(container: HTMLElement): HTMLDialogElement {
  const dialog = document.body.querySelector('dialog');
  if (dialog === null) throw new Error('The modal rendered no dialog.');
  expect(container).toBeDefined();
  return dialog;
}

describe('Modal description', () => {
  test('draws a line under the title and describes the dialog by it', async () => {
    const { container, findByText } = render(Modal, {
      props: {
        open: true,
        title: 'Connect Anthropic',
        description: 'Paste an API key, then test it.',
        children: emptySnippet,
      },
    });

    const line = await findByText('Paste an API key, then test it.');
    const dialog = dialogOf(container);

    expect(line.className).toContain('cinder-modal__description');
    expect(line.previousElementSibling?.tagName).toBe('H2');
    expect(dialog.getAttribute('aria-describedby')).toBe(line.id);
    expect(dialog.getAttribute('aria-labelledby')).toBe(line.previousElementSibling?.id ?? null);
  });

  test('lets describedById name something else', async () => {
    const { container, findByText } = render(Modal, {
      props: {
        open: true,
        title: 'Connect Anthropic',
        description: 'Paste an API key, then test it.',
        describedById: 'elsewhere',
        children: emptySnippet,
      },
    });

    await findByText('Paste an API key, then test it.');

    expect(dialogOf(container).getAttribute('aria-describedby')).toBe('elsewhere');
  });

  test('draws no description and no description reference without one, or for a blank one', async () => {
    const { container, findByText } = render(Modal, {
      props: { open: true, title: 'Plain', description: '   ', children: emptySnippet },
    });

    await findByText('Plain');
    const dialog = dialogOf(container);

    expect(dialog.querySelector('.cinder-modal__description')).toBeNull();
    expect(dialog.querySelector('.cinder-modal__heading')).toBeNull();
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
  });
});
