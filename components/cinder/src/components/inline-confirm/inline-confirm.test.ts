/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: InlineConfirm } = await import('./inline-confirm.svelte');

afterEach(cleanup);

describe('InlineConfirm', () => {
  test('standalone sidecar imports Button styles', () => {
    const css = readFileSync(new URL('./inline-confirm.css', import.meta.url), 'utf8');
    expect(
      css.startsWith(
        '@layer cinder.tokens, cinder.foundation, cinder.components, cinder.utilities;',
      ),
    ).toBe(true);
    expect(css).toContain("@import '../button/button.css';");
  });

  test('wraps intrinsically instead of depending on the viewport', () => {
    const css = readFileSync(new URL('./inline-confirm.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.cinder-inline-confirm\s*\{[^}]*flex-wrap: wrap/);
    expect(css).not.toContain('container-type: inline-size');
    expect(css).not.toContain('@container');
    expect(css).not.toContain('@media (max-width: 32rem)');
  });

  test('renders an in-flow named group without modal semantics and confirms', async () => {
    let confirmations = 0;
    const { container, getByRole, queryByRole } = render(InlineConfirm, {
      prompt: 'Delete this comment?',
      confirmLabel: 'Delete comment',
      open: true,
      destructive: true,
      onConfirm: () => confirmations++,
    });

    const group = getByRole('group', { name: 'Delete this comment?' });
    expect(container.firstElementChild).toBe(group);
    expect(queryByRole('dialog')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Delete comment' }));
    expect(confirmations).toBe(1);
    expect(queryByRole('group')).toBeNull();
  });

  test('restores captured focus when confirmation synchronously unmounts', async () => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Delete trigger';
    document.body.append(trigger);
    trigger.focus();

    let unmount: () => void = () => {};
    const view = render(InlineConfirm, {
      prompt: 'Delete this comment?',
      confirmLabel: 'Delete comment',
      open: true,
      onConfirm: () => unmount(),
    });
    unmount = view.unmount;
    await fireEvent.click(view.getByRole('button', { name: 'Delete comment' }));

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  test('focuses the safe cancel action and dismisses from Escape', async () => {
    let cancellations = 0;
    const { getByRole, queryByRole } = render(InlineConfirm, {
      prompt: 'Delete this comment?',
      confirmLabel: 'Delete comment',
      open: true,
      onCancel: () => cancellations++,
    });

    const cancel = getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement === cancel).toBe(true));
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(cancellations).toBe(1);
    expect(queryByRole('group')).toBeNull();
  });

  test('uses neutral styling by default and explicit danger styling when destructive', async () => {
    const { container, rerender } = render(InlineConfirm, {
      prompt: 'Archive this item?',
      confirmLabel: 'Archive',
      open: true,
    });
    const root = container.querySelector('.cinder-inline-confirm');
    expect(root?.hasAttribute('data-cinder-destructive')).toBe(false);
    expect(root?.querySelector('.cinder-inline-confirm__glyph')).toBeNull();
    await rerender({ destructive: true });
    expect(root?.hasAttribute('data-cinder-destructive')).toBe(true);
    // The tone rides on the prompt: a glyph, hidden from assistive tech
    // because the prompt text already says what is being confirmed.
    const glyph = root?.querySelector('.cinder-inline-confirm__glyph');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  test('softens the strip into the raised surface and leaves container edges alone', () => {
    const css = readFileSync(new URL('./inline-confirm.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(css).toContain(
      'color-mix( in oklab, var(--cinder-status-neutral-background) 60%, var(--cinder-surface-raised) )',
    );
    expect(css).toContain(
      'color-mix( in oklab, var(--cinder-status-danger-background) 45%, var(--cinder-surface-raised) )',
    );
    // Only a flush strip gives its start or end edge to the container: a standalone strip has no
    // container edge to defer to, so it keeps both of its own.
    expect(css).toMatch(
      /\.cinder-inline-confirm\[data-cinder-flush\]:first-child \{ border-block-start: 0; \}/,
    );
    expect(css).toMatch(
      /\.cinder-inline-confirm\[data-cinder-flush\]:last-child \{ border-block-end: 0; \}/,
    );
    expect(css).not.toMatch(/\.cinder-inline-confirm:(?:first|last)-child/);
  });

  test.each([
    ['a keyboard activation', 'keyboard', true],
    ['a pointer activation', 'pointer', false],
  ] as const)(
    'moves focus to Cancel with a visible ring only after %s',
    async (_name, modality, visible) => {
      const focusOptions: Array<FocusOptions | undefined> = [];
      const original = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
        if (this.hasAttribute('data-cinder-inline-cancel')) focusOptions.push(options);
        original.call(this, options);
      };
      try {
        const view = render(InlineConfirm, {
          prompt: 'Delete this comment?',
          confirmLabel: 'Delete comment',
        });
        if (modality === 'keyboard') await fireEvent.keyDown(document.body, { key: 'Enter' });
        else await fireEvent.pointerDown(document.body);
        await view.rerender({ open: true });
        await waitFor(() => expect(focusOptions).toHaveLength(1));
        expect(focusOptions[0]).toEqual({ preventScroll: true, focusVisible: visible });
      } finally {
        HTMLElement.prototype.focus = original;
      }
    },
  );
});
