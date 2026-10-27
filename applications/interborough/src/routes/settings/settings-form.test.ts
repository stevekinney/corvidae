import { describe, expect, test } from 'bun:test';

import type { SettingsSnapshot } from '../../lib/bureau-settings.ts';
import { controlFor, type Control } from './settings-controls.ts';
import { PUBLISHED_SCHEMA, SETTING_VALUES } from './settings-fixtures.test-support.ts';
import { problemWith, sameValue, SettingsForm } from './settings-form.svelte.ts';

const controls = new Map<string, Control>(
  Object.entries(PUBLISHED_SCHEMA.properties).map(([key, node]) => [key, controlFor(node)]),
);

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return { values: { ...SETTING_VALUES }, revision: 3, persisted: true, keys: {}, ...overrides };
}

function loaded(
  locked: readonly string[] = [],
  values: SettingsSnapshot['values'] = SETTING_VALUES,
) {
  const form = new SettingsForm(controls, (key) => locked.includes(key));
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

  test('sends the dirty keys, each with its draft, in the schema’s order', () => {
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
    expect(form.canSave).toBe(true);
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
    form.setText('modelPolicy', '{"policyRevision":');
    expect(form.isDirty('modelPolicy')).toBe(true);
    expect(form.error('modelPolicy')).toBeString();
    expect(form.canSave).toBe(false);

    form.setText('modelPolicy', '{"policyRevision": 2}');
    expect(form.error('modelPolicy')).toBeUndefined();
    expect(form.patch()).toEqual({ modelPolicy: { policyRevision: 2 } });
  });

  test('will not send a JSON editor that was emptied for a key that had a value', () => {
    const form = loaded();
    form.setText('modelPolicy', '  ');
    expect(form.error('modelPolicy')).toBe('Enter a JSON value.');
    expect(form.canSave).toBe(false);
  });

  test('will not send a required number that is empty, or an object whose number is missing', () => {
    const form = loaded();
    form.set('decisions.maximumPerTask', undefined);
    expect(form.error('decisions.maximumPerTask')).toBe('Enter a number.');
    form.set('decisions.maximumPerTask', 0);
    expect(form.error('decisions.maximumPerTask')).toBe('Enter more than 0.');
    form.set('decisions.maximumPerTask', 2.5);
    expect(form.error('decisions.maximumPerTask')).toBe('Enter a whole number.');
    form.set('decisions.maximumPerTask', 30);
    expect(form.error('decisions.maximumPerTask')).toBeUndefined();

    form.set('retention.audit', {});
    expect(form.error('retention.audit')).toBe('Enter a number.');
    form.set('retention.audit', 'forever');
    expect(form.error('retention.audit')).toBeUndefined();
    form.set('retention.checkpoints', { keepLast: 3, timeoutMilliseconds: -1 });
    expect(form.error('retention.checkpoints')).toBe('Enter 0 or more.');
  });

  test('checks a text key against the pattern its schema gives', () => {
    const form = loaded();
    form.set('decisions.fallbackModel', 'no-slash');
    expect(form.error('decisions.fallbackModel')).toBe(
      'That is not in the form this setting takes.',
    );
    form.set('decisions.fallbackModel', 'anthropic/claude-haiku-5-5');
    expect(form.error('decisions.fallbackModel')).toBeUndefined();
  });

  test('turns a switch of false or an object off and on', () => {
    const form = loaded();
    form.setSwitch('tools.humanInput', false);
    expect(form.draft('tools.humanInput')).toBe(false);
    form.setSwitch('tools.humanInput', true);
    expect(form.draft('tools.humanInput')).toEqual({});
    form.setText('tools.humanInput', '{"inputSchemas": {"environment": {"type": "string"}}}');
    form.setSwitch('tools.humanInput', false);
    form.setSwitch('tools.humanInput', true);
    expect(form.draft('tools.humanInput')).toEqual({
      inputSchemas: { environment: { type: 'string' } },
    });
  });

  test('starts a key with no value empty, and does not call it a change', () => {
    const { 'engine.history': _history, ...values } = SETTING_VALUES;
    const form = loaded([], values);
    expect(form.text('engine.history')).toBe('');
    expect(form.isDirty('engine.history')).toBe(false);
    form.setText('engine.history', '{"maxEvents": 5}');
    expect(form.patch()).toEqual({ 'engine.history': { maxEvents: 5 } });
  });

  test('puts every key back when discarded', () => {
    const form = loaded();
    form.set('durable', false);
    form.setText('modelPolicy', 'nope');
    form.discard();
    expect(form.dirtyKeys).toEqual([]);
    expect(form.text('modelPolicy')).toContain('policyRevision');
  });
});

describe('a draft’s problem', () => {
  test('is none for a toggle and a JSON editor holding anything', () => {
    expect(problemWith({ kind: 'toggle' }, true, true)).toBeUndefined();
    expect(problemWith({ kind: 'json' }, { a: 1 }, true)).toBeUndefined();
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
