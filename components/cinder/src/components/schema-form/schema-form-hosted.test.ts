/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredValue, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');

// load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A step's input: a short field, a group of fields, and a list of objects. */
const schema = {
  type: 'object',
  properties: {
    subject: { type: 'string', title: 'Subject' },
    sender: {
      type: 'object',
      title: 'Sender',
      properties: { name: { type: 'string', title: 'Name' } },
    },
    recipients: {
      type: 'array',
      title: 'Recipients',
      items: { type: 'object', properties: { address: { type: 'string', title: 'Address' } } },
    },
  },
  required: ['subject'],
};

async function mount(hosted: boolean, value?: unknown) {
  const drafts: unknown[] = [];
  const view = render(SchemaForm, {
    props: {
      schema,
      hosted,
      ...(value === undefined ? {} : { value }),
      onDraftChange: (next: unknown) => void drafts.push(next),
    },
  });
  await flush();
  return { ...view, drafts };
}

describe('SchemaForm hosted', () => {
  afterEach(() => cleanup());

  test('is a group, not a form, with no submit button and no hidden output field', async () => {
    const { container } = await mount(true);
    expect(container.querySelector('form')).toBeNull();
    const root = requiredValue(container.querySelector('.cinder-schema-form'));
    expect(root.tagName).toBe('DIV');
    expect(root.getAttribute('role')).toBe('group');
    expect(root.hasAttribute('data-cinder-hosted')).toBe(true);
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  test('keeps the form, its submit button and its hidden output field by default', async () => {
    const { container } = await mount(false);
    const root = requiredValue(container.querySelector('form'));
    expect(root.hasAttribute('data-cinder-hosted')).toBe(false);
    expect(container.querySelector('button[type="submit"]')).not.toBeNull();
    expect(container.querySelector('input[type="hidden"]')).not.toBeNull();
  });

  test('still reports every draft, and draws a group and an array item as the default does', async () => {
    const { container, drafts } = await mount(true, { subject: 'Hello', recipients: [{}] });
    const subject = requiredValue(container.querySelector('input'));
    await fireEvent.input(subject, { target: { value: 'Hi' } });
    await flush();
    expect(drafts.at(-1)).toMatchObject({ subject: 'Hi' });
    // The sender group, the recipients list, and the object inside its one item.
    expect(container.querySelectorAll('fieldset.cinder-schema-form__fieldset').length).toBe(3);
    expect(container.querySelectorAll('.cinder-schema-form__array-item').length).toBe(1);
  });

  test('offers no Edit as JSON panel on a large form', async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`field${String(index)}`, { type: 'string' }]),
    );
    const view = render(SchemaForm, {
      props: { schema: { type: 'object', properties }, hosted: true },
    });
    await flush();
    expect(view.container.textContent).toContain('Find a field');
    expect(view.container.textContent).not.toContain('Edit as JSON');
    cleanup();
    const plain = render(SchemaForm, {
      props: { schema: { type: 'object', properties } },
    });
    await flush();
    expect(plain.container.textContent).toContain('Edit as JSON');
  });
});
