import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, test } from 'bun:test';

import type { SettingsSnapshot } from '../../lib/bureau-settings.ts';
import { controlFor, type Control } from './settings-controls.ts';
import { PUBLISHED_SCHEMA, SETTING_VALUES } from './settings-fixtures.test-support.ts';
import { problemWith, sameValue, SettingsForm } from './settings-form.svelte.ts';

const JSON_CONTROL: Control = { kind: 'json' };

const controls = new Map<string, Control>([
  ...Object.entries(PUBLISHED_SCHEMA.properties).map(([key, node]): [string, Control] => [
    key,
    controlFor(key, node),
  ]),
  // No key the Bureau publishes today is a JSON editor's, so a made-up one stands for the shape.
  ['custom.list', JSON_CONTROL],
]);

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return { values: { ...SETTING_VALUES }, revision: 3, persisted: true, keys: {}, ...overrides };
}

function loaded(
  locked: readonly string[] = [],
  values: SettingsSnapshot['values'] = { ...SETTING_VALUES, 'custom.list': [1] },
  validate?: (key: string, value: unknown) => Promise<string | undefined>,
) {
  const form = new SettingsForm(controls, (key) => locked.includes(key), validate);
  form.load(snapshot({ values: { ...values } }));
  return form;
}

describe('two values', () => {
  test('are the same whatever the order of an object’s keys', () => {
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({}, false)).toBe(false);
    expect(sameValue(undefined, undefined)).toBe(true);
  });
});

