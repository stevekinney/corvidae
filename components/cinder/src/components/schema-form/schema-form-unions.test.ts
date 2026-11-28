/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const { createSchemaFormModel } = await import('./schema-form-model.ts');
const { schemaFormInitialDraft } = await import('./index.ts');

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

async function mount(
  schema: Record<string, unknown>,
  value: unknown,
  props: Record<string, unknown> = {},
) {
  const submitted: unknown[] = [];
  const drafts: unknown[] = [];
  const view = render(SchemaForm, {
    props: {
      schema,
      value,
      onSubmit: (next: unknown) => void submitted.push(next),
      onDraftChange: (next: unknown) => void drafts.push(next),
      ...props,
    },
  });
  await flush();
  return { ...view, submitted, drafts };
}

function rawJsonTextareas(container: HTMLElement): HTMLTextAreaElement[] {
  return Array.from(container.querySelectorAll('textarea'));
}

/** The shape Bureau publishes for `retention.audit`: Zod writes a union as an `anyOf`. */
const retention = {
  title: 'Audit',
  anyOf: [
    { type: 'string', const: 'forever' },
    {
      type: 'object',
      properties: { olderThan: { type: 'number', minimum: 0, unit: 'milliseconds' } },
      required: ['olderThan'],
      additionalProperties: false,
    },
  ],
};

describe('SchemaForm reads an anyOf as it reads a oneOf', () => {
  afterEach(() => cleanup());

  const schema = { type: 'object', properties: { audit: retention }, required: ['audit'] };

  test('draws a literal or an object as a segmented choice, not as raw JSON', async () => {
    const { container, submitted } = await mount(schema, { audit: 'forever' });

    expect(rawJsonTextareas(container)).toHaveLength(0);
    expect(screen.getByRole('radio', { name: 'Forever' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await fireEvent.click(screen.getByRole('radio', { name: 'Audit' }));
    await flush();
    // The duration unit sits on the field's own schema, whatever the field is called.
    expect(screen.getByRole('combobox', { name: /unit/i })).toBeTruthy();
    const number = screen.getByRole('spinbutton');
    await fireEvent.input(number, { target: { value: '90000' } });
    await fireEvent.blur(number);
    await submit(container);

    expect(submitted.at(-1)).toEqual({ audit: { olderThan: 90_000 } });
  });

  test('starts a choice on its literal, as the oneOf form does', () => {
    expect(schemaFormInitialDraft(schema, undefined)).toEqual({ audit: 'forever' });
  });

  test('keeps a union that holds both keywords, or has no object alternative, as raw JSON', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        both: { anyOf: [{ type: 'string' }, { type: 'object', properties: { a: {} } }], oneOf: [] },
        twoLiterals: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    });
    expect(model.field.fields.map((field) => field.kind)).toEqual(['json', 'json']);
  });

  test('draws a field that is also null as the field, with the control its kind has', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        on: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        group: {
          anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }],
        },
        labels: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        size: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        mode: { anyOf: [{ enum: ['a', 'b'] }, { type: 'null' }] },
      },
    });
    expect(model.field.fields.map((field) => [field.kind, field.nullable ?? false])).toEqual([
      ['string', true],
      ['boolean', true],
      ['object', true],
      ['tags', true],
      ['integer', true],
      ['enum', true],
    ]);
  });
});

describe('SchemaForm validates the union it is given, not a copy', () => {
  afterEach(() => cleanup());

  function bothBranches(keyword: 'anyOf' | 'oneOf') {
    return {
      type: 'object',
      properties: { size: { [keyword]: [{ type: 'number' }, { type: 'integer' }] } },
    };
  }

  test('submits a value that matches both anyOf alternatives', async () => {
    const { container, submitted } = await mount(bothBranches('anyOf'), { size: 2 });
    await submit(container);
    expect(submitted).toEqual([{ size: 2 }]);
  });

  test('refuses the same value under a oneOf', async () => {
    const { container, submitted } = await mount(bothBranches('oneOf'), { size: 2 });
    await submit(container);
    expect(submitted).toEqual([]);
  });
});

