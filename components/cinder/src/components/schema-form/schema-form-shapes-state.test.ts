/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const {
  createSchemaFormModel,
  defaultValueForField,
  initialValueForField,
  recordEntryIssue,
  recordFromEntries,
} = await import('./schema-form-model.ts');

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

const shapesSchema = {
  type: 'object',
  properties: {
    channels: { type: 'array', items: { enum: ['email', 'sms'] } },
    labels: { type: 'array', items: { type: 'string' } },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    refund: {
      oneOf: [
        { const: 'whole' },
        { type: 'object', properties: { amount: { type: 'integer' }, note: { type: 'string' } } },
      ],
    },
    timeoutMs: { type: 'integer' },
    plain: { type: 'array', items: { type: 'integer' } },
  },
};

describe('SchemaForm shapes: model', () => {
  test('classifies each shape and keeps the plain array', () => {
    const model = createSchemaFormModel(shapesSchema);
    expect(model.field.fields.map((field) => [field.key, field.kind])).toEqual([
      ['channels', 'enumArray'],
      ['labels', 'tags'],
      ['headers', 'record'],
      ['refund', 'choice'],
      ['timeoutMs', 'integer'],
      ['plain', 'array'],
    ]);
    const [channels, , , refund] = model.field.fields;
    expect(channels?.options.map((option) => option.value)).toEqual(['email', 'sms']);
    expect(refund?.fields.map((branch) => branch.kind)).toEqual(['enum', 'object']);
    expect(refund?.fields.every((branch) => branch.path.join('/') === 'refund')).toBe(true);
  });

  test('seeds every shape with an empty value of its own type', () => {
    const model = createSchemaFormModel(shapesSchema);
    expect(defaultValueForField(model.field)).toEqual({
      channels: [],
      labels: [],
      headers: {},
      refund: 'whole',
      timeoutMs: undefined,
      plain: [],
    });
  });

  test('fills the object branch of a seeded choice with its own defaults', () => {
    const model = createSchemaFormModel(shapesSchema);
    expect(initialValueForField(model.field, { refund: { amount: 4 } })).toMatchObject({
      refund: { amount: 4, note: '' },
    });
  });

  test('projects rows into an object and names what blocks it', () => {
    expect(
      recordFromEntries([
        { key: 'a', value: '1' },
        { key: '', value: '' },
        { key: 'a', value: '2' },
        { key: '__proto__', value: 'x' },
      ]),
    ).toEqual(JSON.parse('{"a":"1","__proto__":"x"}'));
    expect(
      recordEntryIssue([
        { key: 'a', value: '1' },
        { key: '', value: '' },
      ]),
    ).toBeUndefined();
    expect(recordEntryIssue([{ key: ' ', value: 'v' }])).toBe('Every entry needs a key.');
    expect(
      recordEntryIssue([
        { key: 'a', value: '1' },
        { key: 'a', value: '2' },
      ]),
    ).toBe('Duplicate key "a".');
  });
});

describe('SchemaForm shapes: editing state', () => {
  afterEach(() => cleanup());

  test('a number typed but not yet committed inside the active choice branch reaches the draft', async () => {
    const drafts: unknown[] = [];
    render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: {
            refund: {
              oneOf: [
                { const: 'whole' },
                { type: 'object', properties: { amount: { type: 'integer', title: 'Amount' } } },
              ],
            },
          },
        },
        value: { refund: { amount: 1 } },
        onDraftChange: (next: unknown) => void drafts.push(next),
      },
    });
    await flush();

    await fireEvent.input(screen.getByRole('spinbutton', { name: /Amount/ }), {
      target: { value: '9' },
    });

    // Like every numeric editor, the text in progress is reported as typed until it commits.
    expect(drafts.at(-1)).toEqual({ refund: { amount: '9' } });
  });

  test('switching a choice branch drops the edits and errors of the branch it leaves', async () => {
    const submitted: unknown[] = [];
    const { container } = render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: {
            refund: {
              oneOf: [
                { const: 'whole', title: 'Whole' },
                {
                  type: 'object',
                  title: 'Partial',
                  properties: { amount: { type: 'integer', title: 'Amount' } },
                  required: ['amount'],
                },
              ],
            },
          },
        },
        value: { refund: { amount: 3 } },
        onSubmit: (next: unknown) => void submitted.push(next),
      },
    });
    await flush();

    await fireEvent.input(screen.getByRole('spinbutton', { name: /Amount/ }), {
      target: { value: '8' },
    });
    await fireEvent.click(screen.getByRole('radio', { name: 'Whole' }));
    await flush();
    await fireEvent.click(screen.getByRole('radio', { name: 'Partial' }));
    await flush();

    expect(
      requiredInstance(screen.getByRole('spinbutton', { name: /Amount/ }), HTMLInputElement).value,
    ).toBe('');
    await submit(container);
    expect(submitted).toEqual([]);
  });

  test('removing an array row moves the record rows of the rows after it', async () => {
    const submitted: unknown[] = [];
    const { container } = render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: {
            targets: {
              type: 'array',
              title: 'Targets',
              items: {
                type: 'object',
                properties: {
                  env: { type: 'object', title: 'Env', additionalProperties: { type: 'string' } },
                },
              },
            },
          },
        },
        value: { targets: [{ env: { FIRST: '1' } }, { env: { SECOND: '2' } }] },
        onSubmit: (next: unknown) => void submitted.push(next),
      },
    });
    await flush();

    const secondValue = screen.getByDisplayValue('2');
    await fireEvent.input(secondValue, { target: { value: '22' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Targets item 1' }));
    await flush();
    await submit(container);

    expect(screen.queryByDisplayValue('FIRST')).toBeNull();
    expect(submitted).toEqual([{ targets: [{ env: { SECOND: '22' } }] }]);
  });

  test('reports every shape through onDraftChange', async () => {
    const drafts: unknown[] = [];
    render(SchemaForm, {
      props: {
        schema: shapesSchema,
        value: {},
        onDraftChange: (draft: unknown) => void drafts.push(draft),
      },
    });
    await flush();

    await fireEvent.click(screen.getByRole('button', { name: 'sms' }));
    expect(drafts.at(-1)).toMatchObject({ channels: ['sms'] });

    const tagInput = screen.getByRole('textbox', { name: /Labels/ });
    await fireEvent.input(tagInput, { target: { value: 'x' } });
    await fireEvent.keyDown(tagInput, { key: 'Enter' });
    expect(drafts.at(-1)).toMatchObject({ labels: ['x'] });

    await fireEvent.click(screen.getByRole('button', { name: /Add .* entry/ }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Key' }), {
      target: { value: 'K' },
    });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Value' }), {
      target: { value: 'V' },
    });
    expect(drafts.at(-1)).toMatchObject({ headers: { K: 'V' } });
  });
});
