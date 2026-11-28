/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const { createSchemaFormModel } = await import('./schema-form-model.ts');

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
  const view = render(SchemaForm, {
    props: { schema, value, onSubmit: (next: unknown) => void submitted.push(next), ...props },
  });
  await flush();
  return { ...view, submitted };
}

/** The segments of the first choice in `schema`, as the words a person reads. */
function segmentsOf(property: Record<string, unknown>): string[] {
  const model = createSchemaFormModel({ type: 'object', properties: { field: property } });
  const choice = model.field.fields[0];
  return choice?.fields.map((branch) => branch.label) ?? [];
}

const OBJECT = { type: 'object', properties: { count: { type: 'integer' } } };

describe('the words of a choice between alternatives', () => {
  test('are the alternative’s title, and a literal in words, never a JSON type', () => {
    expect(
      segmentsOf({
        anyOf: [
          { type: 'string', const: 'keep-all' },
          { ...OBJECT, title: 'Keep the last few' },
        ],
      }),
    ).toEqual(['Keep all', 'Keep the last few']);
    expect(segmentsOf({ anyOf: [{ type: 'string', const: 'forever' }, OBJECT] })).toEqual([
      'Forever',
      'Field',
    ]);
  });

  test('read false beside an object as Off, and true as On', () => {
    expect(segmentsOf({ anyOf: [{ const: false }, OBJECT] })).toEqual(['Off', 'Field']);
    expect(segmentsOf({ anyOf: [{ const: true }, OBJECT] })).toEqual(['On', 'Field']);
  });

  test('use a short description, then plain words for what a free alternative holds', () => {
    expect(
      segmentsOf({
        anyOf: [
          { type: 'string', description: 'Any text' },
          { ...OBJECT, description: 'Counted' },
        ],
      }),
    ).toEqual(['Any text', 'Counted']);
    expect(segmentsOf({ anyOf: [{ type: 'string' }, OBJECT] })).toEqual(['Text', 'Field']);
    expect(segmentsOf({ anyOf: [{ type: 'number' }, OBJECT] })).toEqual(['Number', 'Field']);
    expect(segmentsOf({ anyOf: [{ type: 'integer' }, OBJECT] })).toEqual(['Number', 'Field']);
    expect(segmentsOf({ anyOf: [{ type: 'boolean' }, OBJECT] })).toEqual(['Yes or no', 'Field']);
  });

  test('name an untitled object as the field itself when it has a title, else "Custom" at the root', () => {
    expect(segmentsOf({ title: 'Checkpoints', anyOf: [{ const: 'keep-all' }, OBJECT] })).toEqual([
      'Keep all',
      'Checkpoints',
    ]);
    const root = createSchemaFormModel({ anyOf: [{ const: 'keep-all' }, OBJECT] });
    expect(root.field.fields.map((branch) => branch.label)).toEqual(['Keep all', 'Custom']);
  });
});

describe('a choice drawn flat, with its control at the inline end', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: {
      checkpoints: {
        title: 'Checkpoints',
        anyOf: [
          { type: 'string', const: 'keep-all' },
          { ...OBJECT, title: 'A number' },
        ],
      },
    },
  };

  test('puts the field’s title and its control on one line, and no box around either', async () => {
    const { container } = await mount(schema, { checkpoints: 'keep-all' });
    const header = container.querySelector('.cinder-schema-form__choice-header');
    expect(header?.textContent).toContain('Checkpoints');
    expect(header?.querySelector('[role="radiogroup"], [role="radio"]')).not.toBeNull();
    expect(container.querySelector('fieldset')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Keep all' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  test('in a settings row sits in the row’s own control column, under the row’s title', async () => {
    const { container } = await mount(
      schema,
      { checkpoints: { count: 2 } },
      {
        variant: 'setting-rows',
      },
    );
    const row = requiredInstance(
      container.querySelector('[data-cinder-field="checkpoints"]'),
      HTMLElement,
    );
    expect(row.querySelector('.cinder-setting-row__field [role="radio"]')).not.toBeNull();
    expect(row.querySelector('fieldset')).toBeNull();
    // The row titles it once: the choice draws no title of its own.
    expect(
      row.querySelector('.cinder-schema-form__choice-header .cinder-schema-form__legend'),
    ).toBeNull();
    expect(screen.getByRole('spinbutton')).toBeTruthy();
  });
});

