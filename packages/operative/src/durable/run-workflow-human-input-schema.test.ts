/**
 * COR-1684 — a configured human-input schema is for the form a client renders, so the tool result
 * the model reads leaves it out, while the step record the checkpoint commits keeps it (a restarted
 * run rebuilds the wait from there).
 */
import {
  Engine,
  MemoryStorage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { noToolCalls } from '../conditions/predicates';
import { createRequestHumanInputTool } from '../create-request-human-input-tool';
import type { HumanInputSchema } from '../human-input-schema';
import { humanWaitParks } from '../human-wait-parks';
import type { GenerateContext } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

const formSchema: HumanInputSchema = {
  type: 'object',
  properties: { environment: { type: 'string', enum: ['staging', 'production'] } },
  required: ['environment'],
  title: 'schema-marker-title',
};

type RegistryToolbox = NonNullable<DurableRunDeps['toolbox']>;

describe('the model-facing requestHumanInput result', () => {
  it('leaves the input schema out of what the model reads and keeps it in the step record', async () => {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const activities = createStorageActivities(checkpointStore);
    const engine = await Engine.create({
      storage,
      recover: false,
      workflows: { agentRun: createRunWorkflow(checkpointStore) },
      activities: {
        saveCursor: activities.saveCursor,
        saveConversation: activities.saveConversation,
        recordStep: activities.recordStep,
      },
    });

    // The real tool, wired to the run's deps the way the durable opt-in wires it.
    const container: { ref: DurableRunDeps | undefined } = { ref: undefined };
    const tool = createRequestHumanInputTool({
      context: {
        get pendingHumanWait() {
          return container.ref?.pendingHumanWait;
        },
        set pendingHumanWait(value) {
          if (container.ref) container.ref.pendingHumanWait = value;
        },
        get pendingWakeup() {
          return container.ref?.pendingWakeup;
        },
        set pendingWakeup(value) {
          if (container.ref) container.ref.pendingWakeup = value;
        },
        runId: 'schema-run',
        durable: true,
      },
      inputSchemas: { deploy: formSchema },
    });
    const toolbox = createToolbox([tool] as unknown as Parameters<
      typeof createToolbox
    >[0]) as unknown as RegistryToolbox;

    const seenByModel: string[] = [];
    let calls = 0;
    const services: DurableRunDeps = {
      options: {
        generate: async (context: GenerateContext) => {
          calls += 1;
          if (calls === 1) {
            return {
              content: '',
              toolCalls: [
                {
                  name: 'requestHumanInput',
                  arguments: { signalName: 'deploy', prompt: 'Where to?' },
                },
              ],
            };
          }
          seenByModel.push(JSON.stringify(context.conversation.current));
          return { content: 'done', toolCalls: [] };
        },
        toolbox,
        conversation: createConversationHistory(),
        stopWhen: noToolCalls(),
        maximumSteps: 5,
      },
      toolbox,
    };
    container.ref = services;

    try {
      const handle = await engine.start(
        'agentRun',
        { runId: 'schema-run', sessionId: 'schema-run', agentName: 'asker', prompt: 'start' },
        { id: 'schema-run', services },
      );
      for (let attempt = 0; attempt < 50; attempt++) {
        if (container.ref.pendingHumanWait !== undefined) break;
        await yieldToPortableEventLoop();
      }
      expect(container.ref.pendingHumanWait?.inputSchema).toEqual(formSchema);

      await engine.signal('schema-run', 'deploy', { environment: 'staging' });
      await handle.result();

      // What the model read on the step after the park: the prompt, never the schema.
      expect(seenByModel).toHaveLength(1);
      expect(seenByModel[0]).toContain('Where to?');
      expect(seenByModel[0]).not.toContain('inputSchema');
      expect(seenByModel[0]).not.toContain('schema-marker-title');

      // The conversation the checkpoint holds is the model's, so it leaves the schema out too.
      const checkpoint = await checkpointStore.loadCheckpoint('schema-run');
      const stored = JSON.stringify(Conversation.from(checkpoint.conversation!).getMessages());
      expect(stored).not.toContain('schema-marker-title');

      // The step record keeps the park, schema included: a restart rebuilds the wait from it.
      const parks = checkpoint.steps.flatMap((step) => humanWaitParks(step.results));
      expect(parks).toEqual([
        { signalName: 'deploy', prompt: 'Where to?', inputSchema: formSchema },
      ]);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