describe('SchemaForm draws false or an object', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: {
      options: {
        title: 'Options',
        anyOf: [
          { type: 'boolean', const: false },
          { type: 'object', properties: { count: { type: 'integer', title: 'Count' } } },
        ],
      },
    },
  };

  test('as a choice between the two, and submits false as false', async () => {
    const { container, submitted } = await mount(schema, { options: { count: 3 } });
    expect(screen.getByRole('spinbutton', { name: /Count/ })).toBeTruthy();

    // The alternatives read as a person says them: `false` beside an object is "Off", and the
    // object, with no title, is the field's own.
    expect(screen.getByRole('radio', { name: 'Options' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await flush();
    await submit(container);

    expect(submitted.at(-1)).toEqual({ options: false });
  });

  test('without its own choice when the host draws the switch', async () => {
    const { container } = await mount(
      schema.properties.options,
      { count: 3 },
      { rootChoiceVisible: false, hosted: true },
    );

    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('spinbutton', { name: /Count/ })).toBeTruthy();
    // No title of its own for a root choice, and no box: the page or the row names it.
    expect(screen.getByRole('group', { name: 'Options' })).toBeTruthy();
    expect(container.querySelector('fieldset')).toBeNull();
    // Nothing to put in a header, so there is none to take the choice's gap above the fields, and
    // the root choice's body ends the form with no padding of its own.
    expect(container.querySelectorAll('.cinder-schema-form__choice-header')).toHaveLength(0);
    expect(
      container.querySelectorAll(
        '.cinder-schema-form__choice[data-cinder-root-choice] > .cinder-schema-form__choice-body',
      ),
    ).toHaveLength(1);
  });

  test('a root choice that is drawn has its header, and a nested one is not the root', async () => {
    const { container } = await mount(schema.properties.options, { count: 3 }, { hosted: true });

    expect(screen.getByRole('radio', { name: 'Off' })).toBeTruthy();
    expect(container.querySelectorAll('.cinder-schema-form__choice-header')).toHaveLength(1);

    cleanup();
    const nested = await mount(schema, { options: { count: 3 } }, { rootChoiceVisible: false });
    expect(
      nested.container.querySelectorAll('.cinder-schema-form__choice[data-cinder-root-choice]'),
    ).toHaveLength(0);
  });

  test('and keeps the choice of a union nested in a field when the root choice is hidden', async () => {
    const { container } = await mount(
      schema,
      { options: { count: 3 } },
      { rootChoiceVisible: false },
    );
    expect(screen.getByRole('radio', { name: 'Off' })).toBeTruthy();
    // Flat: the field's title and its choice on one line, and no fieldset around them.
    expect(container.querySelector('.cinder-schema-form__choice-header')).not.toBeNull();
    expect(container.querySelector('fieldset')).toBeNull();
  });
});

describe('SchemaForm clears a field that allows null to null', () => {
  afterEach(() => cleanup());

  const nullableInteger = {
    anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
    title: 'Largest',
  };

  test('reads an integer or null as a number field, not as raw JSON', async () => {
    const { container } = await mount(
      { type: 'object', properties: { maxBytes: nullableInteger } },
      { maxBytes: 4096 },
    );
    expect(rawJsonTextareas(container)).toHaveLength(0);
    expect(requiredInstance(screen.getByRole('spinbutton'), HTMLInputElement).value).toBe('4,096');
  });

  for (const [name, property] of [
    ['an anyOf with null', nullableInteger],
    ['a oneOf with null', { oneOf: nullableInteger.anyOf, title: 'Largest' }],
    ['a type array', { type: ['integer', 'null'], minimum: 0, title: 'Largest' }],
  ] as const) {
    test(`submits null when ${name} is cleared, a value of its own`, async () => {
      const { container, submitted, drafts } = await mount(
        { type: 'object', properties: { maxBytes: property } },
        { maxBytes: 4096 },
      );

      const number = screen.getByRole('spinbutton');
      await fireEvent.focus(number);
      await fireEvent.input(number, { target: { value: '' } });
      await fireEvent.blur(number);
      await submit(container);

      expect(drafts.at(-1)).toEqual({ maxBytes: null });
      expect(submitted).toEqual([{ maxBytes: null }]);
    });
  }

  test('holds a number typed but not committed as its text, and submits it once it is a number', async () => {
    const { container, submitted, drafts } = await mount(
      { type: 'object', properties: { maxBytes: nullableInteger } },
      { maxBytes: null },
    );

    const number = screen.getByRole('spinbutton');
    await fireEvent.focus(number);
    await fireEvent.input(number, { target: { value: '12' } });
    expect(drafts.at(-1)).toEqual({ maxBytes: '12' });
    await fireEvent.blur(number);
    await submit(container);

    expect(submitted).toEqual([{ maxBytes: 12 }]);
  });

  test('starts a property nobody set as null, and keeps an untouched null as it is', async () => {
    const schema = { type: 'object', properties: { maxBytes: nullableInteger } };
    const explicit = await mount(schema, { maxBytes: null });
    await submit(explicit.container);
    expect(explicit.submitted).toEqual([{ maxBytes: null }]);
    cleanup();

    const missing = await mount(schema, {});
    await submit(missing.container);
    expect(missing.submitted).toEqual([{ maxBytes: null }]);
  });

  test('leaves a field that is null as null when it is focused and left empty', async () => {
    const { container, submitted, drafts } = await mount(
      { type: 'object', properties: { maxBytes: nullableInteger } },
      {},
    );

    const number = screen.getByRole('spinbutton');
    await fireEvent.focus(number);
    await fireEvent.blur(number);
    await submit(container);

    expect(drafts.every((draft) => (draft as { maxBytes: unknown }).maxBytes === null)).toBe(true);
    expect(submitted).toEqual([{ maxBytes: null }]);
  });

  test('clears a nullable duration, in milliseconds, to null', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          timeoutMs: { anyOf: [{ type: 'integer' }, { type: 'null' }], title: 'Wait' },
        },
      },
      { timeoutMs: 90_000 },
    );

    const number = screen.getByRole('spinbutton', { name: /Wait/ });
    await fireEvent.focus(number);
    await fireEvent.input(number, { target: { value: '' } });
    await fireEvent.blur(number);
    await submit(container);

    expect(submitted).toEqual([{ timeoutMs: null }]);
  });

  test('offers a nullable option list an empty choice that is null', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          mode: { anyOf: [{ type: 'string', enum: ['fast', 'safe'] }, { type: 'null' }] },
        },
      },
      { mode: 'fast' },
    );

    await fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await submit(container);

    expect(submitted).toEqual([{ mode: null }]);
  });
});
