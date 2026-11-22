/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// happy-dom does not implement HTMLDialogElement.showModal / close; stub them so Modal can open.
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: function () {
        this.setAttribute('open', '');
      },
      configurable: true,
      writable: true,
    });
  }
  if (!HTMLDialogElement.prototype.close) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      value: function () {
        this.removeAttribute('open');
      },
      configurable: true,
      writable: true,
    });
  }
}

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { createRawSnippet, tick } = await import('svelte');
const { default: ConfirmDialog } = await import('./confirm-dialog.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function html(markup: string) {
  return createRawSnippet(() => ({ render: () => markup }));
}

function footerButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('.cinder-modal__footer button'));
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  const button = footerButtons(container).at(-1);
  if (!button) throw new Error('Expected a confirm button.');
  return button;
}

const base = {
  open: true,
  title: 'Delete this key?',
  confirmLabel: 'Delete key',
  onConfirm: () => {},
};

describe('ConfirmDialog description and options', () => {
  test('a snippet description keeps phrasing content inside the described paragraph', () => {
    const { container } = render(ConfirmDialog, {
      props: {
        ...base,
        description: html('<span><code>app:welcome-banner</code> is removed.</span>'),
      },
    });
    const paragraph = requiredInstance(
      container.querySelector('p.cinder-confirm-dialog__description'),
      HTMLParagraphElement,
    );
    expect(paragraph.querySelector('code')?.textContent).toBe('app:welcome-banner');
    const dialog = requiredInstance(container.querySelector('dialog'), HTMLDialogElement);
    expect(dialog.getAttribute('aria-describedby')).toBe(paragraph.id);
  });

  test('a string description is still plain text', () => {
    const { container } = render(ConfirmDialog, {
      props: { ...base, description: 'Removed for good.' },
    });
    expect(
      container.querySelector('.cinder-confirm-dialog__description')?.textContent?.trim(),
    ).toBe('Removed for good.');
  });

  test('options render below the description, and the typed confirmation follows them in the footer', () => {
    const { container } = render(ConfirmDialog, {
      props: {
        ...base,
        description: 'Deletes the workflow.',
        typeToConfirm: 'daily-summary',
        options: html(
          '<label><input type="checkbox" data-testid="runs" /> Also delete runs</label>',
        ),
      },
    });
    const body = requiredInstance(container.querySelector('.cinder-modal__body'), HTMLElement);
    const order = Array.from(body.children).map((child) => child.className);
    expect(order[0]).toContain('cinder-confirm-dialog__description');
    expect(order[1]).toContain('cinder-confirm-dialog__options');
    expect(order).toHaveLength(2);
    expect(container.querySelector('.cinder-modal__footer .cinder-input-field')).not.toBeNull();
    const checkbox = requiredInstance(
      container.querySelector('[data-testid="runs"]'),
      HTMLInputElement,
    );
    expect(checkbox.checked).toBe(false);
  });

  test('no options region renders without options', () => {
    const { container } = render(ConfirmDialog, { props: base });
    expect(container.querySelector('.cinder-confirm-dialog__options')).toBeNull();
  });
});

