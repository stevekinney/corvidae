/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const { createSchemaFormModel, countLeafFields } = await import('./schema-form-model.ts');
const { summarizeGroup } = await import('./schema-form-summary.ts');

// load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function submit(container: HTMLElement): Promise<void> {
  const form = requiredInstance(container.querySelector('form'), HTMLFormElement);
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  await flush();
}

/** Eighteen fields: required and optional ones interleaved, one record, one required group, one optional group. */
const largeSchema = {
  type: 'object',
  title: 'Order change',
  properties: {
    note: { type: 'string', title: 'Note' },
    shipping: {
      type: 'object',
      title: 'Shipping',
      properties: {
        carrier: { type: 'string', title: 'Carrier', minLength: 1 },
        trackingNumber: { type: 'string', title: 'Tracking Number' },
        expedited: { type: 'boolean', title: 'Expedited' },
      },
      required: ['carrier'],
    },
    orderId: { type: 'string', title: 'Order ID' },
    priority: { type: 'string', title: 'Priority', enum: ['low', 'high'] },
    reason: { type: 'string', title: 'Reason', enum: ['damaged', 'late'] },
    billing: {
      type: 'object',
      title: 'Billing',
      properties: {
        currency: { type: 'string', title: 'Currency', default: 'USD' },
        retryCount: { type: 'integer', title: 'Retry Count', default: 3 },
        taxId: { type: 'string', title: 'Tax ID' },
      },
    },
    quantity: { type: 'integer', title: 'Quantity' },
    notifyCustomer: { type: 'boolean', title: 'Notify customer' },
    labels: { type: 'array', title: 'Labels', items: { type: 'string' } },
    channels: { type: 'array', title: 'Channels', items: { enum: ['email', 'sms'] } },
    timeoutMs: { type: 'integer', title: 'Timeout' },
    headers: { type: 'object', title: 'Headers', additionalProperties: { type: 'string' } },
    comment: { type: 'string', title: 'Comment' },
    giftWrap: { type: 'boolean', title: 'Gift wrap' },
  },
  required: ['orderId', 'reason', 'quantity', 'billing'],
};

const largeValue = { orderId: 'A-1', reason: 'damaged', quantity: 2 };

async function mountLarge(
  value: unknown = largeValue,
  schema: Record<string, unknown> = largeSchema,
) {
  const submitted: unknown[] = [];
  const view = render(SchemaForm, {
    props: { schema, value, onSubmit: (next: unknown) => void submitted.push(next) },
  });
  await flush();
  return { ...view, submitted };
}

