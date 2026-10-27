import { HttpClientError } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  getSettings,
  getSettingsSchema,
  settingsFaultOf,
  updateSettings,
} from './bureau-settings.ts';
import { installBureauStub, StubFault, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('the settings the Bureau shows', () => {
  test('are read with their revision and how each key stands', async () => {
    stub = installBureauStub({
      'bureau.settings.get': () => ({
        values: { 'tools.wakeup': true },
        revision: 4,
        persisted: true,
        keys: { 'tools.wakeup': { apply: 'live', locked: false, pendingRestart: false } },
      }),
    });

    expect(await getSettings()).toEqual({
      values: { 'tools.wakeup': true },
      revision: 4,
      persisted: true,
      keys: { 'tools.wakeup': { apply: 'live', locked: false, pendingRestart: false } },
    });
  });

  test('are refused when the answer is not a snapshot', async () => {
    stub = installBureauStub({ 'bureau.settings.get': () => ({ values: {}, revision: -1 }) });
    await expect(getSettings()).rejects.toThrow();
  });

  test('come with a schema, one node for each key', async () => {
    stub = installBureauStub({
      'bureau.settings.schema': () => ({
        schema: {
          type: 'object',
          properties: {
            'tools.wakeup': { type: 'boolean', description: 'Offered `scheduleWakeup`.' },
            'retention.audit': {
              anyOf: [{ type: 'string', const: 'forever' }, { type: 'object' }],
            },
          },
        },
      }),
    });

    const schema = await getSettingsSchema();
    expect(Object.keys(schema)).toEqual(['tools.wakeup', 'retention.audit']);
    expect(schema['retention.audit']?.anyOf).toHaveLength(2);
  });
});

describe('an update', () => {
  test('sends the patch and the revision it was written against', async () => {
    stub = installBureauStub({
      'bureau.settings.update': () => ({ revision: 5, pendingRestart: ['durable'] }),
    });

    expect(await updateSettings({ durable: false }, 4)).toEqual({
      revision: 5,
      pendingRestart: ['durable'],
    });
    expect(stub.callsTo('bureau.settings.update')[0]?.params).toEqual({
      patch: { durable: false },
      expectedRevision: 4,
    });
  });
});

describe('a refused update', () => {
  async function refusal(fault: StubFault): Promise<unknown> {
    stub?.restore();
    stub = installBureauStub({
      'bureau.settings.update': () => {
        throw fault;
      },
    });
    try {
      await updateSettings({ durable: false }, 4);
    } catch (error) {
      return settingsFaultOf(error);
    }
    throw new Error('The update was not refused.');
  }

  test('is stale when the revision moved, and says what it is now', async () => {
    expect(
      await refusal(new StubFault('StaleRevision', 409, 'moved', { currentRevision: 9 })),
    ).toEqual({ kind: 'stale', currentRevision: 9 });
    expect(await refusal(new StubFault('StaleRevision', 409, 'moved', {}))).toEqual({
      kind: 'stale',
      currentRevision: null,
    });
  });

  test('is locked when the deployment holds a key, which is told apart from any other unprocessable answer', async () => {
    expect(
      await refusal(new StubFault('Unprocessable', 422, 'Locked: durable.', { reason: 'locked' })),
    ).toEqual({ kind: 'locked', message: 'Locked: durable.' });
    expect(await refusal(new StubFault('Unprocessable', 422, 'No.', { reason: 'other' }))).toEqual({
      kind: 'rejected',
      message: 'No.',
    });
  });

  test('is rejected for an invalid value, naming the key the Bureau names', async () => {
    expect(
      await refusal(
        new StubFault('InvalidParams', 400, 'invalid params', {
          issues: [
            { path: ['patch', 'engine.history'], message: 'Expected an object.' },
            { path: ['patch'], message: 'Empty.' },
          ],
        }),
      ),
    ).toEqual({ kind: 'rejected', message: 'engine.history: Expected an object.; Empty.' });
    expect(await refusal(new StubFault('InvalidParams', 400, 'invalid params'))).toEqual({
      kind: 'rejected',
      message: 'invalid params',
    });
  });

  test('is forbidden for a caller without the write scope, and other for anything else', async () => {
    expect(await refusal(new StubFault('Forbidden', 403, 'No.'))).toEqual({ kind: 'forbidden' });
    expect(await refusal(new StubFault('Internal', 500, 'Broke.'))).toEqual({
      kind: 'other',
      message: 'Broke.',
    });
    expect(settingsFaultOf(new Error('offline'))).toEqual({ kind: 'other', message: 'offline' });
    expect(settingsFaultOf(new HttpClientError(500, 'x'))).toEqual({
      kind: 'other',
      message: 'x',
    });
  });
});