describe('every choice control sits where its form puts controls', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: {
      flag: { title: 'Flag', anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      options: {
        title: 'Options',
        anyOf: [
          { type: 'object', properties: { a: { type: 'string', title: 'A' } } },
          { type: 'null' },
        ],
      },
      checkpoints: {
        title: 'Checkpoints',
        anyOf: [{ const: 'keep-all' }, OBJECT],
      },
    },
  };

  test('under its label, at the leading edge, in a plain form', async () => {
    const { container } = await mount(schema, undefined);
    const groups = [...container.querySelectorAll('[role="radiogroup"]')];
    expect(groups).toHaveLength(3);
    // The title comes first and the control follows it, in one column of the header.
    for (const header of container.querySelectorAll('.cinder-schema-form__choice-header')) {
      expect(header.firstElementChild?.classList.contains('cinder-schema-form__legend')).toBe(true);
      expect(header.querySelector('[role="radiogroup"]')).not.toBeNull();
    }
    const css = readFileSync(new URL('./schema-form.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-schema-form__choice-header\s*\{[^}]*justify-items:\s*start/);
    expect(css).not.toMatch(/__choice-control\s*\{[^}]*margin-inline-start:\s*auto/);
    // The title starts where its siblings' labels do: a plain line, with no legend's padding.
    expect(css).toMatch(
      /__choice-header\s+\.cinder-schema-form__legend\s*\{[^}]*padding-inline:\s*0/,
    );
  });

  test('in the control column, on the label line, in a settings row', async () => {
    const { container } = await mount(schema, undefined, { variant: 'setting-rows' });
    for (const key of ['flag', 'options', 'checkpoints']) {
      const row = requiredInstance(
        container.querySelector(`[data-cinder-field="${key}"]`),
        HTMLElement,
      );
      expect(
        row.querySelector('.cinder-setting-row__field [role="radiogroup"]'),
        key,
      ).not.toBeNull();
      expect(row.querySelector('.cinder-schema-form__choice-header'), key).toBeNull();
    }
  });
});

describe('the space a choice and a group end with', () => {
  afterEach(() => cleanup());

  test('is on the body of the choice, so a choice that adds nothing adds no space', async () => {
    const schema = {
      type: 'object',
      properties: {
        options: {
          title: 'Options',
          anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }],
        },
      },
    };
    const unset = await mount(schema, undefined);
    expect(unset.container.querySelector('.cinder-schema-form__choice-body')).toBeNull();
    cleanup();
    const set = await mount(schema, { options: { a: 'x' } });
    expect(set.container.querySelector('.cinder-schema-form__choice-body')).not.toBeNull();
  });

  test('is the same for a group in a row or a hosted form, and for a choice', () => {
    const css = readFileSync(new URL('./schema-form.css', import.meta.url), 'utf8');
    expect(css).toMatch(/__choice-body\s*\{[^}]*padding-block-end:\s*var\(--cinder-space-3\)/);
    expect(css).not.toMatch(/\.cinder-schema-form__choice\s*\{[^}]*padding-block-end/);
    for (const scope of ["\\[data-cinder-variant='setting-rows'\\]", '\\[data-cinder-hosted\\]']) {
      expect(css).toMatch(
        new RegExp(
          `${scope}\\s+\\.cinder-schema-form__fieldset\\s*\\{[^}]*padding-block-end:\\s*var\\(--cinder-space-3\\)`,
        ),
      );
    }
  });
});

describe('a duration is labelled by what it measures', () => {
  afterEach(() => cleanup());

  test('without the unit its name ends in, because the control says it', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        timeoutMilliseconds: { type: 'number' },
        retryMs: { type: 'integer', title: 'Retry after' },
        retry_ms: { type: 'integer' },
      },
    });
    expect(model.field.fields.map((field) => field.label)).toEqual([
      'Timeout',
      'Retry after',
      'Retry',
    ]);
  });
});

describe('a yes or no that may be unset', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: { flag: { title: 'Flag', anyOf: [{ type: 'boolean' }, { type: 'null' }] } },
  };

  test('is three segments, Not set first, and starts on it', async () => {
    const { container, submitted } = await mount(schema, undefined);
    expect(container.querySelector('textarea')).toBeNull();
    expect(screen.getAllByRole('radio').map((segment) => segment.textContent?.trim())).toEqual([
      'Not set',
      'Yes',
      'No',
    ]);
    expect(screen.getByRole('radio', { name: 'Not set' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await submit(container);
    expect(submitted).toEqual([{ flag: null }]);
  });

  test('sets true and false, and null again', async () => {
    const { container, submitted } = await mount(schema, undefined);
    await fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    await submit(container);
    await fireEvent.click(screen.getByRole('radio', { name: 'No' }));
    await submit(container);
    await fireEvent.click(screen.getByRole('radio', { name: 'Not set' }));
    await submit(container);
    expect(submitted).toEqual([{ flag: true }, { flag: false }, { flag: null }]);
  });
});

describe('an object that may be unset', () => {
  afterEach(() => cleanup());

  const schema = {
    type: 'object',
    properties: {
      options: {
        title: 'Options',
        anyOf: [
          {
            type: 'object',
            properties: { name: { type: 'string', title: 'Name', minLength: 1 } },
            required: ['name'],
          },
          { type: 'null' },
        ],
      },
    },
  };

  test('shows no fields until it is set, and sets back to null', async () => {
    const { container, submitted } = await mount(schema, undefined);
    expect(screen.queryByRole('textbox', { name: /Name/ })).toBeNull();
    await submit(container);
    await fireEvent.click(screen.getByRole('radio', { name: 'Set' }));
    await flush();
    await fireEvent.input(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'Ada' },
    });
    await submit(container);
    await fireEvent.click(screen.getByRole('radio', { name: 'Not set' }));
    await flush();
    expect(screen.queryByRole('textbox', { name: /Name/ })).toBeNull();
    await submit(container);
    expect(submitted).toEqual([{ options: null }, { options: { name: 'Ada' } }, { options: null }]);
  });
});

