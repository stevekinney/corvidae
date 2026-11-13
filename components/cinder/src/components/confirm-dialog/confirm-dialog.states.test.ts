/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

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

  test('options render below the description and above the typed confirmation', () => {
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
    expect(order[2]).toContain('cinder-input-field');
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
  test('shows a danger callout with a bold lead inside an alert region', () => {
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
    expect(callout.querySelector('strong')?.textContent).toBe('Couldn’t delete the key.');
    expect(callout.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Couldn’t delete the key. Nothing was removed.',
    );
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