describe('ConfirmDialog confirm button', () => {
  test('confirmIcon is drawn before the label and hidden from assistive technology', () => {
    const { container } = render(ConfirmDialog, {
      props: {
        ...base,
        confirmLabel: 'Restart now',
        confirmIcon: html('<svg data-testid="restart-glyph"></svg>'),
      },
    });
    const button = confirmButton(container);
    const glyph = requiredInstance(
      button.querySelector('[data-testid="restart-glyph"]'),
      SVGElement,
    );
    expect(glyph.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(button.textContent?.trim()).toBe('Restart now');
  });

  test('confirmLabel and cancelLabel are reactive', async () => {
    const view = render(ConfirmDialog, {
      props: { ...base, confirmLabel: 'Delete', cancelLabel: 'Cancel' },
    });
    expect(confirmButton(view.container).textContent?.trim()).toBe('Delete');
    await view.rerender({ confirmLabel: 'Try again', cancelLabel: 'Close' });
    await tick();
    const buttons = footerButtons(view.container);
    expect(buttons.at(0)?.textContent?.trim()).toBe('Close');
    expect(buttons.at(-1)?.textContent?.trim()).toBe('Try again');
  });

  test('closeOnConfirm={false} keeps the dialog open and still fires onConfirm', async () => {
    const onConfirm = mock(() => {});
    let open = true;
    const { container } = render(ConfirmDialog, {
      props: {
        ...base,
        closeOnConfirm: false,
        onConfirm,
        get open() {
          return open;
        },
        set open(value: boolean) {
          open = value;
        },
      },
    });
    await fireEvent.click(confirmButton(container));
    await tick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(open).toBe(true);
  });

  test('by default the dialog closes itself on confirm', async () => {
    let open = true;
    const { container } = render(ConfirmDialog, {
      props: {
        ...base,
        get open() {
          return open;
        },
        set open(value: boolean) {
          open = value;
        },
      },
    });
    await fireEvent.click(confirmButton(container));
    await tick();
    expect(open).toBe(false);
  });
});

describe('ConfirmDialog busy', () => {
  function renderBusy(extra: Record<string, unknown> = {}) {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    let open = true;
    const view = render(ConfirmDialog, {
      props: {
        ...base,
        title: 'Restore Version 3?',
        confirmLabel: 'Restore Version 3',
        busy: true,
        busyLabel: 'Restoring…',
        closeOnConfirm: false,
        onConfirm,
        onCancel,
        get open() {
          return open;
        },
        set open(value: boolean) {
          open = value;
        },
        ...extra,
      },
    });
    return { ...view, onConfirm, onCancel, isOpen: () => open };
  }

  test('shows the busy label on an inert confirm button that keeps focus', async () => {
    const { container, onConfirm } = renderBusy();
    const button = confirmButton(container);
    expect(button.textContent).toContain('Restoring…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('without a busy label the confirm words stay put', () => {
    const { container } = renderBusy({ busyLabel: undefined });
    expect(confirmButton(container).textContent).toContain('Restore Version 3');
  });

  test('Cancel is inert while busy', async () => {
    const { container, onCancel, isOpen } = renderBusy();
    const cancel = requiredInstance(footerButtons(container).at(0) ?? null, HTMLButtonElement);
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(cancel);
    await tick();
    expect(onCancel).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
  });

  test('Escape, the backdrop and the close button cannot dismiss it', async () => {
    const { container, onCancel, isOpen } = renderBusy();
    const dialog = requiredInstance(container.querySelector('dialog'), HTMLDialogElement);
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await fireEvent.click(dialog);
    await tick();
    expect(onCancel).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
    expect(container.querySelector('.cinder-modal__close')).toBeNull();
  });

  test('the typed confirmation stays visible but read-only', () => {
    const { container } = renderBusy({ typeToConfirm: 'order-checker' });
    const input = requiredInstance(container.querySelector('input'), HTMLInputElement);
    expect(input.readOnly).toBe(true);
  });

  test('dismissal works again when the work is no longer busy', async () => {
    const { container, onCancel } = renderBusy({ busy: false });
    expect(container.querySelector('.cinder-modal__close')).not.toBeNull();
    const dialog = requiredInstance(container.querySelector('dialog'), HTMLDialogElement);
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmDialog failure', () => {
  test('shows a danger callout with its title on its own line inside an alert region', () => {
    const { container } = render(ConfirmDialog, {
      props: {
        ...base,
        error: 'Nothing was removed.',
        errorTitle: 'Couldn’t delete the key.',
      },
    });
    const region = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__failure'),
      HTMLElement,
    );
    expect(region.getAttribute('role')).toBe('alert');
    const callout = requiredInstance(region.querySelector('.cinder-callout'), HTMLElement);
    expect(callout.getAttribute('data-cinder-variant')).toBe('danger');
    // The title is the Callout's own title, a paragraph apart from the message, so it never runs
    // into it, and it is the same form as every other notice in a dialog.
    const title = requiredInstance(callout.querySelector('.cinder-callout__title'), HTMLElement);
    expect(title.textContent).toBe('Couldn’t delete the key.');
    expect(callout.querySelector('strong')).toBeNull();
    expect(title.textContent).not.toContain('Nothing was removed.');
    expect(callout.textContent).toContain('Nothing was removed.');
  });

  test('the action starts at the leading edge, under the message', () => {
    const { container } = render(ConfirmDialog, {
      props: { ...base, error: 'It failed.', errorAction: { label: 'Retry', onAction: () => {} } },
    });
    const callout = requiredInstance(container.querySelector('.cinder-callout'), HTMLElement);
    expect(callout.classList.contains('cinder-callout--inline-action')).toBe(false);
    // Start-aligned: a failure's action leads (`stacked` would end it at the trailing edge).
    expect(callout.classList.contains('cinder-callout--stacked-start-action')).toBe(true);
    expect(callout.querySelector('button')?.textContent?.trim()).toBe('Retry');
  });

  test('focus on the confirm button moves to the failure action when a fault takes the button away', async () => {
    const view = render(ConfirmDialog, {
      props: { ...base, closeOnConfirm: false, busy: true, busyLabel: 'Deleting…' },
    });
    const confirm = confirmButton(view.container);
    confirm.focus();
    expect(document.activeElement).toBe(confirm);
    await view.rerender({
      busy: false,
      error: 'Nothing was deleted.',
      errorAction: { label: 'Refresh preview', onAction: () => {} },
    });
    await tick();
    const action = requiredInstance(
      view.container.querySelector('.cinder-confirm-dialog__failure button'),
      HTMLButtonElement,
    );
    expect(action.textContent?.trim()).toBe('Refresh preview');
    expect(document.activeElement).toBe(action);
  });

  test('focus on the confirm button moves to Cancel when the confirm button goes and there is no action', async () => {
    const view = render(ConfirmDialog, { props: base });
    confirmButton(view.container).focus();
    await view.rerender({ confirmVisible: false, cancelLabel: 'Close' });
    await tick();
    const buttons = footerButtons(view.container);
    expect(buttons).toHaveLength(1);
    expect(document.activeElement).toBe(buttons[0] ?? null);
  });

  test('focus that is not on the confirm button is left where it is', async () => {
    const view = render(ConfirmDialog, { props: { ...base, closeOnConfirm: false } });
    const [cancel] = footerButtons(view.container);
    if (!cancel) throw new Error('Expected Cancel.');
    cancel.focus();
    await view.rerender({
      error: 'It failed.',
      errorAction: { label: 'Retry', onAction: () => {} },
    });
    await tick();
    expect(document.activeElement).toBe(cancel);
  });

  test('the typed confirmation sits in the footer above the buttons it gates, outside the scrolling body', () => {
    const { container } = render(ConfirmDialog, {
      props: { ...base, description: 'Deletes the key.', typeToConfirm: 'order-checker' },
    });
    const field = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__typed-confirmation'),
      HTMLElement,
    );
    expect(field.closest('.cinder-modal__body')).toBeNull();
    expect(field.closest('.cinder-modal__footer')).not.toBeNull();
    const actions = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__actions'),
      HTMLElement,
    );
    expect(field.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test('the confirm button has its status region from the start, so starting to load does not move it', async () => {
    const view = render(ConfirmDialog, { props: { ...base, closeOnConfirm: false } });
    const confirm = confirmButton(view.container);
    const status = confirm.nextElementSibling;
    expect(status?.hasAttribute('data-cinder-button-status')).toBe(true);
    await view.rerender({ busy: true });
    await tick();
    expect(confirmButton(view.container)).toBe(confirm);
    expect(confirm.nextElementSibling).toBe(status);
  });

  test('a dialog with nothing to show in its body renders an empty one, which Modal collapses', () => {
    const { container } = render(ConfirmDialog, {
      props: { ...base, error: 'It failed.', errorAction: { label: 'Retry', onAction: () => {} } },
    });
    const body = requiredInstance(container.querySelector('.cinder-modal__body'), HTMLElement);
    // Its template leaves whitespace between blocks, which `:empty` would not forgive, so the rule
    // is "no element in it".
    expect(body.children).toHaveLength(0);
    const css = readFileSync(new URL('./confirm-dialog.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.cinder-confirm-dialog \.cinder-modal__body:not\(:has\(> \*\)\) \{\s*display: none;/u,
    );
  });

  test('a control in options that carries autofocus takes the first focus before Cancel', async () => {
    const { container } = render(ConfirmDialog, {
      props: {
        ...base,
        confirmEnabled: false,
        options: html('<input aria-label="Signal name" autofocus />'),
      },
    });
    const dialog = requiredInstance(container.querySelector('dialog'), HTMLDialogElement);
    const field = requiredInstance(container.querySelector('input'), HTMLInputElement);
    const [cancel] = footerButtons(container);
    if (!cancel) throw new Error('Expected a Cancel button.');
    // Cancel still asks for focus, and the field comes before it in the dialog...
    expect(cancel.autofocus).toBe(true);
    expect(field.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // ...so the first control that asks, the one the native dialog and Modal's own initial focus
    // pick, is the field.
    const first = Array.from(dialog.querySelectorAll<HTMLElement>('*')).find(
      (element) => element.autofocus,
    );
    expect(first).toBe(field);
  });

  test('the alert region is mounted before the failure and empty without one', async () => {
    const view = render(ConfirmDialog, { props: base });
    const region = requiredInstance(
      view.container.querySelector('.cinder-confirm-dialog__failure'),
      HTMLElement,
    );
    expect(region.querySelector('.cinder-callout')).toBeNull();
    await view.rerender({ error: 'Nothing was removed.' });
    await tick();
    expect(region.querySelector('.cinder-callout')).not.toBeNull();
    expect(view.container.querySelector('.cinder-confirm-dialog__failure')).toBe(region);
  });

  test('the alert region sits in the footer above the actions, never in the scrolling body', () => {
    // On a short phone the body scrolls; a failure inside it would be a faded strip under the
    // footer with the next step out of view, so it is drawn outside the scroll, above the buttons.
    const { container } = render(ConfirmDialog, {
      props: { ...base, error: 'Nothing was removed.', errorTitle: 'Couldn’t delete the key.' },
    });
    const region = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__failure'),
      HTMLElement,
    );
    expect(region.closest('.cinder-modal__body')).toBeNull();
    expect(region.closest('.cinder-modal__footer')).not.toBeNull();
    const [firstButton] = footerButtons(container);
    if (!firstButton) throw new Error('Expected footer buttons.');
    expect(region.compareDocumentPosition(firstButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test('the typed text survives a failure and the confirm button stays armed to retry', async () => {
    const onConfirm = mock(() => {});
    const view = render(ConfirmDialog, {
      props: {
        ...base,
        title: 'Delete Order checker?',
        confirmLabel: 'Delete agent',
        typeToConfirm: 'order-checker',
        destructive: true,
        closeOnConfirm: false,
        onConfirm,
      },
    });
    const input = requiredInstance(view.container.querySelector('input'), HTMLInputElement);
    await fireEvent.input(input, { target: { value: 'order-checker' } });
    await fireEvent.click(confirmButton(view.container));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await view.rerender({
      error: 'Nothing was deleted.',
      errorTitle: 'Couldn’t delete the agent.',
      busy: false,
    });
    await tick();
    expect(input.value).toBe('order-checker');
    const button = confirmButton(view.container);
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.disabled).toBe(false);
    expect(button.textContent?.trim()).toBe('Delete agent');
    await fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  test('a blank error renders no callout', () => {
    const { container } = render(ConfirmDialog, { props: { ...base, error: '   ' } });
    expect(container.querySelector('.cinder-confirm-dialog__failure .cinder-callout')).toBeNull();
  });
});

describe('ConfirmDialog pending', () => {
  function renderPending(extra: Record<string, unknown> = {}) {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const view = render(ConfirmDialog, {
      props: {
        ...base,
        description: 'Deletes 47 workflows.',
        pending: true,
        pendingLabel: 'Counting the workflows',
        closeOnConfirm: false,
        onConfirm,
        onCancel,
        ...extra,
      },
    });
    return { ...view, onConfirm, onCancel };
  }

  test('the description and options regions show a skeleton in place of their content', () => {
    const { container } = renderPending({ options: html('<p>Kept: running workflows.</p>') });
    const description = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__description'),
      HTMLElement,
    );
    const options = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__options'),
      HTMLElement,
    );
    expect(description.querySelector('.cinder-skeleton-group')).not.toBeNull();
    expect(options.querySelector('.cinder-skeleton')).not.toBeNull();
    expect(container.textContent).not.toContain('Deletes 47 workflows.');
    expect(container.textContent).not.toContain('Kept: running workflows.');
  });

  test('the wait is announced once as a status', () => {
    const { container } = renderPending();
    const status = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__description [role="status"]'),
      HTMLElement,
    );
    expect(status.textContent).toBe('Counting the workflows');
  });

  test('the confirm button cannot be pressed', async () => {
    const { container, onConfirm } = renderPending();
    const button = confirmButton(container);
    expect(button.disabled).toBe(true);
    await fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('Cancel stays enabled and focusable, and it dismisses', async () => {
    const { container, onCancel } = renderPending();
    const cancel = requiredInstance(footerButtons(container).at(0) ?? null, HTMLButtonElement);
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute('aria-disabled')).toBeNull();
    cancel.focus();
    expect(document.activeElement).toBe(cancel);
    await fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('nothing describes the dialog while it waits, and the description returns with the answer', async () => {
    const view = renderPending();
    const dialog = requiredInstance(view.container.querySelector('dialog'), HTMLDialogElement);
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
    await view.rerender({ pending: false });
    await tick();
    expect(view.container.querySelector('.cinder-skeleton-group')).toBeNull();
    expect(
      view.container.querySelector('p.cinder-confirm-dialog__description')?.textContent,
    ).toContain('Deletes 47 workflows.');
    expect(dialog.hasAttribute('aria-describedby')).toBe(true);
  });

  test('the typed field waits, and what was typed for the old answer is gone with the new one', async () => {
    const view = renderPending({ pending: false, typeToConfirm: 'purge 47 workflows' });
    const input = requiredInstance(view.container.querySelector('input'), HTMLInputElement);
    await fireEvent.input(input, { target: { value: 'purge 47 workflows' } });
    expect(confirmButton(view.container).disabled).toBe(false);

    await view.rerender({ pending: true });
    await tick();
    expect(view.container.querySelector('input')).toBeNull();

    await view.rerender({ pending: false });
    await tick();
    const fresh = requiredInstance(view.container.querySelector('input'), HTMLInputElement);
    expect(fresh.value).toBe('');
    expect(confirmButton(view.container).disabled).toBe(true);
  });
});

describe('ConfirmDialog error action', () => {
  const failed = {
    ...base,
    closeOnConfirm: false,
    error: 'Nothing was purged. Check the new count before you purge.',
    errorTitle: 'The matching workflows changed',
  };

  test('the override renders in the callout in place of the confirm button, and runs its handler', async () => {
    const onAction = mock(() => {});
    const onConfirm = mock(() => {});
    const { container } = render(ConfirmDialog, {
      props: { ...failed, onConfirm, errorAction: { label: 'Refresh preview', onAction } },
    });
    const callout = requiredInstance(
      container.querySelector('.cinder-confirm-dialog__failure .cinder-callout'),
      HTMLElement,
    );
    const action = requiredInstance(callout.querySelector('button'), HTMLButtonElement);
    expect(action.textContent?.trim()).toBe('Refresh preview');
    // The default, the confirm button, is gone: Cancel is the one button of the actions row.
    expect(container.querySelectorAll('.cinder-confirm-dialog__actions button')).toHaveLength(1);
    expect(
      container.querySelector('.cinder-confirm-dialog__actions button')?.textContent?.trim(),
    ).toBe('Cancel');
    await fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('without an override the confirm button stays armed and no action is drawn', () => {
    const { container } = render(ConfirmDialog, { props: failed });
    expect(container.querySelector('.cinder-callout button')).toBeNull();
    expect(container.querySelectorAll('.cinder-confirm-dialog__actions button')).toHaveLength(2);
  });

  test('the override is drawn only while there is a failure to attach it to', async () => {
    const view = render(ConfirmDialog, {
      props: { ...base, errorAction: { label: 'Retry', onAction: () => {} } },
    });
    const actions = () => view.container.querySelectorAll('.cinder-confirm-dialog__actions button');
    expect(actions()).toHaveLength(2);
    await view.rerender({ error: 'It failed.' });
    await tick();
    expect(actions()).toHaveLength(1);
    await view.rerender({ error: undefined });
    await tick();
    expect(actions()).toHaveLength(2);
  });

  test('a fault that carries an action leaves Close compact on a phone, an exception to the lone-action rule (owner, 2026-11-21)', () => {
    const faultOnly = render(ConfirmDialog, {
      props: { ...failed, errorAction: { label: 'Refresh preview', onAction: () => {} } },
    });
    const row = requiredInstance(
      faultOnly.container.querySelector('.cinder-confirm-dialog__actions'),
      HTMLElement,
    );
    // Close is the only button of the row, and the action that leads is in the callout above it.
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(row.hasAttribute('data-cinder-fault-only')).toBe(true);

    // The rule that makes it compact sits in modal.css beside the docked "a lone action fills the
    // row" it is the exception to, and is covered in modal-sheet.test.ts.
    cleanup();

    // A failure with no action of its own keeps both buttons, and a row that is lone because there
    // is nothing to confirm keeps filling: neither is marked.
    const armed = render(ConfirmDialog, { props: failed });
    expect(
      armed.container
        .querySelector('.cinder-confirm-dialog__actions')
        ?.hasAttribute('data-cinder-fault-only'),
    ).toBe(false);
    cleanup();
    const nothingToConfirm = render(ConfirmDialog, {
      props: { ...base, confirmVisible: false, cancelLabel: 'Close' },
    });
    expect(
      nothingToConfirm.container
        .querySelector('.cinder-confirm-dialog__actions')
        ?.hasAttribute('data-cinder-fault-only'),
    ).toBe(false);
  });

  test('errorTone draws the callout as a warning, and danger by default', () => {
    const warning = render(ConfirmDialog, { props: { ...failed, errorTone: 'warning' } });
    expect(
      warning.container.querySelector('.cinder-callout')?.getAttribute('data-cinder-variant'),
    ).toBe('warning');
    cleanup();
    const danger = render(ConfirmDialog, { props: failed });
    expect(
      danger.container.querySelector('.cinder-callout')?.getAttribute('data-cinder-variant'),
    ).toBe('danger');
  });
});

describe('ConfirmDialog confirm enabled and visible', () => {
  test('confirmEnabled={false} disables the confirm button until it is true', async () => {
    const view = render(ConfirmDialog, { props: { ...base, confirmEnabled: false } });
    expect(confirmButton(view.container).disabled).toBe(true);
    await view.rerender({ confirmEnabled: true });
    await tick();
    expect(confirmButton(view.container).disabled).toBe(false);
  });

  test('confirmVisible={false} leaves Cancel as the one action', () => {
    const { container } = render(ConfirmDialog, {
      props: { ...base, confirmVisible: false, cancelLabel: 'Close' },
    });
    const labels = footerButtons(container).map((button) => button.textContent?.trim());
    expect(labels).toEqual(['Close']);
  });
});
