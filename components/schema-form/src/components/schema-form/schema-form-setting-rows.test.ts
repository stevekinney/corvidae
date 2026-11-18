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

/** One property of each control a row carries at its inline end, and the ones it draws under the row. */
const plugin = {
  type: 'object',
  properties: {
    searchAddress: {
      type: 'string',
      title: 'Search address',
      description: 'The service the search goes to.',
    },
    region: { type: 'string', enum: ['us', 'eu'], description: 'Where the work runs.' },
    includeSnippets: { type: 'boolean', description: 'Show an excerpt.' },
    limit: { type: 'number', description: 'How many results.' },
    blockedSites: { type: 'array', items: { type: 'string' }, description: 'Never searched.' },
    cacheMs: { type: 'number', description: 'How long a result is kept.' },
  },
  required: ['searchAddress'],
};

const nested = {
  type: 'object',
  properties: {
    account: {
      type: 'object',
      title: 'Account',
      description: 'Who the work is billed to.',
      properties: { owner: { type: 'string', title: 'Owner' }, seats: { type: 'integer' } },
    },
    roots: {
      type: 'array',
      title: 'Roots',
      items: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
};

type Mounted = Awaited<ReturnType<typeof mount>>;

async function mount(schema: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const submitted: unknown[] = [];
  const drafts: unknown[] = [];
  const view = render(SchemaForm, {
    props: {
      schema,
      variant: 'setting-rows',
      onSubmit: (next: unknown) => void submitted.push(next),
      onDraftChange: (next: unknown) => void drafts.push(next),
      ...props,
    },
  });
  await flush();
  return { ...view, submitted, drafts };
}

const rowOf = (view: Mounted, key: string): HTMLElement =>
  requiredInstance(view.container.querySelector(`[data-cinder-field="${key}"]`), HTMLElement);

describe('SchemaForm setting-rows variant', () => {
  afterEach(() => cleanup());

  test('draws each top-level property as one row, in schema order, with its label, key, description and control', async () => {
    const view = await mount(plugin);
    const keys = [...view.container.querySelectorAll('[data-cinder-field]')].map((row) =>
      row.getAttribute('data-cinder-field'),
    );
    expect(keys).toEqual([
      'searchAddress',
      'region',
      'includeSnippets',
      'limit',
      'blockedSites',
      'cacheMs',
    ]);
    expect(view.container.querySelectorAll('.cinder-setting-row')).toHaveLength(6);

    const text = rowOf(view, 'searchAddress');
    expect(text.querySelector('.cinder-form-field__label')?.textContent).toContain(
      'Search address',
    );
    expect(text.querySelector('.cinder-setting-row__identifier')?.textContent).toBe(
      'searchAddress',
    );
    expect(text.textContent).toContain('The service the search goes to.');
    // The schema requires it, so the row carries the required mark.
    expect(text.querySelector('.cinder-_required-marker')).not.toBeNull();
    expect(text.querySelector('input[type="text"]')).not.toBeNull();

    // The key as words stands in when the schema has no title.
    expect(rowOf(view, 'region').querySelector('.cinder-form-field__label')?.textContent).toContain(
      'Region',
    );
    expect(rowOf(view, 'region').querySelector('.cinder-_required-marker')).toBeNull();
    const select = requiredInstance(
      rowOf(view, 'region').querySelector('select'),
      HTMLSelectElement,
    );
    expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
      'Not set',
      'us',
      'eu',
    ]);
    expect(rowOf(view, 'includeSnippets').querySelector('[role="switch"]')).not.toBeNull();
    expect(
      rowOf(view, 'limit').querySelector('input[type="text"], input[type="number"]'),
    ).not.toBeNull();
    // A string array is tags: a field to add one, no JSON editor.
    expect(rowOf(view, 'blockedSites').querySelector('textarea')).toBeNull();
    expect(rowOf(view, 'blockedSites').querySelector('input')).not.toBeNull();
    // The tag input sits under its row at the row's full width, outside the control column.
    expect(
      rowOf(view, 'blockedSites').querySelector('input')?.closest('.cinder-setting-row__field'),
    ).toBeNull();
    // Text entry fills the control column; the switch stays at the end.
    for (const key of ['searchAddress', 'region', 'limit', 'cacheMs']) {
      expect(
        rowOf(view, key)
          .querySelector('.cinder-setting-row')
          ?.getAttribute('data-cinder-control-align'),
      ).toBe('stretch');
    }
    expect(
      rowOf(view, 'includeSnippets')
        .querySelector('.cinder-setting-row')
        ?.hasAttribute('data-cinder-control-align'),
    ).toBe(false);
    // A duration keeps its unit control.
    expect(rowOf(view, 'cacheMs').querySelector('select')).not.toBeNull();
    // The row's control is the one at the inline end: switch rows size to the switch.
    expect(
      rowOf(view, 'includeSnippets')
        .querySelector<HTMLElement>('.cinder-setting-row')
        ?.getAttribute('style'),
    ).toContain('auto');
  });

  test('draws an object and an array of objects full width under their label, with no nested row and no box', async () => {
    const view = await mount(nested);
    // One row for each top-level property, and none for the owner inside the account.
    expect(view.container.querySelectorAll('.cinder-setting-row')).toHaveLength(2);
    expect(view.container.querySelector('fieldset')).toBeNull();
    expect(view.container.querySelector('.cinder-schema-form__fieldset')).toBeNull();

    const account = rowOf(view, 'account');
    expect(account.textContent).toContain('Who the work is billed to.');
    // Its fields sit under the row's label and description, outside the row's field grid.
    const owner = screen.getByLabelText('Owner');
    expect(account.contains(owner)).toBe(true);
    expect(owner.closest('.cinder-setting-row__field')).toBeNull();
    // An array of objects is one JSON editor, as the Plugins page draws it.
    expect(
      rowOf(view, 'roots').querySelector('textarea, [role="textbox"], .cm-editor'),
    ).not.toBeNull();
    expect(rowOf(view, 'roots').querySelector('.cinder-schema-form__array-item')).toBeNull();
  });

  describe('a group that holds one short field', () => {
    const group = (property: Record<string, unknown>) => ({
      type: 'object',
      properties: {
        account: {
          type: 'object',
          title: 'Account',
          description: 'Who the work is billed to.',
          properties: { owner: { title: 'Owner', ...property } },
        },
      },
    });

    const kinds: Array<[string, Record<string, unknown>, string]> = [
      ['text', { type: 'string' }, 'textbox'],
      ['number', { type: 'number' }, 'spinbutton'],
      ['select', { type: 'string', enum: ['ada', 'grace'] }, 'combobox'],
      ['duration', { type: 'number', format: 'duration-ms' }, 'spinbutton'],
      ['switch', { type: 'boolean' }, 'switch'],
    ];

    for (const [kind, property, role] of kinds) {
      test(`draws a ${kind} as one row: the group's words lead and the field's label names the control`, async () => {
        const view = await mount(group(property));
        // One row, not a row with a field under it.
        expect(view.container.querySelectorAll('.cinder-setting-row')).toHaveLength(1);
        const account = rowOf(view, 'account');
        // The group's title and description are the row's.
        expect(account.querySelector('.cinder-form-field__label')?.textContent).toContain(
          'Account',
        );
        expect(account.textContent).toContain('Who the work is billed to.');
        // The control sits in the control column, with the row.
        const control = screen.getByRole(role, { name: 'Owner' });
        expect(control.closest('.cinder-setting-row__field')).not.toBeNull();
        // The group is named by its title and described by its description.
        const grouped = requiredInstance(account, HTMLElement);
        expect(grouped.getAttribute('role')).toBe('group');
        const labelledBy = grouped.getAttribute('aria-labelledby') ?? '';
        expect(view.container.querySelector(`[id="${labelledBy}"]`)?.textContent).toContain(
          'Account',
        );
        const describedBy = (control.getAttribute('aria-describedby') ?? '').split(' ');
        const description = describedBy
          .map((id) => view.container.querySelector(`[id="${id}"]`)?.textContent ?? '')
          .join(' ');
        expect(description).toContain('Who the work is billed to.');
      });
    }

    test('keeps the switch at the inline end and the other controls stretched', async () => {
      const text = await mount(group({ type: 'string' }));
      expect(
        rowOf(text, 'account')
          .querySelector('.cinder-setting-row')
          ?.getAttribute('data-cinder-control-align'),
      ).toBe('stretch');
      cleanup();
      const toggle = await mount(group({ type: 'boolean' }));
      expect(
        rowOf(toggle, 'account')
          .querySelector('.cinder-setting-row')
          ?.hasAttribute('data-cinder-control-align'),
      ).toBe(false);
    });

    test('reports its value in the same draft shape as the default variant', async () => {
      const view = await mount(group({ type: 'string' }), {
        value: { account: { owner: 'Operations' } },
      });
      const owner = screen.getByRole('textbox', { name: 'Owner' });
      await fireEvent.input(owner, { target: { value: 'Billing' } });
      await flush();
      expect(view.drafts.at(-1)).toEqual({ account: { owner: 'Billing' } });
    });

    test('shows a host issue on the field as the row error, and marks the control invalid', async () => {
      const view = await mount(group({ type: 'string' }), {
        issues: [{ path: ['account', 'owner'], message: 'Name an owner.' }],
      });
      expect(rowOf(view, 'account').textContent).toContain('Name an owner.');
      const owner = screen.getByRole('textbox', { name: 'Owner' });
      expect(owner.getAttribute('aria-invalid')).toBe('true');
    });

    test('draws a group of a list of strings, a nested group, or an array of objects under its row as before', async () => {
      for (const property of [
        { type: 'array', items: { type: 'string' } },
        { type: 'object', properties: { name: { type: 'string' } } },
        { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } } } },
      ]) {
        const view = await mount(group(property));
        const account = rowOf(view, 'account');
        expect(account.getAttribute('role')).toBeNull();
        expect(account.querySelector('.cinder-setting-row__field input')).toBeNull();
        cleanup();
      }
    });

    test('draws a group of two fields as before', async () => {
      const view = await mount(nested);
      expect(rowOf(view, 'account').getAttribute('role')).toBeNull();
    });
  });

  test('shows a host issue as the error of the row it names, and clears it when the field is edited', async () => {
    const view = await mount(plugin, {
      value: { searchAddress: 'https://search.example' },
      issues: [{ path: ['searchAddress'], message: 'Must be an https address.' }],
    });
    expect(rowOf(view, 'searchAddress').textContent).toContain('Must be an https address.');
    expect(rowOf(view, 'region').textContent).not.toContain('Must be an https address.');
    // Nothing is shown at the form itself, since the path names a field.
    expect(view.container.querySelector('[role="alert"]')).toBeNull();

    await fireEvent.input(
      requiredInstance(rowOf(view, 'searchAddress').querySelector('input'), HTMLInputElement),
      {
        target: { value: 'https://other.example' },
      },
    );
    await flush();
    expect(rowOf(view, 'searchAddress').textContent).not.toContain('Must be an https address.');
  });

  test('reports the draft the default variant reports for the same edits', async () => {
    const edit = async (variant: 'default' | 'setting-rows') => {
      // `region` is required here: an optional choice with no default starts unset in the rows only.
      const view = await mount(
        { ...plugin, required: ['searchAddress', 'region'] },
        { variant, value: { searchAddress: 'a' } },
      );
      await fireEvent.input(
        requiredInstance(view.container.querySelector('input[type="text"]'), HTMLInputElement),
        {
          target: { value: 'https://search.example' },
        },
      );
      await flush();
      const drafts = view.drafts;
      cleanup();
      return drafts.at(-1);
    };
    const rows = await edit('setting-rows');
    expect(rows).toEqual(await edit('default'));
    expect(rows).toMatchObject({ searchAddress: 'https://search.example', region: 'us' });
  });

  test('follows submitVisible for the submit button, and submits through it', async () => {
    const shown = await mount(plugin, { value: { searchAddress: 'a' }, submitLabel: 'Save' });
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('submit');
    await fireEvent.click(button);
    await flush();
    await flush();
    expect(shown.submitted).toHaveLength(1);
    cleanup();

    await mount(plugin, { submitVisible: false, submitLabel: 'Save' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  test('disables every control when the host disables the form', async () => {
    const view = await mount(plugin, { disabled: true, value: { searchAddress: 'a' } });
    const controls = [...view.container.querySelectorAll('input, select')].filter(
      (control) => control.getAttribute('type') !== 'hidden',
    );
    expect(controls.length).toBeGreaterThan(4);
    expect(controls.every((control) => (control as HTMLInputElement).disabled)).toBe(true);
  });

  test('keeps the same rows in a form of more than eight fields: no filter, no JSON panel, schema order', async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`field${index}`, { type: 'string' }]),
    );
    const view = await mount({ type: 'object', properties, required: ['field9'] });
    expect(screen.queryByLabelText('Find a field')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit as JSON' })).toBeNull();
    expect(
      [...view.container.querySelectorAll('[data-cinder-field]')].map((row) =>
        row.getAttribute('data-cinder-field'),
      ),
    ).toEqual(Object.keys(properties));
  });

  test('reads a key as a sentence-case label, and leaves the other variants as they are', async () => {
    const schema = {
      type: 'object',
      properties: {
        blockedPatterns: { type: 'array', items: { type: 'string' } },
        baseURL: { type: 'string' },
      },
    };
    const view = await mount(schema);
    const label = (key: string) =>
      rowOf(view, key).querySelector('.cinder-form-field__label')?.textContent?.trim();
    expect(label('blockedPatterns')).toBe('Blocked patterns');
    expect(label('baseURL')).toBe('Base URL');
    cleanup();

    const plain = await mount(schema, { variant: 'default' });
    expect(plain.container.textContent).toContain('Blocked Patterns');
  });

  test('names the fields of a group and the buttons of an array in sentence case too, in the rows only', async () => {
    const schema = {
      type: 'object',
      properties: {
        billingAccount: {
          type: 'object',
          properties: { ownerName: { type: 'string' }, seatCount: { type: 'integer' } },
        },
        extraFolders: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    };
    const view = await mount(schema, {
      value: { billingAccount: {}, extraFolders: [] },
    });
    expect(screen.getByLabelText('Owner name')).toBeDefined();
    expect(screen.getByLabelText('Seat count')).toBeDefined();
    expect(view.container.textContent).not.toContain('Owner Name');
    cleanup();

    // The array of objects is one JSON editor in the rows; a list of groups keeps its buttons.
    const list = await mount(
      {
        type: 'object',
        properties: {
          extraFolders: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        },
      },
      { value: { extraFolders: [[{ path: 'a' }]] } },
    );
    expect(list.container.textContent).toContain('Add Extra folders');
    expect(screen.getByRole('button', { name: 'Remove Extra folders item 1' })).toBeDefined();
  });

  test('leaves out the key when the label is made from it', async () => {
    const view = await mount({
      type: 'object',
      properties: {
        includeSnippets: { type: 'boolean' },
        baseURL: { type: 'string' },
        blank: { type: 'string', title: '   ' },
      },
    });
    for (const key of ['includeSnippets', 'baseURL', 'blank']) {
      expect(rowOf(view, key).querySelector('.cinder-setting-row__identifier')).toBeNull();
    }
    expect(rowOf(view, 'baseURL').textContent).toContain('Base URL');
  });

  test('shows the key beside a title the schema supplies, unless the title is the key in another case', async () => {
    const view = await mount({
      type: 'object',
      properties: {
        baseURL: { type: 'string', title: 'Endpoint' },
        models: { type: 'string', title: 'Models' },
      },
    });
    expect(
      rowOf(view, 'baseURL').querySelector('.cinder-setting-row__identifier')?.textContent,
    ).toBe('baseURL');
    expect(rowOf(view, 'models').querySelector('.cinder-setting-row__identifier')).toBeNull();
  });

  test('starts an optional choice with no default unset, can clear it, and reports it as absent', async () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', enum: ['us', 'eu'] },
        tier: { type: 'string', enum: ['free', 'pro'], default: 'pro' },
        plan: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['plan'],
    };
    const view = await mount(schema);
    const select = (key: string) =>
      requiredInstance(rowOf(view, key).querySelector('select'), HTMLSelectElement);
    const texts = (key: string) =>
      [...select(key).options].map((option) => option.textContent?.trim());
    // Only the optional choice with no default offers the empty one, and starts on it.
    expect(texts('region')).toEqual(['Not set', 'us', 'eu']);
    expect(select('region').value).toBe('');
    expect(texts('tier')).toEqual(['free', 'pro']);
    expect(texts('plan')).toEqual(['a', 'b']);

    select('region').value = '"eu"';
    await fireEvent.change(select('region'));
    await flush();
    expect(view.drafts.at(-1)).toMatchObject({ region: 'eu' });
    select('region').value = '';
    await fireEvent.change(select('region'));
    await flush();
    const cleared = view.drafts.at(-1) as Record<string, unknown>;
    expect(Object.hasOwn(cleared, 'region')).toBe(false);
  });
});