function follows(first: HTMLElement, second: HTMLElement): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('SchemaForm large schemas', () => {
  afterEach(() => cleanup());

  test('the fixture counts eighteen fields', () => {
    expect(countLeafFields(createSchemaFormModel(largeSchema).field)).toBe(18);
  });

  test('lists required fields before optional ones', async () => {
    await mountLarge();

    const orderId = screen.getByLabelText(/Order ID/);
    const quantity = screen.getByRole('spinbutton', { name: /Quantity/ });
    const billing = screen.getByRole('button', { name: /Billing/ });
    const note = screen.getByLabelText(/Note/);
    const shipping = screen.getByRole('button', { name: /Shipping/ });
    const comment = screen.getByLabelText(/Comment/);

    for (const required of [orderId, quantity, billing]) {
      for (const optional of [note, shipping, comment]) {
        expect(follows(required, optional)).toBe(true);
      }
    }
    expect(follows(orderId, quantity)).toBe(true);
  });

  test('opens required groups, closes optional ones, and summarizes a closed group', async () => {
    await mountLarge();

    expect(screen.getByRole('button', { name: /Billing/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByLabelText(/Currency/)).toBeTruthy();

    const shipping = screen.getByRole('button', { name: /Shipping/ });
    expect(shipping.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/Tracking Number/)).toBeNull();
    expect(shipping.textContent).toContain('Carrier, Tracking Number… · none set');
  });

  test('a closed group summarizes the values it holds', async () => {
    await mountLarge();

    await fireEvent.click(screen.getByRole('button', { name: /Shipping/ }));
    await fireEvent.input(screen.getByLabelText(/Carrier/), { target: { value: 'UPS' } });
    await fireEvent.click(screen.getByRole('checkbox', { name: /Expedited/ }));
    await fireEvent.click(screen.getByRole('button', { name: /Shipping/ }));

    const shipping = screen.getByRole('button', { name: /Shipping/ });
    expect(shipping.getAttribute('aria-expanded')).toBe('false');
    expect(shipping.textContent).toContain('UPS · Expedited');
  });

  test('summarizes defaults and set values per group', () => {
    const model = createSchemaFormModel(largeSchema);
    const billing = model.field.fields.find((field) => field.key === 'billing')!;
    expect(
      summarizeGroup(billing, { billing: { currency: 'USD', retryCount: 3, taxId: '' } }),
    ).toBe('Currency, Retry Count… · defaults');
    expect(
      summarizeGroup(billing, { billing: { currency: 'EUR', retryCount: 5, taxId: '' } }),
    ).toBe('EUR · 5');
  });

  test('offers Find a field past eight fields and narrows to matches', async () => {
    await mountLarge();

    const find = screen.getByRole('searchbox', { name: 'Find a field' });
    await fireEvent.input(find, { target: { value: 'tracking' } });

    expect(screen.getByLabelText(/Tracking Number/)).toBeTruthy();
    expect(screen.queryByLabelText(/Note/)).toBeNull();
    expect(screen.queryByLabelText(/Order ID/)).toBeNull();

    await fireEvent.input(find, { target: { value: 'nothing like this' } });
    expect(screen.getByRole('status').textContent).toContain('No fields match');

    await fireEvent.input(find, { target: { value: '' } });
    expect(screen.getByLabelText(/Order ID/)).toBeTruthy();
  });

  test('Enter in Find a field does not submit the form', async () => {
    const { submitted } = await mountLarge();

    const notPrevented = await fireEvent.keyDown(
      screen.getByRole('searchbox', { name: 'Find a field' }),
      { key: 'Enter' },
    );

    expect(notPrevented).toBe(false);
    expect(submitted).toEqual([]);
  });

  test('a failed submit clears the filter and opens the group holding the error', async () => {
    const { container, submitted } = await mountLarge({
      ...largeValue,
      shipping: { carrier: '' },
    });
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a field' }), {
      target: { value: 'note' },
    });

    await submit(container);

    expect(submitted).toEqual([]);
    expect(
      requiredInstance(screen.getByRole('searchbox', { name: 'Find a field' }), HTMLInputElement)
        .value,
    ).toBe('');
    expect(screen.getByRole('button', { name: /Shipping/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByText('Carrier is too short.')).toBeTruthy();
  });

  test('lays short fields in two columns and gives wide controls the whole row', async () => {
    const { container } = await mountLarge();

    const root = requiredInstance(
      container.querySelector('form > .cinder-schema-form__fields'),
      HTMLElement,
    );
    expect(root.getAttribute('data-cinder-columns')).toBe('two');
    expect(screen.getByRole('group', { name: 'Headers' }).getAttribute('data-cinder-span')).toBe(
      'full',
    );
    expect(screen.getByRole('group', { name: 'Channels' }).getAttribute('data-cinder-span')).toBe(
      'full',
    );
    const orderField = requiredInstance(
      screen.getByLabelText(/Order ID/).closest('.cinder-schema-form__field'),
      HTMLElement,
    );
    expect(orderField.getAttribute('data-cinder-span')).toBeNull();
  });

  test('renders each new shape inside a large form instead of raw JSON', async () => {
    const { container } = await mountLarge({ ...largeValue, labels: ['a'], headers: { H: '1' } });

    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'sms' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /Labels/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Timeout unit' })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Headers' })).getByDisplayValue('H'),
    ).toBeTruthy();
  });

  test('Edit as JSON replaces the whole input and reports why it refuses bad JSON', async () => {
    const { container, submitted } = await mountLarge();

    await fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    const editor = screen.getByRole('textbox', { name: /Input as JSON/ });
    expect(requiredInstance(editor, HTMLTextAreaElement).value).toContain('"orderId": "A-1"');

    await fireEvent.input(editor, { target: { value: '{ not json' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Apply JSON' }));
    expect(screen.getByRole('textbox', { name: /Input as JSON/ })).toBeTruthy();

    await fireEvent.input(editor, { target: { value: '[1]' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Apply JSON' }));
    expect(screen.getByText('The input must be a JSON object.')).toBeTruthy();

    await fireEvent.input(editor, {
      target: {
        value: JSON.stringify({
          orderId: 'Z-9',
          reason: 'late',
          quantity: 4,
          labels: ['pasted'],
          timeoutMs: 2000,
          shipping: { carrier: 'UPS' },
          headers: { Pasted: '1' },
        }),
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Apply JSON' }));

    expect(screen.queryByRole('textbox', { name: /Input as JSON/ })).toBeNull();
    expect(requiredInstance(screen.getByLabelText(/Order ID/), HTMLInputElement).value).toBe('Z-9');
    expect(container.textContent).toContain('pasted');
    expect(screen.getByDisplayValue('Pasted')).toBeTruthy();
    await submit(container);
    expect(submitted.at(-1)).toMatchObject({
      orderId: 'Z-9',
      reason: 'late',
      quantity: 4,
      labels: ['pasted'],
      timeoutMs: 2000,
      headers: { Pasted: '1' },
    });
  });
});

describe('SchemaForm large schemas: review corrections', () => {
  afterEach(() => cleanup());

  test('picks a fresh duration unit when Edit as JSON replaces the value', async () => {
    await mountLarge({ ...largeValue, timeoutMs: 90_000 });
    const unit = () =>
      requiredInstance(screen.getByRole('combobox', { name: 'Timeout unit' }), HTMLSelectElement);
    expect(unit().value).toBe('s');

    await fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    await fireEvent.input(screen.getByRole('textbox', { name: /Input as JSON/ }), {
      target: { value: JSON.stringify({ ...largeValue, timeoutMs: 7_200_000 }) },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Apply JSON' }));

    expect(unit().value).toBe('h');
    expect(
      requiredInstance(screen.getByRole('spinbutton', { name: /Timeout/ }), HTMLInputElement).value,
    ).toBe('2');
  });

  test('keeps the unit the person chose while they edit the number', async () => {
    await mountLarge({ ...largeValue, timeoutMs: 90_000 });

    await fireEvent.change(screen.getByRole('combobox', { name: 'Timeout unit' }), {
      target: { value: 'min' },
    });
    const number = screen.getByRole('spinbutton', { name: /Timeout/ });
    await fireEvent.input(number, { target: { value: '1.5' } });
    await fireEvent.blur(number);

    expect(
      requiredInstance(screen.getByRole('combobox', { name: 'Timeout unit' }), HTMLSelectElement)
        .value,
    ).toBe('min');
  });

  test('a tag typed but not committed survives the field being filtered out', async () => {
    const { submitted, container } = await mountLarge({
      ...largeValue,
      shipping: { carrier: 'UPS' },
    });
    const labels = () =>
      requiredInstance(screen.getByRole('textbox', { name: /Labels/ }), HTMLInputElement);
    const search = screen.getByRole('searchbox', { name: 'Find a field' });

    await fireEvent.input(labels(), { target: { value: 'pending' } });
    await fireEvent.input(search, { target: { value: 'note' } });
    expect(screen.queryByRole('textbox', { name: /Labels/ })).toBeNull();

    await fireEvent.input(search, { target: { value: '' } });
    expect(labels().value).toBe('pending');

    await fireEvent.input(search, { target: { value: 'note' } });
    await submit(container);
    expect(submitted.at(-1)).toMatchObject({ labels: ['pending'] });
  });

  test('a tag typed in a group that is then closed is still submitted', async () => {
    const { submitted, container } = await mountLarge(
      { ...largeValue, shipping: { carrier: 'UPS' } },
      {
        type: 'object',
        properties: {
          ...largeSchema.properties,
          extras: {
            type: 'object',
            title: 'Extras',
            properties: { aliases: { type: 'array', title: 'Aliases', items: { type: 'string' } } },
            required: [],
          },
        },
        required: ['orderId', 'reason', 'quantity', 'billing', 'extras'],
      },
    );

    await fireEvent.input(screen.getByRole('textbox', { name: /Aliases/ }), {
      target: { value: 'nickname' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Extras/ }));
    expect(screen.queryByRole('textbox', { name: /Aliases/ })).toBeNull();
    await submit(container);

    expect(submitted.at(-1)).toMatchObject({ extras: { aliases: ['nickname'] } });
  });

  test('jsonEditable={false} hides the built-in Edit as JSON but keeps Find a field', async () => {
    const view = render(SchemaForm, { props: { schema: largeSchema, jsonEditable: false } });
    await flush();

    expect(screen.queryByRole('button', { name: 'Edit as JSON' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Find a field' })).toBeTruthy();
    view.unmount();
  });
});

describe('SchemaForm small schemas', () => {
  afterEach(() => cleanup());

  test('keep the stacked layout: no Find a field, no Edit as JSON, nested objects stay fieldsets', async () => {
    const { container } = await mountLarge(
      { name: 'x', nested: { owner: 'y' } },
      {
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Name' },
          nested: {
            type: 'object',
            title: 'Nested',
            properties: { owner: { type: 'string', title: 'Owner' } },
          },
        },
      },
    );

    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit as JSON' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Nested' })).toBeTruthy();
    expect(container.querySelector('[data-cinder-columns]')).toBeNull();
  });
});
