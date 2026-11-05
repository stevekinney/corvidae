import { setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, mock, test } from 'bun:test';
setupHappyDom();
const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Button } = await import('./button.svelte');
afterEach(cleanup);

describe('Button rendering', () => {
  test('renders a <button> when no href is provided', () => {
    const { container } = render(Button, { props: { label: 'click me' } });
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  test('renders an <a> when href is provided', () => {
    const { container } = render(Button, { props: { href: '/target', label: 'go' } });
    expect(container.querySelector('a')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  test('a standalone Button (no ButtonGroup ancestor) does not carry the group styling-contract attribute (COR-459)', () => {
    const { container } = render(Button, { props: { label: 'click me' } });
    expect(container.querySelector('button')?.hasAttribute('data-cinder-button-group-item')).toBe(
      false,
    );
  });

  test('button applies variant + size as data attributes', () => {
    const { container } = render(Button, {
      props: { label: 'tag', variant: 'danger', size: 'lg' },
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(button?.getAttribute('data-cinder-size')).toBe('lg');
  });

  test('supports the ghost-danger variant', () => {
    const { container } = render(Button, {
      props: { label: 'Remove', variant: 'ghost-danger' },
    });

    expect(container.querySelector('button')?.getAttribute('data-cinder-variant')).toBe(
      'ghost-danger',
    );
  });

  test('supports the ghost-accent variant', () => {
    const { container } = render(Button, {
      props: { label: 'Undo', variant: 'ghost-accent' },
    });

    expect(container.querySelector('button')?.getAttribute('data-cinder-variant')).toBe(
      'ghost-accent',
    );
  });

  test('loading button is aria-disabled and aria-busy, and stays focusable (no native disabled)', () => {
    const { container } = render(Button, { props: { label: 'sending', loading: true } });
    const button = container.querySelector('button');
    expect(button?.hasAttribute('disabled')).toBe(false);
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('data-cinder-loading')).toBe('');
  });

  test('reactively forwards popover trigger ARIA to the native button', async () => {
    const { container, rerender } = render(Button, {
      props: {
        label: 'Toggle',
        'aria-controls': 'panel-a',
        'aria-expanded': 'true',
        'aria-haspopup': 'dialog',
      },
    });
    const button = container.querySelector('button');

    expect(button?.getAttribute('aria-controls')).toBe('panel-a');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
    await rerender({
      label: 'Toggle',
      'aria-controls': undefined,
      'aria-expanded': 'false',
      'aria-haspopup': 'menu',
    });
    expect(button?.hasAttribute('aria-controls')).toBe(false);
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.getAttribute('aria-haspopup')).toBe('menu');
  });

  test('loading link removes href and is un-tab-reachable', () => {
    const { container } = render(Button, {
      props: { href: '/target', label: 'go', loading: true },
    });
    const anchor = container.querySelector('a');
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(anchor?.getAttribute('tabindex')).toBe('-1');
    expect(anchor?.getAttribute('aria-disabled')).toBe('true');
    expect(anchor?.getAttribute('aria-busy')).toBe('true');
  });

  test('loading link does NOT invoke consumer onclick', () => {
    let invocationCount = 0;
    const { container } = render(Button, {
      props: {
        href: '/target',
        label: 'go',
        loading: true,
        onclick: () => {
          invocationCount += 1;
        },
      },
    });
    const anchor = container.querySelector('a');
    anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(invocationCount).toBe(0);
  });

  test('non-loading link DOES invoke consumer onclick', () => {
    let invocationCount = 0;
    const { container } = render(Button, {
      props: {
        href: '/target',
        label: 'go',
        onclick: () => {
          invocationCount += 1;
        },
      },
    });
    const anchor = container.querySelector('a');
    anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(invocationCount).toBe(1);
  });

  test('consumer-provided aria-disabled survives when not loading', () => {
    const { container } = render(Button, {
      props: { label: 'x', 'aria-disabled': 'true' },
    });
    const button = container.querySelector('button');
    // Consumer set aria-disabled='true' manually; not loading, so we preserve it.
    expect(button?.getAttribute('aria-disabled')).toBe('true');
  });

  test('consumer class name merges with .cinder-button', () => {
    const { container } = render(Button, {
      props: { label: 'x', class: 'my-extra-class' },
    });
    const classAttr = container.querySelector('button')?.getAttribute('class') ?? '';
    expect(classAttr).toContain('cinder-button');
    expect(classAttr).toContain('my-extra-class');
  });

  test('rest attributes forward to rendered <button> elements', () => {
    const { container } = render(Button, {
      props: { label: 'Save', 'data-testid': 'button-rest-target' },
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('data-testid')).toBe('button-rest-target');
  });

  test('rest attributes forward to rendered <a> elements', () => {
    const { container } = render(Button, {
      props: { href: '/target', label: 'Open', 'data-testid': 'link-rest-target' },
    });
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('data-testid')).toBe('link-rest-target');
  });
});

describe('Button variants — new additions', () => {
  test('soft variant applies data-cinder-variant="soft"', () => {
    const { container } = render(Button, { props: { label: 'Soft', variant: 'soft' } });
    expect(container.querySelector('button')?.getAttribute('data-cinder-variant')).toBe('soft');
  });

  test('soft-danger variant applies data-cinder-variant="soft-danger"', () => {
    const { container } = render(Button, {
      props: { label: 'Delete', variant: 'soft-danger' },
    });
    expect(container.querySelector('button')?.getAttribute('data-cinder-variant')).toBe(
      'soft-danger',
    );
  });
});

describe('Button loading state', () => {
  test('loading + label: label text remains in DOM', () => {
    const { getByText } = render(Button, { props: { label: 'Saving', loading: true } });
    // Label must remain in the DOM as the accessible name throughout loading.
    expect(getByText('Saving')).not.toBeNull();
  });

  test('loading + label: no DOM spinner node (spinner is a CSS pseudo-element)', () => {
    const { container } = render(Button, { props: { label: 'Saving', loading: true } });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.cinder-spinner')).toBeNull();
  });

  test('a loading button keeps focus and ignores a second press', async () => {
    const onclick = mock(() => {});
    const { container, rerender } = render(Button, { props: { label: 'Save', onclick } });
    const button = container.querySelector('button')!;
    button.focus();
    await rerender({ label: 'Save', onclick, loading: true });
    expect(document.activeElement).toBe(button);
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(onclick).not.toHaveBeenCalled();
  });

  test('loadingStatus is a polite status beside the button, filled only while loading', async () => {
    const { container, rerender } = render(Button, {
      props: { label: 'Save', loadingStatus: 'Saving…' },
    });
    const status = container.querySelector('[role="status"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    // The node is mounted before it has text, so the announcement is not lost.
    expect(status.textContent).toBe('');
    // It sits outside the button: it must not become part of the button's accessible name.
    expect(container.querySelector('button')!.contains(status)).toBe(false);
    await rerender({ label: 'Save', loadingStatus: 'Saving…', loading: true });
    expect(container.querySelector('[role="status"]')!.textContent).toBe('Saving…');
    await rerender({ label: 'Save', loadingStatus: 'Saving…', loading: false });
    expect(container.querySelector('[role="status"]')!.textContent).toBe('');
  });

  test('no status node is rendered without loadingStatus', () => {
    const { container } = render(Button, { props: { label: 'Save', loading: true } });
    expect(container.querySelector('[data-cinder-button-status]')).toBeNull();
  });

  test('loading pins the width the button had at rest, and releases it afterwards', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 96,
    });
    try {
      const { container, rerender } = render(Button, { props: { label: 'Save' } });
      expect(container.querySelector('button')!.style.inlineSize).toBe('');
      await rerender({ label: 'Save', loading: true });
      expect(container.querySelector('button')!.style.inlineSize).toBe('96px');
      await rerender({ label: 'Save', loading: false });
      expect(container.querySelector('button')!.style.inlineSize).toBe('');
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptor);
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    }
  });

  /** An `offsetWidth` that is the pin while one is set, and the words' own width when none is. */
  function withNaturalWidths(natural: (text: string) => number, run: () => Promise<void>) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.style.inlineSize
          ? Number.parseFloat(this.style.inlineSize)
          : natural(this.textContent ?? '');
      },
    });
    return run().finally(() => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptor);
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    });
  }

  test('longer words that come with loading let the width go, so they never spill', async () => {
    await withNaturalWidths(
      (text) => (text.includes('Creating') ? 100 : 64),
      async () => {
        const { container, rerender } = render(Button, { props: { label: 'Create' } });
        await rerender({ label: 'Creating…', loading: true });
        expect(container.querySelector('button')!.style.inlineSize).toBe('');
        await rerender({ label: 'Create', loading: false });
        await rerender({ label: 'Create', loading: true });
        expect(container.querySelector('button')!.style.inlineSize).toBe('64px');
      },
    );
  });

  test('shorter words that come with loading keep the pinned width', async () => {
    await withNaturalWidths(
      (text) => (text.includes('Testing') ? 94 : 121),
      async () => {
        const { container, rerender } = render(Button, { props: { label: 'Test connection' } });
        await rerender({ label: 'Testing…', loading: true });
        expect(container.querySelector('button')!.style.inlineSize).toBe('121px');
      },
    );
  });

  test('a full-width loading button does not pin a width', async () => {
    const { container, rerender } = render(Button, { props: { label: 'Save', fullWidth: true } });
    await rerender({ label: 'Save', fullWidth: true, loading: true });
    expect(container.querySelector('button')!.style.inlineSize).toBe('');
  });
});

