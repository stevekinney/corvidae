/**
 * COR-1559 — `bureau.contexts.get` reports the latest admitted `model` override in the session's
 * desired state (`null` before any: the agent's default) and its `configVersion`, the version a
 * later command's `expectedRevision` is compared against.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import { noopTool, OPUS_5, OPUS_5_5 } from '../../testing/model-override.test-support.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
} from './management-fixtures.test-support.ts';

const picker = createAgent({
  name: 'picker',
  generate: parkingUntilAborted,
  tools: { noop: noopTool },
  allowedCandidates: [OPUS_5_5, OPUS_5],
});

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({ agents: { picker } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

async function liveSession(opened: OpenedBureau) {
  const run = await opened.bureau.tasks.start('picker', 'work', { principal: OWNER.alice });
  await waitForCondition(
    () => opened.bureau.tasks.detail(run.id)?.status === 'running',
    'run started',
  );
  return run;
}

const getContext = (opened: OpenedBureau, contextId: string) =>
  rpc(opened.handler, 'bureau.contexts.get', { contextId }, 'alice-key');

describe('bureau.contexts.get model and configVersion', () => {
  it('reports no model and version 0 before any steering', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      const body = await getContext(opened, run.contextId);

      expect(body.result).toMatchObject({ model: null, configVersion: 0 });
    });
  });

  it('reports the latest admitted model override, with its provider, and the version', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      await rpc(
        opened.handler,
        'bureau.contexts.steer',
        { contextId: run.contextId, commandId: 'first', override: OPUS_5 },
        'alice-key',
      );
      await rpc(
        opened.handler,
        'bureau.contexts.steer',
        { contextId: run.contextId, commandId: 'second', override: OPUS_5_5 },
        'alice-key',
      );

      const body = await getContext(opened, run.contextId);

      expect(body.result).toMatchObject({
        model: { provider: 'anthropic', model: 'claude-opus-5-5' },
        configVersion: 2,
      });
    });
  });

  it('does not move for a refused model override', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      await rpc(
        opened.handler,
        'bureau.contexts.steer',
        {
          contextId: run.contextId,
          commandId: 'refused',
          override: { provider: 'openai', model: 'gpt-4.1' },
        },
        'alice-key',
      );

      const body = await getContext(opened, run.contextId);

      expect(body.result).toMatchObject({ model: null, configVersion: 0 });
    });
  });

  it('reports the version expectedRevision is compared against, which an agent change still waiting for the next run advances', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      await opened.bureau.contexts.steer(run.contextId, {
        id: 'identity',
        principal: OWNER.alice,
        requestedValue: { target: 'agent-identity', override: 'picker' },
      });

      const read = await getContext(opened, run.contextId);
      const version = read.result?.['configVersion'] as number;
      const withVersion = await rpc(
        opened.handler,
        'bureau.contexts.steer',
        {
          contextId: run.contextId,
          commandId: 'fenced',
          override: OPUS_5,
          expectedRevision: version,
        },
        'alice-key',
      );

      expect(version).toBe(1);
      expect(withVersion.result).toMatchObject({ outcome: 'accepted' });
    });
  });

  it('keeps the model out of the list rows, which hold summaries only', async () => {
    await withBureau(async (opened) => {
      await liveSession(opened);

      const body = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');

      const rows = (body.result?.['contexts'] ?? []) as Array<Record<string, unknown>>;
      const row = rows[0] ?? {};
      expect(row).not.toHaveProperty('model');
      expect(row).not.toHaveProperty('configVersion');
    });
  });

  it('answers another owner’s context as a missing one', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      const body = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: run.contextId },
        'bob-key',
      );

      expect(body.error?.data).toMatchObject({ weftCode: 'NotFound' });
    });
  });
});