describe('the form', () => {
  test('starts with nothing dirty, at the revision it read', () => {
    const form = loaded();
    expect(form.revision).toBe(3);
    expect(form.dirtyKeys).toEqual([]);
    expect(form.canSave).toBe(false);
    expect(form.patch()).toEqual({});
  });

  test('sends the dirty keys, each with its draft, in the schema’s order', async () => {
    const form = loaded();
    form.set('durable', false);
    form.set('tools.wakeup', false);
    form.set('retention.audit', { olderThan: 1000 });

    expect(form.dirtyKeys).toEqual(['tools.wakeup', 'retention.audit', 'durable']);
    expect(form.patch()).toEqual({
      'tools.wakeup': false,
      'retention.audit': { olderThan: 1000 },
      durable: false,
    });
    await waitUntil(() => form.canSave);
  });

  test('is no longer dirty for a key put back to what it held', () => {
    const form = loaded();
    form.set('tools.wakeup', false);
    form.set('tools.wakeup', true);
    expect(form.dirtyKeys).toEqual([]);
  });

  test('never makes a locked key dirty', () => {
    const form = loaded(['tools.wakeup']);
    form.set('tools.wakeup', false);
    expect(form.isDirty('tools.wakeup')).toBe(false);
    expect(form.patch()).toEqual({});
  });

  test('keeps JSON text that does not parse out of the patch, and takes it once it does', () => {
    const form = loaded();
    form.setText('custom.list', '[1,');
    expect(form.isDirty('custom.list')).toBe(true);
    expect(form.error('custom.list')).toBeString();
    expect(form.canSave).toBe(false);

    form.setText('custom.list', '[1, 2]');
    expect(form.error('custom.list')).toBeUndefined();
    expect(form.patch()).toEqual({ 'custom.list': [1, 2] });
  });

  test('will not send a JSON editor that was emptied for a key that had a value', () => {
    const form = loaded();
    form.setText('custom.list', '  ');
    expect(form.error('custom.list')).toBe('Enter a JSON value.');
    expect(form.canSave).toBe(false);
  });

  test('will not send a required number that is empty, or one outside its bounds', () => {
    const form = loaded();
    form.set('decisions.maximumPerTask', undefined);
    expect(form.error('decisions.maximumPerTask')).toBe('Enter a number.');
    form.set('decisions.maximumPerTask', 0);
    expect(form.error('decisions.maximumPerTask')).toBe('Enter more than 0.');
    form.set('decisions.maximumPerTask', 2.5);
    expect(form.error('decisions.maximumPerTask')).toBe('Enter a whole number.');
    form.set('decisions.maximumPerTask', 30);
    expect(form.error('decisions.maximumPerTask')).toBeUndefined();
  });

  test('checks a text key against the pattern its schema gives', () => {
    const form = loaded();
    form.set('workflowVersion', undefined);
    expect(form.error('workflowVersion')).toBe('Enter a value.');
    expect(
      controlFor('workflowVersion', PUBLISHED_SCHEMA.properties['workflowVersion'] as never),
    ).toEqual({
      kind: 'text',
      pattern: undefined,
    });
    expect(problemWith({ kind: 'text', pattern: '^[^/\\s]+\\/\\S+$' }, 'no-slash', true)).toBe(
      'That is not in the form this setting takes.',
    );
    expect(
      problemWith({ kind: 'text', pattern: '^[^/\\s]+\\/\\S+$' }, 'a/b', true),
    ).toBeUndefined();
  });

  test('turns a switch of false or an object off and on, and remembers the object', () => {
    const form = loaded();
    form.setSwitch('tools.humanInput', false);
    expect(form.draft('tools.humanInput')).toBe(false);
    form.setSwitch('tools.humanInput', true);
    expect(form.draft('tools.humanInput')).toEqual({});
    form.set('tools.humanInput', { inputSchemas: { environment: { type: 'string' } } });
    form.setSwitch('tools.humanInput', false);
    form.setSwitch('tools.humanInput', true);
    expect(form.draft('tools.humanInput')).toEqual({
      inputSchemas: { environment: { type: 'string' } },
    });
  });

  test('holds a form key’s value to its schema after each edit, and sends nothing until the check ends', async () => {
    const seen: unknown[] = [];
    const form = loaded([], undefined, async (key, value) => {
      seen.push([key, value]);
      return (value as { olderThan?: unknown }).olderThan === -1 ? 'Enter 0 or more.' : undefined;
    });
    form.set('retention.receipts', { olderThan: -1 });
    expect(form.canSave).toBe(false);
    await waitUntil(() => form.error('retention.receipts') !== undefined);
    expect(form.error('retention.receipts')).toBe('Enter 0 or more.');
    expect(form.canSave).toBe(false);

    form.set('retention.receipts', { olderThan: 5 });
    expect(form.error('retention.receipts')).toBeUndefined();
    await waitUntil(() => form.canSave);
    expect(form.patch()).toEqual({ 'retention.receipts': { olderThan: 5 } });
    expect(seen).toHaveLength(2);
  });

  test('ignores a check that an edit made since has overtaken', async () => {
    const answers: Array<(problem: string | undefined) => void> = [];
    const form = loaded(
      [],
      undefined,
      () => new Promise<string | undefined>((resolve) => answers.push(resolve)),
    );
    form.set('retention.receipts', { olderThan: -1 });
    form.set('retention.receipts', { olderThan: 7 });
    answers[1]?.(undefined);
    await waitUntil(() => form.canSave);
    answers[0]?.('Enter 0 or more.');
    await quietFor(10);
    expect(form.error('retention.receipts')).toBeUndefined();
    expect(form.canSave).toBe(true);
  });

  test('says the value could not be checked when the check fails', async () => {
    const form = loaded([], undefined, () => Promise.reject(new Error('boom')));
    form.set('retention.receipts', { olderThan: 5 });
    await waitUntil(() => form.error('retention.receipts') !== undefined);
    expect(form.canSave).toBe(false);
  });

  test('makes the forms again when it starts over, which is how a form seeded once takes a new value', () => {
    const form = loaded();
    const before = form.generation;
    form.set('retention.receipts', { olderThan: 5 });
    expect(form.generation).toBe(before);
    form.discard();
    expect(form.generation).toBe(before + 1);
    form.load(snapshot());
    expect(form.generation).toBe(before + 2);
  });

  test('starts a key with no value empty, and does not call it a change', () => {
    const { 'engine.history': _history, ...values } = SETTING_VALUES;
    const form = loaded([], values);
    expect(form.draft('engine.history')).toBeUndefined();
    expect(form.isDirty('engine.history')).toBe(false);
    form.set('engine.history', { maxEvents: 5 });
    expect(form.patch()).toEqual({ 'engine.history': { maxEvents: 5 } });
    const empty = loaded([], {});
    expect(empty.text('custom.list')).toBe('');
  });

  test('puts every key back when discarded', () => {
    const form = loaded();
    form.set('durable', false);
    form.setText('custom.list', 'nope');
    form.discard();
    expect(form.dirtyKeys).toEqual([]);
    expect(form.text('custom.list')).toBe('[\n  1\n]');
  });
});

describe('a draft’s problem', () => {
  test('is none for a toggle and a JSON editor holding anything', () => {
    expect(problemWith({ kind: 'toggle' }, true, true)).toBeUndefined();
    expect(problemWith({ kind: 'json' }, { a: 1 }, true)).toBeUndefined();
  });

  test('is none for a form, whose value is checked against its schema after each edit', () => {
    expect(problemWith({ kind: 'form' }, { olderThan: 1 }, true)).toBeUndefined();
    expect(problemWith({ kind: 'switch-form' }, false, true)).toBeUndefined();
  });

  test('is an empty choice of a model, which is never sent', () => {
    const control: Control = { kind: 'choice', source: 'catalog-rows' };
    expect(problemWith(control, undefined, false)).toBeUndefined();
    expect(problemWith(control, '', true)).toBe('Choose one of the options.');
    expect(problemWith(control, 'anthropic/claude-haiku-5-5', true)).toBeUndefined();
  });

  test('is a choice outside a select’s options', () => {
    const control: Control = { kind: 'select', options: ['automatic', 'manual'] };
    expect(problemWith(control, 'manual', true)).toBeUndefined();
    expect(problemWith(control, 'weekly', true)).toBe('Choose one of the options.');
  });

  test('ignores a pattern JavaScript cannot read', () => {
    expect(problemWith({ kind: 'text', pattern: '(?<' }, 'anything', true)).toBeUndefined();
  });
});