describe('Button inert (aria-disabled) state', () => {
  test('an aria-disabled button stays focusable and does not run onclick', async () => {
    const onclick = mock(() => {});
    const { container } = render(Button, {
      props: { label: 'New chat', 'aria-disabled': 'true', onclick },
    });
    const button = container.querySelector('button')!;
    expect(button.hasAttribute('disabled')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    await fireEvent.click(button);
    expect(onclick).not.toHaveBeenCalled();
  });

  test('aria-disabled="false" still runs onclick', async () => {
    const onclick = mock(() => {});
    const { container } = render(Button, {
      props: { label: 'New chat', 'aria-disabled': 'false', onclick },
    });
    await fireEvent.click(container.querySelector('button')!);
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  test('an aria-disabled link does not navigate or run onclick', async () => {
    const onclick = mock(() => {});
    const { container } = render(Button, {
      props: { label: 'Go', href: '/x', 'aria-disabled': 'true', onclick },
    });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    container.querySelector('a')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onclick).not.toHaveBeenCalled();
  });

  test('a consumer aria-disabled link drops its href but stays a focusable link', () => {
    const { container } = render(Button, {
      props: { label: 'Go', href: '/x', 'aria-disabled': 'true' },
    });
    const anchor = container.querySelector('a')!;
    expect(anchor.hasAttribute('href')).toBe(false);
    expect(anchor.getAttribute('role')).toBe('link');
    expect(anchor.getAttribute('tabindex')).toBe('0');
    expect(anchor.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Button ghost-danger disabled state', () => {
  test('ghost-danger disabled button preserves data attributes', () => {
    const { container } = render(Button, {
      props: { label: 'Delete', variant: 'ghost-danger', 'aria-disabled': 'true' },
    });
    const button = container.querySelector('button');
    expect(button?.getAttribute('data-cinder-variant')).toBe('ghost-danger');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
  });
});