describe('an object that may be unset, left unset, with a field that is raw JSON', () => {
  afterEach(() => cleanup());

  test('submits null, and no draft of a field it does not draw', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          options: {
            title: 'Options',
            anyOf: [
              {
                type: 'object',
                properties: { extra: { title: 'Extra' }, size: { type: 'integer' } },
              },
              { type: 'null' },
            ],
          },
        },
      },
      undefined,
    );
    await submit(container);
    expect(submitted).toEqual([{ options: null }]);
  });
});

describe('a list of numbers that may be unset', () => {
  afterEach(() => cleanup());

  test('is the list control, starts as null, and is cleared back to it', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          sizes: {
            title: 'Sizes',
            anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }],
          },
        },
      },
      { sizes: [1, 2] },
    );
    expect(container.querySelector('textarea')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear Sizes' }));
    await flush();
    await submit(container);
    expect(submitted).toEqual([{ sizes: null }]);
    expect(container.textContent).toContain('Not set');
  });
});

describe('a list that may be unset', () => {
  afterEach(() => cleanup());

  test('says Not set in its empty input while it is null, as an empty number does, and offers one Clear once it holds a list', async () => {
    const { container, submitted } = await mount(
      {
        type: 'object',
        properties: {
          tags: {
            title: 'Tags',
            anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
          },
        },
      },
      { tags: ['a'] },
    );
    expect(screen.getByRole('button', { name: 'Clear Tags' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear Tags' }));
    await flush();
    expect(screen.queryByRole('button', { name: 'Clear Tags' })).toBeNull();
    // The words are the empty input's placeholder, the same treatment as an empty number, and no
    // separate line of muted text.
    expect(
      requiredInstance(container.querySelector('input[placeholder]'), HTMLInputElement).placeholder,
    ).toBe('Not set');
    expect(container.querySelector('.cinder-schema-form__unset')).toBeNull();
    await submit(container);
    expect(submitted).toEqual([{ tags: null }]);
  });
});

describe('an empty number that may be null', () => {
  afterEach(() => cleanup());

  test('always says Not set, never the field’s description, so a cleared field reads as one', async () => {
    const { container } = await mount(
      {
        type: 'object',
        properties: {
          size: { type: ['integer', 'null'], title: 'Size' },
          limit: {
            type: ['integer', 'null'],
            title: 'Limit',
            description: 'Empty for no limit',
          },
          waitMs: { type: ['integer', 'null'], title: 'Wait' },
        },
      },
      undefined,
    );
    const inputs = [
      ...container.querySelectorAll('input[inputmode="decimal"]'),
    ] as HTMLInputElement[];
    expect(inputs.map((input) => input.placeholder)).toEqual(['Not set', 'Not set', 'Not set']);
  });

  test('has no placeholder of its own when the number cannot be null', async () => {
    const { container } = await mount(
      { type: 'object', properties: { size: { type: 'integer', title: 'Size' } } },
      { size: 3 },
    );
    const input = requiredInstance(
      container.querySelector('input[inputmode="decimal"]'),
      HTMLInputElement,
    );
    expect(input.placeholder).toBe('');
  });
});

describe('raw JSON is one editor everywhere', () => {
  afterEach(() => cleanup());

  test('the same JSON editor in every variant', async () => {
    const schema = {
      type: 'object',
      properties: {
        raw: {
          title: 'Raw',
          anyOf: [
            { type: 'array', items: { type: 'object', properties: { a: {} } } },
            { type: 'null' },
          ],
        },
      },
    };
    for (const variant of ['default', 'input', 'setting-rows'] as const) {
      const { container } = await mount(schema, undefined, { variant });
      expect(container.querySelector('.cinder-json-editor'), variant).not.toBeNull();
      cleanup();
    }
  });
});
