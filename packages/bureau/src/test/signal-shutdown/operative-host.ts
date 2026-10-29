/**
 * COR-1439 — a long-lived process hosting a durable Operative run.
 *
 * `start` runs a durable agent that commits step 0 and then waits inside the
 * step-1 model call, announces `ready`, and on SIGINT or SIGTERM calls
 * `run.abort()` and awaits `run.closed()` through the reference handler.
 * `inspect` is the next process: it opens the same store without recovering
 * anything and records how the run ended.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createActiveRun,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  readDurableRunResult,
  stopWhen,
} from '@lostgradient/operative';
import { textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { announce, fail, openFileStorage, parseHostArguments, writeMarker } from './host-support';
import { handleShutdownSignals } from './shutdown-handler';

const RUN_ID = 'signal-shutdown-operative';

const { mode, directory } = parseHostArguments(['start', 'inspect']);
const storage = await openFileStorage(directory);
const checkpointStore = createCheckpointStore(
  textValueStore(storage, { disposeUnderlyingStorage: false }),
);
const { engine } = await createRunEngine({
  storage,
  runWorkflow: createRunWorkflow(checkpointStore),
  recover: false,
});

if (mode === 'inspect') {
  const reading = await readDurableRunResult({ engine, checkpointStore }, RUN_ID, {
    runtime: createDefaultRuntimeServices(),
  });
  if (reading.status !== 'ended') fail(`expected an ended run, read ${reading.status}`);
  writeMarker(directory, 'operative-inspected', {
    workflowStatus: reading.workflowStatus,
    finishReason: reading.finishReason,
    completedSteps: reading.result.steps.length,
  });
  await engine.shutdown();
  storage[Symbol.dispose]();
  process.exit(0);
}

const stepOneReached = Promise.withResolvers<void>();
const run = createActiveRun(
  {
    generate: async ({ step, signal }) => {
      if (step === 0) return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      stepOneReached.resolve();
      // Honors cancellation the way a provider call does: it rejects on abort.
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted during generate')), {
          once: true,
        });
      });
    },
    toolbox: createToolbox([
      createTool({
        name: 'next',
        description: 'continue',
        input: z.object({}),
        execute: async () => 'ok',
      }),
    ]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  },
  { engine, checkpointStore, runId: RUN_ID, prompt: 'Run until the host stops.' },
);

handleShutdownSignals({
  shutdown: async (signal) => {
    run.abort(`received ${signal}`);
    const cleanup = await run.closed();
    const result = await run.result;
    writeMarker(directory, 'operative-shutdown', {
      cleanup: cleanup.status,
      finishReason: result.finishReason,
    });
    await engine.shutdown();
    storage[Symbol.dispose]();
    return cleanup.status === 'completed';
  },
});

await run.durablyStarted;
await stepOneReached.promise;
announce('ready', { storage: storage.constructor.name });
