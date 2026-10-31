/**
 * The hook editor's draft (COR-1858): what makes it valid, the request it makes, and that a signing
 * secret is only ever sent, never loaded back.
 */
import { describe, expect, test } from 'bun:test';

import type { Hook } from '../../lib/bureau-hooks.ts';
import { EVENTS_MAXIMUM, HookFormState } from './hook-form-state.svelte.ts';

const SECRET = 'sixteen-characters-or-more';

function hook(action: Hook['action'], overrides: Partial<Hook> = {}): Hook {
  return {
    id: 'hook-1',
    owner: 'anonymous:local',
    name: 'Kept',
    action,
    events: ['review.requested'],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    revision: 3,
    ...overrides,
  };
}

function webhook(isNew = true): HookFormState {
  const form = new HookFormState(isNew);
  form.events = ['review.requested'];
  form.url = ' https://example.com/receive ';
  form.signingSecret = SECRET;
  return form;
}

describe('a new webhook hook', () => {
  test('needs an event, an address, and a secret', () => {
    const form = new HookFormState(true);
    expect(form.isValid).toBe(false);
    form.events = ['review.requested'];
    form.url = 'https://example.com/receive';
    expect(form.isValid).toBe(false);
    form.signingSecret = SECRET;
    expect(form.isValid).toBe(true);
  });

  test('refuses an address the Bureau would refuse', () => {
    for (const url of [
      'ftp://example.com',
      'not a url',
      'https://user:pw@example.com',
      'https://example.com/#x',
    ]) {
      const form = webhook();
      form.url = url;
      expect(form.urlProblem, url).toBeDefined();
      expect(form.isValid, url).toBe(false);
    }
  });

  test('refuses a secret outside 16 to 256 characters', () => {
    const form = webhook();
    form.signingSecret = 'short';
    expect(form.secretProblem).toBeDefined();
    expect(form.isValid).toBe(false);
    form.signingSecret = 'x'.repeat(257);
    expect(form.secretProblem).toBeDefined();
    form.signingSecret = 'x'.repeat(256);
    expect(form.secretProblem).toBeUndefined();
    expect(form.isValid).toBe(true);
  });

  test('refuses no event and too many', () => {
    const form = webhook();
    form.events = [];
    expect(form.isValid).toBe(false);
    form.events = Array.from({ length: EVENTS_MAXIMUM + 1 }, (_, index) => `kind.${String(index)}`);
    expect(form.isValid).toBe(false);
  });

  test('sends the trimmed address, the secret, and only the name that was typed', () => {
    const form = webhook();
    expect(form.toInput()).toEqual({
      events: ['review.requested'],
      action: { type: 'webhook', url: 'https://example.com/receive' },
      signingSecret: SECRET,
    });
    form.name = '  Tell the receiver ';
    expect(form.toInput()).toMatchObject({ name: 'Tell the receiver' });
  });
});

describe('an existing hook', () => {
  test('loads everything but the secret, and keeps the secret when the field is left empty', () => {
    const form = new HookFormState(false);
    const loaded = hook({ type: 'webhook', url: 'https://example.com/a' });
    form.load(loaded);
    expect(form.url).toBe('https://example.com/a');
    expect(form.name).toBe('Kept');
    expect(form.signingSecret).toBe('');
    expect(form.isValid).toBe(true);
    expect(form.toChange(loaded)).toEqual({
      name: 'Kept',
      events: ['review.requested'],
      action: { type: 'webhook', url: 'https://example.com/a' },
    });
  });

  test('sends a new secret only when one was typed, and drops what was typed once it is loaded again', () => {
    const form = new HookFormState(false);
    const loaded = hook({ type: 'webhook', url: 'https://example.com/a' });
    form.load(loaded);
    form.signingSecret = SECRET;
    expect(form.toChange(loaded)).toMatchObject({ signingSecret: SECRET });
    form.load(loaded);
    expect(form.signingSecret).toBe('');
  });

  test('removes a name that was cleared', () => {
    const form = new HookFormState(false);
    const loaded = hook({ type: 'notify', title: null });
    form.load(loaded);
    form.name = '  ';
    expect(form.toChange(loaded)).toMatchObject({ name: null });
  });

  test('leaves the action of a plugin’s hook alone, and changes its name and events', () => {
    const form = new HookFormState(false);
    const loaded = hook({ type: 'plugin', plugin: 'acme', kind: 'page' });
    form.load(loaded);
    form.events = ['goal.failed'];
    // It has no address or workflow of its own to fill in, and still saves.
    expect(form.isValid).toBe(true);
    expect(form.toChange(loaded)).toEqual({ name: 'Kept', events: ['goal.failed'] });
    form.events = [];
    expect(form.isValid).toBe(false);
  });
});

describe('the other actions', () => {
  test('a workflow hook needs a workflow, and says what the workflow receives', () => {
    const form = new HookFormState(true);
    form.events = ['review.requested'];
    form.actionType = 'start-workflow';
    expect(form.isValid).toBe(false);
    form.workflowId = 'digest';
    form.workflowInput = 'event';
    expect(form.isValid).toBe(true);
    expect(form.toInput()).toEqual({
      events: ['review.requested'],
      action: { type: 'start-workflow', workflowId: 'digest', input: 'event' },
    });
  });

  test('a notification hook sends a title only when one was typed, and never a secret', () => {
    const form = new HookFormState(true);
    form.events = ['review.requested'];
    form.actionType = 'notify';
    form.signingSecret = SECRET;
    expect(form.isValid).toBe(true);
    expect(form.toInput()).toEqual({ events: ['review.requested'], action: { type: 'notify' } });
    form.title = ' Look ';
    expect(form.toInput()).toMatchObject({ action: { type: 'notify', title: 'Look' } });
    form.title = 'x'.repeat(201);
    expect(form.isValid).toBe(false);
  });
});
