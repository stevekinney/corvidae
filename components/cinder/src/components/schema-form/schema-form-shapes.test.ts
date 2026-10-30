/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const { createSchemaFormModel } = await import('./schema-form-model.ts');
const { DURATION_UNITS, durationUnitFor, fromMilliseconds, toMilliseconds } =
  await import('./schema-form-duration.ts');

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

async function mount(schema: Record<string, unknown>, value: unknown) {
  const submitted: unknown[] = [];
  const view = render(SchemaForm, {
    props: { schema, value, onSubmit: (next: unknown) => void submitted.push(next) },
  });
  await flush();
  return { ...view, submitted };
}

/** The fallback this work replaces: a monospace textarea holding raw JSON. */
function rawJsonTextareas(container: HTMLElement): HTMLTextAreaElement[] {
  return Array.from(container.querySelectorAll('textarea'));
}

describe('SchemaForm shapes: enum arrays as toggle chips', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        title: 'Channels',
        uniqueItems: true,
        items: { enum: ['email', 'sms', 'push'] },
      },
    },
  };

  test('renders one toggle chip per option instead of raw JSON', async () => {
    const { container } = await mount(schema, { channels: ['sms'] });

    expect(rawJsonTextareas(container)).toHaveLength(0);
    const group = screen.getByRole('group', { name: 'Channels' });
    expect(within(group).getByRole('button', { name: 'email' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(within(group).getByRole('button', { name: 'sms' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  test('toggling chips submits the chosen options in schema order', async () => {
    const { container, submitted } = await mount(schema, { channels: ['sms'] });

    await fireEvent.click(screen.getByRole('button', { name: 'push' }));
    await fireEvent.click(screen.getByRole('button', { name: 'email' }));
    await fireEvent.click(screen.getByRole('button', { name: 'sms' }));
    await submit(container);

    expect(submitted).toEqual([{ channels: ['email', 'push'] }]);
  });

  test('keeps values the schema does not list when a chip is toggled', async () => {
    const { container, submitted } = await mount(
      { type: 'object', properties: { channels: { type: 'array', items: { enum: ['a', 'b'] } } } },
      { channels: ['legacy'] },
    );

    await fireEvent.click(screen.getByRole('button', { name: 'a' }));
    await submit(container);

    // The schema rejects `legacy`, so nothing is submitted, and the chip toggle did not drop it.
    expect(submitted).toEqual([]);
    expect(screen.getByRole('button', { name: 'a' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('SchemaForm shapes: string arrays as tag inputs', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: { labels: { type: 'array', title: 'Labels', items: { type: 'string' } } },
  };

  test('renders a tag input holding the strings instead of raw JSON or row buttons', async () => {
    const { container } = await mount(schema, { labels: ['red', 'blue'] });

    expect(rawJsonTextareas(container)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Add Labels/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: /Labels/ })).toBeTruthy();
    expect(container.textContent).toContain('red');
    expect(container.textContent).toContain('blue');
  });

  test('commits typed tags and a pending draft on submit', async () => {
    const { container, submitted } = await mount(schema, { labels: ['red'] });
    const input = screen.getByRole('textbox', { name: /Labels/ });

    await fireEvent.input(input, { target: { value: 'green' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.input(input, { target: { value: 'pending' } });
    await submit(container);

    expect(submitted).toEqual([{ labels: ['red', 'green', 'pending'] }]);
  });

  test('shows an item-level validation error on the tag control and marks it invalid', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          labels: { type: 'array', title: 'Labels', items: { type: 'string', minLength: 3 } },
        },
      },
      { labels: [] },
    );
    const input = screen.getByRole('textbox', { name: /Labels/ });

    await fireEvent.input(input, { target: { value: 'a' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await submit(container);

    expect(submitted).toEqual([]);
    expect(container.querySelector('.cinder-form-field__error, [role="alert"]')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: /Labels/ }).getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  test('allows repeated tags only when the schema does not demand unique items', async () => {
    const { container, submitted } = await mount(schema, { labels: ['red'] });
    const input = screen.getByRole('textbox', { name: /Labels/ });

    await fireEvent.input(input, { target: { value: 'red' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await submit(container);

    expect(submitted).toEqual([{ labels: ['red', 'red'] }]);
  });
});

describe('SchemaForm shapes: records as row lists', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: {
      headers: {
        type: 'object',
        title: 'Headers',
        additionalProperties: { type: 'string' },
      },
    },
  };

  test('renders a key/value row per entry instead of raw JSON', async () => {
    const { container } = await mount(schema, { headers: { Accept: 'json', Host: 'example' } });

    expect(rawJsonTextareas(container)).toHaveLength(0);
    expect(screen.getAllByRole('textbox', { name: 'Key' })).toHaveLength(2);
    expect(screen.getByDisplayValue('Accept')).toBeTruthy();
    expect(screen.getByDisplayValue('example')).toBeTruthy();
  });

  test('adds, edits and removes rows and submits the resulting object', async () => {
    const { container, submitted } = await mount(schema, { headers: { Accept: 'json' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Add Headers entry' }));
    const keys = screen.getAllByRole('textbox', { name: 'Key' });
    const values = screen.getAllByRole('textbox', { name: 'Value' });
    await fireEvent.input(keys[1]!, { target: { value: 'X-Trace' } });
    await fireEvent.input(values[1]!, { target: { value: 'abc' } });
    await fireEvent.input(values[0]!, { target: { value: 'text' } });
    await submit(container);
    expect(submitted.at(-1)).toEqual({ headers: { Accept: 'text', 'X-Trace': 'abc' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Headers entry Accept' }));
    await submit(container);
    expect(submitted.at(-1)).toEqual({ headers: { 'X-Trace': 'abc' } });
  });

  test('refuses to submit duplicate or missing keys and says why', async () => {
    const { container, submitted } = await mount(schema, { headers: { Accept: 'json' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Add Headers entry' }));
    const keys = screen.getAllByRole('textbox', { name: 'Key' });
    const values = screen.getAllByRole('textbox', { name: 'Value' });
    await fireEvent.input(values[1]!, { target: { value: 'orphan' } });
    await submit(container);
    expect(submitted).toEqual([]);
    expect(screen.getByText('Every entry needs a key.')).toBeTruthy();

    await fireEvent.input(keys[1]!, { target: { value: 'Accept' } });
    await submit(container);
    expect(submitted).toEqual([]);
    expect(screen.getByText('Duplicate key "Accept".')).toBeTruthy();
  });

  test('shows an entry-level validation error on the record field', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          headers: {
            type: 'object',
            title: 'Headers',
            additionalProperties: { type: 'string', minLength: 3 },
          },
        },
      },
      { headers: { Accept: 'x' } },
    );

    await submit(container);

    expect(submitted).toEqual([]);
    expect(
      within(screen.getByRole('group', { name: 'Headers' })).getByText(/too short/),
    ).toBeTruthy();
  });

  test('disables the record rows while an asynchronous submit is pending', async () => {
    const finish = Promise.withResolvers<void>();
    const view = render(SchemaForm, {
      props: { schema, value: { headers: { Accept: 'json' } }, onSubmit: () => finish.promise },
    });
    await flush();

    const form = requiredInstance(view.container.querySelector('form'), HTMLFormElement);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const group = requiredInstance(
      screen.getByRole('group', { name: 'Headers' }),
      HTMLFieldSetElement,
    );
    expect(group.disabled).toBe(true);
    finish.resolve();
    await flush();
    expect(group.disabled).toBe(false);
  });

  test('does not treat objects with declared properties or wider values as records', () => {
    const withProperties = createSchemaFormModel({
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: { x: { type: 'string' } },
          additionalProperties: { type: 'string' },
        },
        b: { type: 'object', additionalProperties: { type: 'number' } },
      },
    });
    expect(withProperties.field.fields.map((field) => field.kind)).toEqual(['object', 'object']);
  });
});

describe('SchemaForm shapes: literal-or-object as a choice then fields', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: {
      refund: {
        title: 'Refund',
        oneOf: [
          { const: 'whole order', title: 'Whole order' },
          {
            type: 'object',
            title: 'Partial',
            properties: {
              amount: { type: 'integer', title: 'Amount' },
              reason: { type: 'string', title: 'Reason' },
            },
            required: ['amount'],
          },
        ],
      },
    },
    required: ['refund'],
  };

  test('shows a segmented choice and only the fields of the active branch', async () => {
    const { container } = await mount(schema, { refund: 'whole order' });

    expect(rawJsonTextareas(container)).toHaveLength(0);
    expect(screen.getByRole('radio', { name: 'Whole order' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.queryByRole('spinbutton', { name: /Amount/ })).toBeNull();

    await fireEvent.click(screen.getByRole('radio', { name: 'Partial' }));
    await flush();
    expect(screen.getByRole('spinbutton', { name: /Amount/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /Reason/ })).toBeTruthy();
  });

  test('derives the active branch from an object value and submits each branch', async () => {
    const { container, submitted } = await mount(schema, { refund: { amount: 5, reason: 'late' } });
    expect(screen.getByRole('radio', { name: 'Partial' }).getAttribute('aria-checked')).toBe(
      'true',
    );

    const amount = screen.getByRole('spinbutton', { name: /Amount/ });
    await fireEvent.input(amount, { target: { value: '9' } });
    await fireEvent.blur(amount);
    await submit(container);
    expect(submitted.at(-1)).toEqual({ refund: { amount: 9, reason: 'late' } });

    await fireEvent.click(screen.getByRole('radio', { name: 'Whole order' }));
    await flush();
    await submit(container);
    expect(submitted.at(-1)).toEqual({ refund: 'whole order' });
  });

  test('keeps a null literal branch null instead of an empty string', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          limit: {
            title: 'Limit',
            oneOf: [
              { const: null },
              { type: 'object', title: 'Range', properties: { min: { type: 'integer' } } },
            ],
          },
        },
      },
      {},
    );

    await submit(container);

    expect(submitted).toEqual([{ limit: null }]);
  });

  test('a free literal branch gets its own control', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          limit: {
            title: 'Limit',
            oneOf: [
              { type: 'string', title: 'Named' },
              { type: 'object', title: 'Range', properties: { min: { type: 'integer' } } },
            ],
          },
        },
      },
      { limit: 'low' },
    );

    const named = screen.getByRole('textbox', { name: /Named/ });
    await fireEvent.input(named, { target: { value: 'high' } });
    await submit(container);

    expect(submitted).toEqual([{ limit: 'high' }]);
  });

  test('keeps oneOf schemas without exactly one literal and one object branch as raw JSON', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        twoLiterals: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        bareObject: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        threeBranches: {
          oneOf: [
            { type: 'string' },
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'boolean' },
          ],
        },
      },
    });
    expect(model.field.fields.map((field) => field.kind)).toEqual(['json', 'json', 'json']);
  });
});

describe('SchemaForm shapes: milliseconds as a number plus unit', () => {
  afterEach(() => cleanup());

  test('detects durations by format or by name suffix, and nothing else', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        delay: { type: 'number', format: 'duration-ms' },
        timeoutMs: { type: 'integer' },
        retry_ms: { type: 'integer' },
        elapsedMilliseconds: { type: 'number' },
        items: { type: 'integer' },
        ms: { type: 'integer' },
        paramsMs: { type: 'string' },
      },
    });
    expect(model.field.fields.map((field) => [field.key, field.unit ?? null])).toEqual([
      ['delay', 'milliseconds'],
      ['timeoutMs', 'milliseconds'],
      ['retry_ms', 'milliseconds'],
      ['elapsedMilliseconds', 'milliseconds'],
      ['items', null],
      ['ms', null],
      ['paramsMs', null],
    ]);
  });

  test('shows the largest whole unit and a unit selector instead of a bare number', async () => {
    await mount(
      { type: 'object', properties: { timeoutMs: { type: 'integer', title: 'Timeout' } } },
      { timeoutMs: 90_000 },
    );

    expect(
      requiredInstance(screen.getByRole('spinbutton', { name: /Timeout/ }), HTMLInputElement).value,
    ).toBe('90');
    expect(
      requiredInstance(screen.getByRole('combobox', { name: 'Timeout unit' }), HTMLSelectElement)
        .value,
    ).toBe('s');
  });

  test('stores milliseconds whatever unit the number is typed in', async () => {
    const { container, submitted } = await mount(
      { type: 'object', properties: { timeoutMs: { type: 'integer', title: 'Timeout' } } },
      { timeoutMs: 90_000 },
    );

    await fireEvent.change(screen.getByRole('combobox', { name: 'Timeout unit' }), {
      target: { value: 'min' },
    });
    const number = screen.getByRole('spinbutton', { name: /Timeout/ });
    await fireEvent.input(number, { target: { value: '2' } });
    await fireEvent.blur(number);
    await submit(container);

    expect(submitted).toEqual([{ timeoutMs: 120_000 }]);
  });

  test('does not submit stale milliseconds while a number is typed but not yet committed', async () => {
    const { container, submitted } = await mount(
      { type: 'object', properties: { timeoutMs: { type: 'integer', title: 'Timeout' } } },
      { timeoutMs: 90_000 },
    );

    await fireEvent.input(screen.getByRole('spinbutton', { name: /Timeout/ }), {
      target: { value: '2' },
    });
    await submit(container);

    expect(submitted).toEqual([]);
    expect(screen.getByText('Timeout Ms must be integer.')).toBeTruthy();
  });

  test('does not submit a stale value when malformed duration text is committed on blur', async () => {
    const { container, submitted } = await mount(
      { type: 'object', properties: { timeoutMs: { type: 'integer', title: 'Timeout' } } },
      { timeoutMs: 90_000 },
    );

    const number = screen.getByRole('spinbutton', { name: /Timeout/ });
    await fireEvent.focus(number);
    await fireEvent.input(number, { target: { value: '2m' } });
    await fireEvent.blur(number);
    await submit(container);

    expect(submitted).toEqual([]);
    expect(number.getAttribute('aria-invalid')).toBe('true');
  });

  test('still clears an optional duration that is emptied on purpose', async () => {
    const { container, submitted } = await mount(
      { type: 'object', properties: { timeoutMs: { type: 'integer', title: 'Timeout' } } },
      { timeoutMs: 90_000 },
    );

    const number = screen.getByRole('spinbutton', { name: /Timeout/ });
    await fireEvent.focus(number);
    await fireEvent.input(number, { target: { value: '' } });
    await fireEvent.blur(number);
    await submit(container);

    expect(submitted).toEqual([{}]);
  });

  test('accepts a format-only duration schema without a schema error', async () => {
    const { container, submitted } = await mount(
      { type: 'object', properties: { delay: { type: 'number', format: 'duration-ms' } } },
      { delay: 250 },
    );

    await submit(container);

    expect(submitted).toEqual([{ delay: 250 }]);
  });

  test('converts between units without drifting', () => {
    expect(DURATION_UNITS.map((unit) => unit.value)).toEqual(['ms', 's', 'min', 'h']);
    expect(durationUnitFor(3_600_000)).toBe('h');
    expect(durationUnitFor(90_000)).toBe('s');
    expect(durationUnitFor(1500)).toBe('ms');
    expect(durationUnitFor(0)).toBe('ms');
    expect(durationUnitFor(undefined)).toBe('ms');
    expect(fromMilliseconds(1500, 's')).toBe(1.5);
    expect(toMilliseconds(0.1, 'min', true)).toBe(6000);
    expect(toMilliseconds(0.0015, 's', false)).toBe(1.5);
  });
});
