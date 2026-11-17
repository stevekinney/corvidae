/**
 * COR-2111 — `bureau.validators.list` over a real Bureau: a validator the host gave the Bureau
 * reports the `bureau` source at Bureau's own version, a plugin's validator reports its plugin's
 * name and version, and a plugin that is disabled when the Bureau starts contributes nothing.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import type { Validator } from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BUREAU_VERSION } from '../../bureau-version.ts';
import { BUREAU_PLUGIN_NAME } from '../../plugins/bureau-plugin.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { OPERATION_MAP } from '../operation-map.ts';
import { guardrailsListOperation } from './guardrails-operations.ts';
import { openBureau, type OpenedBureau, rpc } from './management-fixtures.test-support.ts';
import { validatorsListOperation } from './validators-operations.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const validator = (
  name: string,
  version: string,
  determinism?: 'deterministic' | 'stochastic',
): Validator => ({
  identity: { name, version },
  ...(determinism === undefined ? {} : { determinism }),
  validate: () => ({ kind: 'pass', evidence: [] }),
});

const checks = definePlugin({
  name: 'checks',
  version: '2.3.4',
  description: 'Contributes a validator.',
  setup: () => ({ validators: [validator('tidy', '1', 'deterministic')] }),
});

async function open(enabled: boolean, storage?: Storage): Promise<OpenedBureau> {
  const opened = await openBureau({
    ...(storage === undefined ? {} : { storage }),
    validators: [validator('host-check', '7', 'stochastic'), validator('plain', '1')],
    bureauOptions: {
      plugins: [{ descriptor: checks, source: 'package', location: '@example/checks' }],
      pluginConfiguration: { checks: { enabled } },
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

async function list(opened: OpenedBureau): Promise<Array<Record<string, unknown>>> {
  const body = await rpc(opened.handler, 'bureau.validators.list', {}, 'alice-key');
  expect(body.error).toBeUndefined();
  return body.result!['validators'] as Array<Record<string, unknown>>;
}

describe('bureau.validators.list', () => {
  it('is served, read-only, and open to any caller that can create a goal', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(validatorsListOperation);
    expect(validatorsListOperation.destructive).toBe(false);
    expect(validatorsListOperation.access).toEqual({ kind: 'authenticated' });
    expect(validatorsListOperation.access).toEqual(guardrailsListOperation.access);
    expect(OPERATION_MAP['bureau.validators.list']).toEqual({
      workspaceClass: 'member-shared-read',
      member: 'goals.validators',
    });
    expect(validatorsListOperation.description?.length ?? 0).toBeGreaterThan(40);
  });

  it('reports a Bureau validator under the bureau source and a plugin’s under its plugin', async () => {
    const rows = await list(await open(true));

    expect(rows).toEqual([
      {
        name: 'host-check',
        version: '7',
        determinism: 'stochastic',
        configuration: null,
        source: { kind: 'bureau', name: BUREAU_PLUGIN_NAME, version: BUREAU_VERSION },
      },
      {
        name: 'plain',
        version: '1',
        determinism: null,
        configuration: null,
        source: { kind: 'bureau', name: BUREAU_PLUGIN_NAME, version: BUREAU_VERSION },
      },
      {
        name: 'checks:tidy',
        version: '1',
        determinism: 'deterministic',
        configuration: null,
        source: { kind: 'plugin', name: 'checks', version: '2.3.4' },
      },
    ]);
  });

  it('lists the configuration schema of a validator that takes one, and null for one that takes none (COR-2117)', async () => {
    const opened = await openBureau({
      validators: [
        {
          ...validator('contains-phrase', '1', 'deterministic'),
          configuration: z.strictObject({ phrase: z.string().min(1) }),
        },
        validator('plain', '1'),
      ],
    });
    cleanups.push(() => opened.dispose());

    const rows = await list(opened);

    expect(rows.map((row) => row['name'])).toEqual(['contains-phrase', 'plain']);
    expect(rows[0]!['configuration']).toMatchObject({
      type: 'object',
      properties: { phrase: { type: 'string' } },
      required: ['phrase'],
    });
    expect(rows[1]!['configuration']).toBeNull();
  });

  it('leaves out the validators of a plugin that is disabled when the Bureau starts', async () => {
    const rows = await list(await open(false));

    expect(rows.map(({ name }) => name)).toEqual(['host-check', 'plain']);
  });

  it('drops a plugin’s validators after a restart over the same storage with the plugin disabled', async () => {
    const storage = new MemoryStorage();
    const first = await open(true, storage);
    const before = await list(first);
    expect(before.map(({ name }) => name)).toContain('checks:tidy');
    await first.dispose();

    const restarted = await open(false, storage);

    const after = await list(restarted);
    expect(after.map(({ name }) => name)).toEqual(['host-check', 'plain']);
  });

  it('refuses a request with no credential', async () => {
    const opened = await open(true);
    const body = await rpc(opened.handler, 'bureau.validators.list', {}, 'no-such-key');
    expect(body.error).toBeDefined();
  });
});
