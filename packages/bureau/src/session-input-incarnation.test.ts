import { createAgent, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { deferred } from './test/session-input-fixtures';
import { startTaskFrom } from './test/task-start-request.ts';

/**
 * COR-1661 — an input names the incarnation of the session it was checked against. A context
 * deleted and created again under the same id is a new incarnation, and input checked against the
 * earlier one is refused as input to a session that is not there, never admitted to the new one.
 */

async function withLiveSession(
  body: (
    context: { sessionId: string; incarnation: string },
    bureau: Awaited<ReturnType<typeof open>>,
  ) => Promise<void>,
): Promise<void> {
  const started = deferred();
  const release = deferred();
  const bureau = await open(async () => {
    started.resolve();
    await release.promise;
    return { content: 'answer', toolCalls: [] };
  });
  try {
    const run = await startTaskFrom(bureau, {
      agentName: 'default',
      input: 'First',
      principal: 'alice',
    });
    await started.promise;
    const session = await bureau.contexts.get(run.contextId);
    await body({ sessionId: run.contextId, incarnation: session?.incarnation ?? '' }, bureau);
  } finally {
    release.resolve();
    await bureau.dispose();
  }
}

async function open(generate: () => Promise<{ content: string; toolCalls: never[] }>) {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: { type: 'memory' },
    durable: true,
  });
}

const input = { principal: 'alice', deliveryMode: 'queue' as const, payload: 'more' };

describe('submitSessionInput naming an incarnation', () => {
  it('admits input to the incarnation it names', async () => {
    await withLiveSession(async ({ sessionId, incarnation }, bureau) => {
      const outcome = await bureau.contexts.input(sessionId, {
        ...input,
        id: 'input-named',
        incarnation,
      });

      expect(outcome.outcome).toBe('admitted');
    });
  });

  it('refuses input checked against another incarnation, as input to a session that is not there', async () => {
    await withLiveSession(async ({ sessionId }, bureau) => {
      const outcome = await bureau.contexts.input(sessionId, {
        ...input,
        id: 'input-stale',
        incarnation: 'an-earlier-incarnation',
      });

      expect(outcome).toEqual({ outcome: 'not-found' });
    });
  });
});
