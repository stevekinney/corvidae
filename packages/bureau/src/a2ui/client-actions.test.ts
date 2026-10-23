import { describe, expect, it } from 'bun:test';

import { parseClientMessage, toActionRequest } from './client-actions';

const action = {
  name: 'confirm',
  surfaceId: 'panel',
  sourceComponentId: 'go',
  context: { note: 'ok' },
};

describe('reading a client message at the boundary', () => {
  it('reads an action, bare or as the one-item array the A2A part carries', () => {
    for (const envelope of [
      { version: 'v0.9.1', action },
      [{ version: 'v0.9', action }],
      { action },
    ]) {
      expect(parseClientMessage(envelope)).toEqual({ ok: true, kind: 'action', action });
    }
  });

  it('reads only name, surfaceId, sourceComponentId, and context', () => {
    const hostile = parseClientMessage({
      action: {
        ...action,
        functionCall: { call: 'openUrl', args: { url: 'https://evil.example' } },
        tool: 'delete-everything',
        authorization: { principal: 'api-key:root' },
        revision: 99,
        taskId: 'someone-elses-task',
        commandId: 'chosen-by-the-attacker',
      },
      authorization: 'root',
    });
    expect(hostile).toEqual({ ok: true, kind: 'action', action });
  });

  it('takes caller, task, revision, and idempotency from the request, not the body', () => {
    const parsed = parseClientMessage({
      action: { ...action, taskId: 'other', revision: 9, commandId: 'x' },
    });
    if (!parsed.ok || parsed.kind !== 'action') throw new Error('expected an action');
    expect(
      toActionRequest(parsed.action, { taskId: 'task-1', commandId: 'cmd-1', revision: 3 }),
    ).toMatchObject({
      type: 'surface.action',
      taskId: 'task-1',
      commandId: 'cmd-1',
      revision: 3,
      surfaceId: 'panel',
      action: 'confirm',
      value: { note: 'ok' },
      sourceComponentId: 'go',
    });
  });

  it('defaults a missing context to an empty object', () => {
    expect(parseClientMessage({ action: { name: 'a', surfaceId: 's' } })).toMatchObject({
      action: { context: {} },
    });
  });

  it('refuses malformed envelopes and fields', () => {
    const refused = [
      null,
      'x',
      [],
      [{ action }, { action }],
      {},
      { action, error: {} },
      { version: 'v0.8', action },
      { action: null },
      { action: { ...action, name: '' } },
      { action: { ...action, name: 'n'.repeat(129) } },
      { action: { ...action, surfaceId: 7 } },
      { action: { ...action, sourceComponentId: 7 } },
      { action: { ...action, context: [] } },
      { action: { ...action, context: { n: Number.NaN } } },
      { action: { ...action, context: { big: 'x'.repeat(300_000) } } },
    ];
    for (const envelope of refused) expect(parseClientMessage(envelope).ok).toBe(false);
  });

  it('reads a client error as a report, never a command', () => {
    expect(
      parseClientMessage({
        error: { code: 'VALIDATION_FAILED', surfaceId: 'panel', message: 'bad' },
      }),
    ).toEqual({
      ok: true,
      kind: 'error',
      error: { code: 'VALIDATION_FAILED', surfaceId: 'panel', message: 'bad' },
    });
    expect(parseClientMessage({ error: 'x' }).ok).toBe(false);
  });
});
