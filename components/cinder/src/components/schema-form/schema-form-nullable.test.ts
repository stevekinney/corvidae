/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const { schemaFormInitialDraft, validateSchemaFormValue } = await import('./index.ts');

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

type Kind = {
  readonly name: string;
  /** The field, which holds nothing the form could start from but `null`. */
  readonly field: Record<string, unknown>;
  /** A default and a held value the field accepts. */
  readonly value: unknown;
  /** How a person sets the field back to `null`. */
  readonly clear: () => Promise<void>;
};

async function clearText(): Promise<void> {
  const text = screen.getByRole('textbox');
  await fireEvent.input(text, { target: { value: '' } });
  await fireEvent.blur(text);
}

async function clearNumber(): Promise<void> {
  const number = screen.getByRole('spinbutton');
  await fireEvent.focus(number);
  await fireEvent.input(number, { target: { value: '' } });
  await fireEvent.blur(number);
}

async function clearOption(): Promise<void> {
  await fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
}

/** A yes or no, or a group, that may be `null` has a "Not set" segment, which is the `null`. */
async function chooseNotSet(): Promise<void> {
  await fireEvent.click(screen.getByRole('radio', { name: 'Not set' }));
}

/** A list that may be `null` has one action that returns it to "Not set". */
async function clearList(): Promise<void> {
  await fireEvent.click(screen.getByRole('button', { name: /^Clear / }));
}

/** A shape no control can edit honestly is raw JSON, where `null` is typed. */
async function typeNull(): Promise<void> {
  const editor = requiredInstance(document.querySelector('textarea'), HTMLTextAreaElement);
  await fireEvent.input(editor, { target: { value: 'null' } });
  await fireEvent.blur(editor);
}

const KINDS: readonly Kind[] = [
  {
    name: 'string',
    field: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    value: 'x',
    clear: clearText,
  },
  {
    name: 'number',
    field: { anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }] },
    value: 2,
    clear: clearNumber,
  },
  {
    name: 'integer',
    field: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    value: 3,
    clear: clearNumber,
  },
  {
    name: 'enum',
    field: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] },
    value: 'b',
    clear: clearOption,
  },
  {
    name: 'boolean',
    field: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    value: true,
    clear: chooseNotSet,
  },
  {
    name: 'object',
    field: {
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: 'string', minLength: 1 } },
          required: ['a'],
        },
        { type: 'null' },
      ],
    },
    value: { a: 'y' },
    clear: chooseNotSet,
  },
  {
    name: 'array',
    field: { anyOf: [{ type: 'array', items: { type: 'string' }, minItems: 1 }, { type: 'null' }] },
    value: ['z'],
    clear: clearList,
  },
  {
    name: 'array of objects',
    field: {
      anyOf: [
        {
          type: 'array',
          items: { type: 'object', properties: { a: { type: 'string' } } },
          minItems: 1,
        },
        { type: 'null' },
      ],
    },
    value: [{ a: 'q' }],
    clear: typeNull,
  },
];

function rootOf(kind: Kind, hasDefault: boolean, required: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: { field: hasDefault ? { ...kind.field, default: kind.value } : kind.field },
    ...(required ? { required: ['field'] } : {}),
  };
}

describe('a field that is also null, by kind, default and requirement', () => {
  afterEach(() => cleanup());

  for (const kind of KINDS) {
    for (const hasDefault of [false, true]) {
      for (const required of [true, false]) {
        const label = `${kind.name}, ${hasDefault ? 'with a default' : 'with no default'}, ${required ? 'required' : 'optional'}`;
        const expected = { field: hasDefault ? kind.value : null };

        describe(label, () => {
          test('starts as its default, else null, and that draft is valid', async () => {
            const schema = rootOf(kind, hasDefault, required);
            const draft = schemaFormInitialDraft(schema, undefined);
            expect(draft).toEqual(expected);
            const result = await validateSchemaFormValue(schema, draft);
            expect(result.valid).toBe(true);
          });

          test('submits what it starts as, untouched', async () => {
            const submitted: unknown[] = [];
            const { container } = render(SchemaForm, {
              props: {
                schema: rootOf(kind, hasDefault, required),
                onSubmit: (next: unknown) => void submitted.push(next),
              },
            });
            await flush();
            await submit(container);
            expect(submitted).toEqual([expected]);
          });

          test('is set back to null through its own control, and submits null', async () => {
            const submitted: unknown[] = [];
            const { container } = render(SchemaForm, {
              props: {
                schema: rootOf(kind, hasDefault, required),
                value: { field: kind.value },
                onSubmit: (next: unknown) => void submitted.push(next),
              },
            });
            await flush();
            await kind.clear();
            await submit(container);
            expect(submitted).toEqual([{ field: null }]);
          });
        });
      }
    }
  }

  test('every nullable kind has a control, and only a shape no control can edit is raw JSON', () => {
    for (const kind of KINDS) {
      const { container } = render(SchemaForm, { props: { schema: rootOf(kind, false, false) } });
      const raw = container.querySelector('textarea') !== null;
      expect(raw, kind.name).toBe(kind.name === 'array of objects');
      cleanup();
    }
  });

  test('a type list with null is drawn as the union is, and starts as null', () => {
    const schema = {
      type: 'object',
      properties: {
        on: { type: ['boolean', 'null'] },
        group: { type: ['object', 'null'], properties: { a: { type: 'string', minLength: 1 } } },
        list: { type: ['array', 'null'], items: { type: 'string' } },
      },
    };
    expect(schemaFormInitialDraft(schema, undefined)).toEqual({
      on: null,
      group: null,
      list: null,
    });
    const { container } = render(SchemaForm, { props: { schema } });
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(screen.getAllByRole('radio', { name: 'Not set' })).toHaveLength(2);
    expect(container.textContent).toContain('Not set');
  });

  test('a type list with null starts as null and clears to null, as the union does', async () => {
    const submitted: unknown[] = [];
    const schema = {
      type: 'object',
      properties: { label: { type: ['string', 'null'], minLength: 1 } },
      required: ['label'],
    };
    expect(schemaFormInitialDraft(schema, undefined)).toEqual({ label: null });
    const { container } = render(SchemaForm, {
      props: {
        schema,
        value: { label: 'x' },
        onSubmit: (next: unknown) => void submitted.push(next),
      },
    });
    await flush();
    await clearText();
    await submit(container);
    expect(submitted).toEqual([{ label: null }]);
  });
});
