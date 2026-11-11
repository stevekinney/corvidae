/**
 * The hook editor's draft (COR-1858, COR-2022): what makes it valid, what stops it being saved and
 * where, and the request it makes. The signing secret is no part of the draft: the Bureau makes one
 * and shows it once.
 */
import { describe, expect, test } from 'bun:test';

import type { Hook } from '../../lib/bureau-hooks.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import { EVENTS_MAXIMUM, HookFormState } from './hook-form-state.svelte.ts';

function hook(action: Hook['action'], overrides: Partial<Hook> = {}): Hook {
  return {
    id: 'hook-1',
    owner: 'anonymous:local',
    name: 'Kept',
    action,
    events: ['review.requested'],
    scope: null,
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
  return form;
}

describe('a new webhook hook', () => {
  test('needs an event and an address, and says which is missing, in the order of the steps', () => {
    const form = new HookFormState(true);
    expect(form.isValid).toBe(false);
    expect(form.problems).toEqual([
      { field: 'event', message: HOOKS_COPY.editor.event.required },
      { field: 'url', message: HOOKS_COPY.editor.webhook.urlMissing },
    ]);
    form.events = ['review.requested'];
    expect(form.problems.map((problem) => problem.field)).toEqual(['url']);
    form.url = 'https://example.com/receive';
    expect(form.problems).toEqual([]);
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

  test('says to start an address with https:// unless it is one with a part the Bureau refuses', () => {
    const copy = HOOKS_COPY.editor.webhook;
    const form = webhook();
    form.url = 'events.pagerduty.com';
    expect(form.urlProblem).toBe(copy.urlMissing);
    expect(form.problems).toEqual([{ field: 'url', message: copy.urlMissing }]);
    form.url = 'ftp://example.com';
    expect(form.urlProblem).toBe(copy.urlMissing);
    form.url = 'https://user:pw@example.com';
    expect(form.urlProblem).toBe(copy.urlInvalid);
    form.url = 'https://example.com/#x';
    expect(form.urlProblem).toBe(copy.urlInvalid);
    form.url = '  ';
    expect(form.urlProblem).toBeUndefined();
  });

  test('refuses no event and too many', () => {
    const form = webhook();
    form.events = [];
    expect(form.isValid).toBe(false);
    form.events = Array.from({ length: EVENTS_MAXIMUM + 1 }, (_, index) => `kind.${String(index)}`);
    expect(form.isValid).toBe(false);
  });

  test('sends the trimmed address and only the name that was typed, and no secret', () => {
    const form = webhook();
    expect(form.toInput()).toEqual({
      events: ['review.requested'],
      action: { type: 'webhook', url: 'https://example.com/receive' },
    });
    form.name = '  Tell the receiver ';
    expect(form.toInput()).toMatchObject({ name: 'Tell the receiver' });
  });
});

describe('an existing hook', () => {
  test('loads the hook, and sends nothing for an action it did not change', () => {
    const form = new HookFormState(false);
    const loaded = hook({ type: 'webhook', url: 'https://example.com/a' });
    form.load(loaded);
    expect(form.url).toBe('https://example.com/a');
    expect(form.name).toBe('Kept');
    expect(form.isValid).toBe(true);
    // The action is the hook's own, so it is not sent again.
    expect(form.toChange(loaded)).toEqual({ name: 'Kept' });
  });

  test('sends the action only when it changed, and a rename never carries a workflow', () => {
    const form = new HookFormState(false);
    const loaded = hook({ type: 'start-workflow', workflowId: 'resting', input: 'payload' });
    form.load(loaded);
    form.name = 'Renamed';
    expect(form.toChange(loaded)).not.toHaveProperty('action');
    form.workflowInput = 'event';
    expect(form.toChange(loaded)).toMatchObject({
      action: { type: 'start-workflow', workflowId: 'resting', input: 'event' },
    });

    const webhook = hook({ type: 'webhook', url: 'https://example.com/a' });
    form.load(webhook);
    expect(form.toChange(webhook)).not.toHaveProperty('action');
    form.url = 'https://example.com/b';
    expect(form.toChange(webhook)).toMatchObject({
      action: { type: 'webhook', url: 'https://example.com/b' },
    });
  });

  test('is dirty once anything differs from the hook it was loaded from', () => {
    const form = new HookFormState(false);
    const loaded = hook({ type: 'webhook', url: 'https://example.com/a' });
    form.load(loaded);
    expect(form.dirty).toBe(false);
    form.url = 'https://example.com/b';
    expect(form.dirty).toBe(true);
    form.url = 'https://example.com/a';
    expect(form.dirty).toBe(false);
    form.events = [...form.events, 'goal.failed'];
    expect(form.dirty).toBe(true);
    form.load(loaded);
    expect(form.dirty).toBe(false);
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
    expect(form.problems).toEqual([
      { field: 'workflow', message: HOOKS_COPY.editor.workflow.required },
    ]);
    form.workflowId = 'digest';
    form.workflowInput = 'event';
    expect(form.isValid).toBe(true);
    expect(form.toInput()).toEqual({
      events: ['review.requested'],
      action: { type: 'start-workflow', workflowId: 'digest', input: 'event' },
    });
  });

  test('a notification hook has no fields, keeps a title it holds, and never sends a secret', () => {
    const form = new HookFormState(true);
    form.events = ['review.requested'];
    form.actionType = 'notify';
    expect(form.isValid).toBe(true);
    expect(form.toInput()).toEqual({ events: ['review.requested'], action: { type: 'notify' } });
    form.title = ' Look ';
    expect(form.toInput()).toMatchObject({ action: { type: 'notify', title: 'Look' } });
  });
});

describe('Only for', () => {
  test('goes out with a new hook once a subject is chosen, and not before', () => {
    const form = webhook();
    expect(form.toInput()).not.toHaveProperty('scope');
    form.scopeKind = 'agent';
    expect(form.isValid).toBe(false);
    form.scopeId = 'scout';
    expect(form.isValid).toBe(true);
    expect(form.toInput().scope).toEqual({ kind: 'agent', id: 'scout' });
    expect(form.draftScope).toEqual({ kind: 'agent', id: 'scout' });
  });

  test('loads from a hook, marks a change dirty, and sends the scope only when it changed', () => {
    const scoped = hook({ type: 'notify', title: null }, { scope: { kind: 'agent', id: 'scout' } });
    const form = new HookFormState(false);
    form.load(scoped);
    expect(form.dirty).toBe(false);
    expect(form.toChange(scoped)).not.toHaveProperty('scope');

    form.scopeId = 'writer';
    expect(form.dirty).toBe(true);
    expect(form.toChange(scoped).scope).toEqual({ kind: 'agent', id: 'writer' });

    form.scopeKind = '';
    form.scopeId = '';
    expect(form.toChange(scoped).scope).toBeNull();
  });

  test('leaves a kind this page does not know as it is', () => {
    const scoped = hook({ type: 'notify', title: null }, { scope: { kind: 'team', id: 'blue' } });
    const form = new HookFormState(false);
    form.load(scoped);
    expect(form.toChange(scoped)).not.toHaveProperty('scope');
  });

  test('renames a hook with a kind it does not know without sending its events', () => {
    const scoped = hook({ type: 'notify', title: null }, { scope: { kind: 'team', id: 'blue' } });
    const form = new HookFormState(false);
    form.load(scoped);
    form.name = 'Renamed';
    // The Bureau checks the scope against any events it is sent, and would refuse this rename.
    expect(form.toChange(scoped)).toEqual({ name: 'Renamed' });
    form.events = ['goal.failed'];
    expect(form.toChange(scoped)).toEqual({ name: 'Renamed', events: ['goal.failed'] });
  });
});
