/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');

// load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The Input block of a triage page: two short fields that share a row, one that does not, and a switch. */
const triage = {
  type: 'object',
  properties: {
    folder: { type: 'string', title: 'Folder' },
    messages: { type: 'string', title: 'Messages', enum: ['unread', 'all'] },
    limit: { type: 'integer', title: 'Limit', enum: [25, 50] },
    flagUrgent: {
      type: 'boolean',
      title: 'Flag urgent messages',
      description: 'Mark anything that looks urgent for a review.',
    },
  },
  required: ['folder'],
};

const refund = {
  type: 'object',
  properties: {
    orderNumber: { type: 'string', title: 'Order number' },
    lineItems: {
      type: 'array',
      title: 'Line items',
      items: {
        type: 'object',
        properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
      },
    },
  },
  required: ['orderNumber', 'lineItems'],
};

async function mount(schema: Record<string, unknown>, variant?: 'input', value?: unknown) {
  const submitted: unknown[] = [];
  const view = render(SchemaForm, {
    props: {
      schema,
      ...(variant === undefined ? {} : { variant }),
      ...(value === undefined ? {} : { value }),
      onSubmit: (next: unknown) => void submitted.push(next),
    },
  });
  await flush();
  return { ...view, submitted };
}

describe('SchemaForm input variant', () => {
  afterEach(() => cleanup());

  test('draws a boolean as a switch with its description, and the default variant keeps the checkbox', async () => {
    const input = await mount(triage, 'input');
    const toggle = screen.getByRole('switch', { name: 'Flag urgent messages' });
    expect(toggle.getAttribute('aria-describedby')).not.toBeNull();
    // The explanation sits under the label, with the switch beside both.
    expect(
      input.container
        .querySelector('.cinder-toggle-field')
        ?.getAttribute('data-cinder-description'),
    ).toBe('below');
    expect(input.container.textContent).toContain('Mark anything that looks urgent for a review.');
    expect(input.container.querySelector('input[type="checkbox"][role="checkbox"]')).toBeNull();
    cleanup();

    const plain = await mount(triage);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(plain.container.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  test('pairs short fields on a grid and gives the switch the whole row, in a form of any size', async () => {
    const { container } = await mount(triage, 'input');
    const fields = requiredInstance(
      container.querySelector('.cinder-schema-form__fields'),
      HTMLElement,
    );
    expect(fields.getAttribute('data-cinder-columns')).toBe('two');
    const spans = Array.from(fields.children).map((child) =>
      child.getAttribute('data-cinder-span'),
    );
    // Folder, Messages and Limit are short; the switch is not.
    expect(spans).toEqual([null, null, null, 'full']);
    cleanup();

    const plain = await mount(triage);
    expect(
      plain.container
        .querySelector('.cinder-schema-form__fields')
        ?.getAttribute('data-cinder-columns'),
    ).toBeNull();
  });

  test('draws an array of objects as a JSON editor that counts its items, and submits what it holds', async () => {
    const { container, submitted } = await mount(refund, 'input', {
      orderNumber: '4398',
      lineItems: [{ sku: 'mug-12', quantity: 1 }],
    });
    const editor = requiredInstance(container.querySelector('textarea'), HTMLTextAreaElement);
    expect(container.textContent).toContain('Valid JSON · array of 1 item');
    expect(container.textContent).not.toContain('Add Line items');

    await fireEvent.input(editor, {
      target: { value: '[{"sku":"mug-12","quantity":1},{"sku":"cup-4","quantity":2}]' },
    });
    await flush();
    expect(container.textContent).toContain('Valid JSON · array of 2 items');

    const form = requiredInstance(container.querySelector('form'), HTMLFormElement);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    expect(submitted).toEqual([
      {
        orderNumber: '4398',
        lineItems: [
          { sku: 'mug-12', quantity: 1 },
          { sku: 'cup-4', quantity: 2 },
        ],
      },
    ]);
  });

  test('keeps the generic item groups for an array of objects in the default variant', async () => {
    const { container } = await mount(refund, undefined, { orderNumber: '4398', lineItems: [] });
    expect(container.textContent).toContain('Add Line items');
  });
});
