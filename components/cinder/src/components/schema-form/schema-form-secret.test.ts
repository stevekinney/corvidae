/// <reference lib="dom" />
/**
 * COR-2181 — a string marked `secret: true` is a reference to a saved secret: a Select of keys,
 * grouped, each with a Set or Missing note, whose value is `{ "$secret": key }` and nothing else. And
 * `readOnly` draws every field as a label and its value, with a secret as its key and a dot.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, requiredValue, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const { initialDraftOf, secretKeyOf, isSecretReference, createSchemaFormModel } =
  await import('./schema-form-model.ts');
const { validateSchemaValue, withSecretReferences } = await import('./schema-form-validation.ts');

afterEach(() => cleanup());

// load-proof: Svelte effects and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const schema = {
  type: 'object',
  properties: {
    channel: { type: 'string', title: 'Channel' },
    token: { type: 'string', title: 'Token', description: 'The bot token.', secret: true },
    note: { type: 'string', title: 'Note', secret: true },
    password: { type: 'string', title: 'Password', writeOnly: true },
  },
  required: ['channel', 'token'],
} as const;

const KEYS = [
  { key: 'slack-bot-token', group: 'Slack', set: true },
  { key: 'slack-signing-key', group: 'Slack', set: false },
  { key: 'pager-api-key', group: 'Pager', set: true },
];

function trigger(container: HTMLElement): HTMLButtonElement {
  return requiredInstance(container.querySelector('[role="combobox"]'), HTMLButtonElement);
}

function rows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
}

async function open(container: HTMLElement): Promise<void> {
  await fireEvent.click(trigger(container));
  await waitFor(() => {
    if (rows().length === 0) throw new Error('the keys have not opened');
  });
}

async function mount(
  props: { value?: unknown; secrets?: unknown; readOnly?: boolean; disabled?: boolean } = {},
) {
  const drafts: unknown[] = [];
  const view = render(SchemaForm, {
    props: {
      schema,
      hosted: true,
      onDraftChange: (next: unknown) => void drafts.push(next),
      ...props,
    },
  } as never);
  await flush();
  return { ...view, drafts };
}

describe('a secret field', () => {
  test('is a Select of keys and draws no text or password input for the secret', async () => {
    const { container } = await mount({ secrets: { keys: KEYS } });

    const field = requiredValue(container.querySelector('.cinder-schema-form__secret'));
    expect(field.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(trigger(container).getAttribute('aria-haspopup')).toBe('listbox');
    // The other fields are drawn as ever; only the marked ones are references.
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelectorAll('.cinder-schema-form__secret')).toHaveLength(2);
  });

  test('lists the keys grouped by their group, each with the note Set or Missing, and the help', async () => {
    const { container } = await mount({ secrets: { keys: KEYS } });

    expect(container.textContent).toContain('The bot token.');
    expect(container.textContent).toContain(
      'Pick a saved secret. The form keeps its name, never its value.',
    );
    await open(container);

    const listed = rows().map((row) => ({
      key: row.querySelector('.cinder-select__option-label .cinder-text')?.textContent,
      note: row.querySelector('.cinder-select__option-note')?.textContent,
    }));
    expect(listed.filter(({ key }) => key !== 'None')).toEqual([
      { key: 'slack-bot-token', note: 'Set' },
      { key: 'slack-signing-key', note: 'Missing' },
      { key: 'pager-api-key', note: 'Set' },
    ]);
    const headings = Array.from(
      document.body.querySelectorAll('.cinder-select__group .cinder-_option-group__heading'),
    ).map((element) => element.textContent?.trim());
    expect(headings).toEqual(['Slack', 'Pager']);
    // Every key row is an identifier: monospace (Text's code variant) and cut in its middle when long.
    const keyRows = rows().filter((row) => !row.textContent?.includes('None'));
    expect(keyRows).toHaveLength(3);
    for (const row of keyRows) {
      const key = requiredInstance(
        row.querySelector('.cinder-select__option-label .cinder-text'),
        HTMLElement,
      );
      expect(key.getAttribute('data-cinder-variant')).toBe('code');
      expect(key.getAttribute('data-cinder-truncate')).toBe('middle');
      // The list is driven from its trigger: the key is no Tab stop of its own.
      expect(key.getAttribute('tabindex')).toBe('-1');
    }
  });

  test('shows a long key whole, cut only by Text in its middle, with the whole key in a tooltip', async () => {
    const long = `plugin-${'x'.repeat(60)}-api-key`;
    const { container } = await mount({
      secrets: { keys: [{ key: long, group: 'Plugin', set: true }] },
      value: { channel: 'ops', token: { $secret: long } },
    });
    await open(container);

    const row = requiredValue(rows().find((candidate) => candidate.textContent?.includes(long)));
    // The row's name is the whole key, and no description repeats it.
    expect(row.querySelector('.cinder-select__option-label .cinder-text')?.textContent).toBe(long);
    expect(row.querySelector('.cinder-select__option-description')).toBeNull();
    const key = requiredInstance(row.querySelector('[data-cinder-truncate="middle"]'), HTMLElement);
    expect(key.querySelector('.cinder-text__head')?.textContent).toBe(long.slice(0, -4));
    expect(key.querySelector('.cinder-text__tail')?.textContent).toBe(long.slice(-4));
    expect(row.querySelector('[role="tooltip"]')?.textContent).toBe(long);
    // Its accessible name is the whole key and its note, never the two boxes of the cut.
    expect(row.getAttribute('aria-label')).toBe(`${long} Set`);
  });

  test('the trigger draws a long chosen key as its option does: monospace, cut in its middle, the whole key in a tooltip (R10-13)', async () => {
    const long = `plugin-${'x'.repeat(60)}-api-key`;
    const { container } = await mount({
      secrets: { keys: [{ key: long, group: 'Plugin', set: true }] },
      value: { channel: 'ops', token: { $secret: long } },
    });
    const value = requiredValue(trigger(container).querySelector('.cinder-select__value'));
    expect(value.hasAttribute('data-cinder-code')).toBe(true);
    const key = requiredInstance(value.querySelector('.cinder-text'), HTMLElement);
    expect(key.getAttribute('data-cinder-variant')).toBe('code');
    expect(key.getAttribute('data-cinder-truncate')).toBe('middle');
    // The trigger is the field's one Tab stop: the key in it is not another.
    expect(key.getAttribute('tabindex')).toBe('-1');
    expect(value.querySelector('[role="tooltip"]')?.textContent).toBe(long);
  });

  test('the field’s column never takes a chosen key’s whole width, so a long key is cut, not overflowing (R10-13)', async () => {
    // An implicit `auto` grid track takes the Select's min-content, the whole key, and widened the
    // trigger and its help past a 320-pixel screen. The layout is measured in the schema-form
    // browser fixture; this pins the rule that holds the column to its container.
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('./schema-form.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.cinder-schema-form__secret \{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
  });

  test('sets only keys in monospace: the field root, so its label, help and placeholder, keeps the form’s face (R10-13)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('./schema-form.css', import.meta.url), 'utf8');
    const monospaced = [
      ...css.matchAll(/([^{}]+)\{[^{}]*font-family:\s*var\(--cinder-font-mono\)/g),
    ]
      .map((match) => match[1] ?? '')
      .join(',');
    expect(monospaced).toContain('.cinder-schema-form__secret-key');
    expect(monospaced).not.toContain('.cinder-schema-form__secret-select');
    // The key in the warning sits on the sentence's baseline.
    expect(css).toMatch(
      /__secret-warning \.cinder-tooltip-wrapper\.cinder-text__tooltip \{[^}]*vertical-align: baseline;/,
    );
  });

  test('submits { "$secret": key } and nothing else, and reports no other value as a draft', async () => {
    const { container, drafts } = await mount({ secrets: { keys: KEYS } });

    await open(container);
    await fireEvent.click(
      requiredValue(rows().find((row) => row.textContent?.includes('slack-bot-token'))),
    );

    const draft = drafts.at(-1) as Record<string, unknown>;
    expect(draft['token']).toEqual({ $secret: 'slack-bot-token' });
    expect(JSON.stringify(draft)).not.toContain('"token":"');
    expect(Object.keys(draft['token'] as object)).toEqual(['$secret']);
  });

  test('reads a saved reference back as its key alone, and drops a plain value a host seeded', async () => {
    const seeded = await mount({
      secrets: { keys: KEYS },
      value: { channel: 'ops', token: { $secret: 'slack-bot-token' }, note: 'sk-live-leak' },
    });
    expect(trigger(seeded.container).textContent).toContain('slack-bot-token');
    expect(seeded.container.textContent).not.toContain('sk-live-leak');
    expect(initialDraftOf(schema, { channel: 'ops', token: 'sk-live-leak' })).toEqual({
      channel: 'ops',
      password: '',
    });
    expect(initialDraftOf(schema, { token: { $secret: 'k', extra: 1 } })).not.toHaveProperty(
      'token',
    );
  });

  test('warns under a chosen key that is Missing, with the key in monospace and an Add the key action', async () => {
    const onAdd = mock(() => {});
    const { container } = await mount({
      secrets: { keys: KEYS, onAdd },
      value: { channel: 'ops', token: { $secret: 'slack-signing-key' } },
    });

    const warning = requiredValue(container.querySelector('.cinder-schema-form__secret-warning'));
    expect(warning.textContent).toContain('slack-signing-key isn’t saved yet.');
    const key = requiredValue(warning.querySelector('code'));
    expect(key.textContent).toBe('slack-signing-key');
    // A long key gives way in its middle, with the whole key in a tooltip, never a wrap.
    expect(key.getAttribute('data-cinder-truncate')).toBe('middle');
    expect(warning.querySelector('[role="tooltip"]')?.textContent).toBe('slack-signing-key');
    // The sentence's one action reads as a link does: Button's link variant, not grey ghost text.
    expect(warning.querySelector('button')?.getAttribute('data-cinder-variant')).toBe('link');
    await fireEvent.click(requiredValue(warning.querySelector('button')));
    expect(onAdd).toHaveBeenCalledWith('slack-signing-key');
  });

  test('says a chosen key that is Set is fine: no warning', async () => {
    const { container } = await mount({
      secrets: { keys: KEYS },
      value: { channel: 'ops', token: { $secret: 'slack-bot-token' } },
    });
    expect(container.querySelector('.cinder-schema-form__secret-warning')).toBeNull();
  });

  test('shows a chosen key the host does not list as Missing, so it is never hidden', async () => {
    const { container } = await mount({
      secrets: { keys: KEYS },
      value: { channel: 'ops', token: { $secret: 'old-key' } },
    });
    expect(trigger(container).textContent).toContain('old-key');
    expect(container.querySelector('.cinder-schema-form__secret-warning')?.textContent).toContain(
      'old-key',
    );
  });

  test('with no keys is disabled with its placeholder, and links to where one is saved', async () => {
    const { container } = await mount({
      secrets: {
        keys: [],
        copy: { emptyHelp: 'Plugins name the secrets they use. Save one in', emptyHelpEnd: '.' },
        manage: { label: 'Settings › Plugins', href: '/settings/plugins' },
      },
    });

    const first = trigger(container);
    expect(first.disabled || first.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(first.textContent).toContain('No secrets to choose');
    const help = requiredValue(container.querySelector('.cinder-schema-form__secret-help'));
    expect(help.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      'Plugins name the secrets they use. Save one in Settings › Plugins.',
    );
    const manage = requiredInstance(help.querySelector('a'), HTMLAnchorElement);
    expect(manage.getAttribute('href')).toBe('/settings/plugins');
    // The link sits in a sentence, so it is underlined: it is told apart without its color.
    expect(manage.getAttribute('data-underline')).toBe('always');
    // The help is the size of every other field's help (FormField's), not the warning's.
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('./schema-form.css', import.meta.url), 'utf8');
    const own = /\.cinder-schema-form__secret-help\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(own).toMatch(/font-size:\s*var\(--cinder-text-xs\);/);
    expect(own).toMatch(/line-height:\s*var\(--cinder-leading-normal\);/);
  });

  test('when the keys cannot be read says so, offers Try again, and leaves the other fields usable', async () => {
    const onRetry = mock(() => {});
    const { container, drafts } = await mount({
      secrets: { keys: [], status: 'failed', onRetry },
    });

    const failed = requiredValue(container.querySelector('.cinder-schema-form__secret-failed'));
    expect(failed.textContent).toContain('Couldn’t load the saved secrets.');
    // R10-15: Cinder's one-row failure with its own retry, never a bare sentence and a ghost button.
    expect(failed.classList.contains('cinder-error-state')).toBe(true);
    expect(failed.getAttribute('data-cinder-variant')).toBe('row');
    expect(failed.querySelector('[role="alert"]')).not.toBeNull();
    expect(failed.querySelector('button')?.textContent?.trim()).toBe('Try again');
    // The label keeps its required dot, as in every other state.
    const label = requiredValue(container.querySelector('.cinder-schema-form__secret-label'));
    expect(label.textContent?.trim()).toBe('Token');
    expect(label.querySelector('.cinder-_required-marker')).not.toBeNull();
    await fireEvent.click(requiredValue(failed.querySelector('button')));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    const channel = requiredInstance(
      container.querySelector('input[type="text"]'),
      HTMLInputElement,
    );
    await fireEvent.input(channel, { target: { value: 'ops' } });
    expect((drafts.at(-1) as Record<string, unknown>)['channel']).toBe('ops');
  });

  test('is held while the form is disabled', async () => {
    const { container } = await mount({ secrets: { keys: KEYS }, disabled: true });
    expect(
      trigger(container).disabled || trigger(container).getAttribute('aria-disabled') === 'true',
    ).toBe(true);
  });

  test('an optional secret offers None, and choosing it clears the reference', async () => {
    const { container, drafts } = await mount({
      secrets: { keys: KEYS },
      value: {
        channel: 'ops',
        token: { $secret: 'slack-bot-token' },
        note: { $secret: 'pager-api-key' },
      },
    });
    const triggers = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="combobox"]'));
    await fireEvent.click(requiredValue(triggers[1]));
    await waitFor(() => {
      if (rows().length === 0) throw new Error('the keys have not opened');
    });
    await fireEvent.click(requiredValue(rows().find((row) => row.textContent?.includes('None'))));
    expect(drafts.at(-1)).not.toHaveProperty('note');
    expect((drafts.at(-1) as Record<string, unknown>)['token']).toEqual({
      $secret: 'slack-bot-token',
    });
  });
});

describe('secret references in the model and the validator', () => {
  test('a string marked secret is the secret kind, and a plain string is not', () => {
    const model = createSchemaFormModel(schema);
    expect(model.field.fields.map(({ key, kind }) => [key, kind])).toEqual([
      ['channel', 'string'],
      ['token', 'secret'],
      ['note', 'secret'],
      ['password', 'string'],
    ]);
  });

  test('a reference passes, a plain string does not, and a missing required reference is refused', async () => {
    const ok = await validateSchemaValue(schema, { channel: 'ops', token: { $secret: 'k' } });
    expect(ok.valid).toBe(true);
    const plain = await validateSchemaValue(schema, { channel: 'ops', token: 'sk-live-x' });
    expect(plain.valid).toBe(false);
    const extra = await validateSchemaValue(schema, {
      channel: 'ops',
      token: { $secret: 'k', value: 'sk-live-x' },
    });
    expect(extra.valid).toBe(false);
    const missing = await validateSchemaValue(schema, { channel: 'ops' });
    expect(missing.valid).toBe(false);
    expect(missing.issues.map((issue) => issue.path)).toEqual([['token']]);
  });

  test('the rewritten schema is cached per schema and leaves one without a marker as it is', () => {
    expect(withSecretReferences(schema)).toBe(withSecretReferences(schema));
    const plain = { type: 'object', properties: { a: { type: 'string' } } };
    expect(withSecretReferences(plain)).toBe(plain);
    const inData = {
      type: 'object',
      properties: { a: { type: 'string', default: { secret: true, type: 'string' } } },
    };
    expect(withSecretReferences(inData)).toBe(inData);
  });

  test.each(['default', 'examples', 'const', 'enum'])(
    'validates a secret field named %s, a field and not the keyword',
    async (name) => {
      const named = {
        type: 'object',
        properties: { [name]: { type: 'string', secret: true } },
        required: [name],
      };
      const reference = await validateSchemaValue(named, { [name]: { $secret: 'k' } });
      expect(reference.valid).toBe(true);
      const plain = await validateSchemaValue(named, { [name]: 'sk-live-x' });
      expect(plain.valid).toBe(false);
      // Under $defs, reached by a reference, the field's name is no keyword either.
      const defined = {
        type: 'object',
        properties: { token: { $ref: '#/$defs/enum' } },
        $defs: { enum: { type: 'string', secret: true } },
      };
      const throughDefinitions = await validateSchemaValue(defined, { token: { $secret: 'k' } });
      expect(throughDefinitions.valid).toBe(true);
    },
  );

  test('reads a reference and nothing else as a key', () => {
    expect(secretKeyOf({ $secret: 'k' })).toBe('k');
    expect(isSecretReference({ $secret: '' })).toBe(false);
    expect(isSecretReference({ $secret: 'k', other: 1 })).toBe(false);
    expect(isSecretReference('k')).toBe(false);
    expect(secretKeyOf(undefined)).toBeUndefined();
  });
});

describe('a read-only form', () => {
  const value = {
    channel: 'ops',
    token: { $secret: 'slack-bot-token' },
    note: { $secret: 'slack-signing-key' },
    password: 'hunter2',
  };

  test('is a group of label and value pairs with no control, no submit button and no hidden output', async () => {
    const { container } = await mount({ readOnly: true, value, secrets: { keys: KEYS } });

    const root = requiredValue(container.querySelector('.cinder-schema-form'));
    expect(root.tagName).toBe('DIV');
    expect(root.getAttribute('role')).toBe('group');
    expect(root.hasAttribute('data-cinder-read-only')).toBe(true);
    expect(container.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    const pairs = Array.from(container.querySelectorAll('dt')).map((term) => term.textContent);
    expect(pairs).toEqual(['Channel', 'Token', 'Note', 'Password']);
    expect(container.querySelector('dd')?.textContent?.trim()).toBe('ops');
  });

  test('shows a secret as its key in monospace beside Set or Missing, and never a password', async () => {
    const { container } = await mount({ readOnly: true, value, secrets: { keys: KEYS } });

    const keys = Array.from(container.querySelectorAll('[data-cinder-secret-key]'));
    expect(keys.map((key) => key.textContent)).toEqual(['slack-bot-token', 'slack-signing-key']);
    expect(keys.every((key) => key.tagName === 'CODE')).toBe(true);
    // A key is cut in its middle with the whole key in a tooltip, never wrapped.
    expect(keys.every((key) => key.getAttribute('data-cinder-truncate') === 'middle')).toBe(true);
    expect(
      Array.from(
        container.querySelectorAll('.cinder-schema-form__secret-value [role="tooltip"]'),
      ).map((tooltip) => tooltip.textContent),
    ).toEqual(['slack-bot-token', 'slack-signing-key']);
    const dots = Array.from(container.querySelectorAll('.cinder-status-dot')).map((dot) => [
      dot.getAttribute('data-cinder-status'),
      dot.textContent?.trim(),
    ]);
    expect(dots).toEqual([
      ['success', 'Set'],
      ['neutral', 'Missing'],
    ]);
    expect(container.textContent).toContain('Hidden');
    expect(container.textContent).not.toContain('hunter2');
  });

  test('says a secret that names no key is not chosen, and an empty value is a dash', async () => {
    const { container } = await mount({
      readOnly: true,
      value: { channel: '' },
      secrets: { keys: KEYS },
    });
    expect(container.textContent).toContain('Not chosen');
    expect(container.textContent).toContain('—');
  });

  test('draws the other kinds as words: yes and no, an option’s label, a list, a group', async () => {
    const view = render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: {
            urgent: { type: 'boolean', title: 'Urgent' },
            level: { type: 'string', title: 'Level', enum: ['low', 'high'] },
            tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
            timeoutMs: { type: 'integer', title: 'Timeout', format: 'duration-ms' },
            owner: {
              type: 'object',
              title: 'Owner',
              properties: { name: { type: 'string', title: 'Name' } },
            },
          },
        },
        readOnly: true,
        value: {
          urgent: true,
          level: 'high',
          tags: ['a', 'b'],
          timeoutMs: 5000,
          owner: { name: 'Ada' },
        },
      },
    } as never);
    await flush();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Yes');
    expect(text).toContain('high');
    expect(text).toContain('a, b');
    expect(text).toContain('5 seconds');
    expect(text).toContain('Ada');
    expect(view.container.querySelectorAll('input, button, select')).toHaveLength(0);
  });
});
