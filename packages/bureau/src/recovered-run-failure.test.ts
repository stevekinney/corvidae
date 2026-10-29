import {
  createAgentSession,
  createSessionStore,
  type GenerateFunction,
  stopWhen,
  createAgent,
} from '@lostgradient/operative';
import { textValueStore, MemoryStorage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import { listHeldTasks, waitForCondition } from './test';
import type { AgentDefinitions } from './agent-catalog';

/**
 * COR-1587: a recovered run that fails after replay ends its run record and its session as
 * `error`, whatever the engine's state reads by the time Bureau reattaches it. The reattach is told
 * the run was not failed before replay, because Bureau reattaches only runs whose session is still
 * `running`: a run the recovery resolver failed has had its session reconciled to `error`, so it is
 * never reattached. Left to infer it, the driver reads the engine's `failed` state as a failure
 * before replay, stays write-free, and the session stays `running` for good.
 */

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

describe('a run Bureau recovers after the engine failed it', () => {
  it('settles the run record and the session as error', async () => {
    const storage = new MemoryStorage();
    const runId = 'cor-1587-recovered-run';
    const sessionId = 'cor-1587-recovered-session';
    const sessionStore = createSessionStore(textValueStore(storage));
    await sessionStore.save(
      createAgentSession({
        id: sessionId,
        agentName: 'default',
        conversationHistory: createConversationHistory({ id: sessionId }),
        metadata: { lastRunId: runId, lastRunStatus: 'running' },
      }),
    );

    // The prototype every durable engine shares, read from a throwaway composition so the spies
    // can stand in for what recovery finds.
    const probe = await createRuntimeComposition({
      generate,
      toolbox: createToolbox([]),
      storage: new MemoryStorage(),
      durable: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      recoverAll: () => Promise<unknown[]>;
      get: (id: string) => Promise<unknown>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const input = { runId, sessionId, agentName: 'default' };
    const handle = {
      id: runId,
      getLaunchMetadata: async () => ({ input }),
      result: async () => {
        throw new Error('the activity failed after replay');
      },
    };
    // A recovery that hands the run over without Weft's hook, so Bureau's own pass reattaches it,
    // after the engine has already failed it.
    const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockResolvedValue([handle]);
    const originalGet = enginePrototype.get;
    const getSpy = spyOn(enginePrototype, 'get').mockImplementation(async function (
      this: unknown,
      id: string,
    ) {
      return id === runId ? { id, status: 'failed' } : originalGet.call(this, id);
    });

    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate,
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage,
      durable: true,
      onDiagnostic: () => undefined,
    });
    try {
      await bureau.recovery();
      await waitForCondition(async () => {
        const session = await bureau.contexts.get(sessionId);
        return session?.metadata['lastRunStatus'] !== 'running';
      }, 'the recovered run never settled its session');

      const session = await bureau.contexts.get(sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('error');
      expect(listHeldTasks(bureau).find((run) => run.id === runId)?.status).toBe('error');
    } finally {
      recoverAllSpy.mockRestore();
      getSpy.mockRestore();
      await bureau.dispose();
    }
  });
});
