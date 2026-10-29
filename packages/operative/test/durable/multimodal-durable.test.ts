import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { BunSQLiteStorage, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTestToolbox, createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, type MultiModalContent } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { createContextEpochSealer } from '../../src/context-epoch';
import { createCheckpointStore } from '../../src/durable/checkpoint-store';
import { createRunEngine } from '../../src/durable/create-run-engine';
import {
  createDurableActiveRun,
  readDurableRunResult,
  startDurableRunResult,
} from '../../src/durable/index';
import { createRunWorkflow } from '../../src/durable/run-workflow';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  normalizeAgentRunWorkflowResult,
} from '../../src/durable/run-workflow-result';
import { stopWhen } from '../../src/index';
import { InvalidRunResultError, UnsupportedRunResultVersionError } from '../../src/run-envelope';
import { createScriptedMediaAdmitter } from '../../src/testing/generated-media.test-support';
import type { GenerateResponse } from '../../src/types';

afterEach(async () => {
  await yieldToPortableEventLoop();
});

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});
const thinking: MultiModalContent = { type: 'thinking', thinking: 'Check.', signature: 'sig-1' };
const inlineImage: MultiModalContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: 'AAAAUNIQUEBYTES', encoding: 'base64' },
};

function scripted(responses: GenerateResponse[]) {
  let index = 0;
  return async (): Promise<GenerateResponse> => responses[index++]!;
}

async function startEngine() {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  return { storage, checkpointStore, engine };
}

describe('workflow result v3', () => {
  const valid = {
    schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
    runId: 'run-1',
    steps: 1,
    content: 'done',
    parts: [{ type: 'text', text: 'done' }],
    finishReason: 'stop-condition' as const,
  };

  it('round-trips parts and asset references', () => {
    const parts: MultiModalContent[] = [
      thinking,
      { type: 'image', source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 } },
    ];
    expect(normalizeAgentRunWorkflowResult({ ...valid, parts }).parts).toEqual(parts);
  });

  it('fails a version 2 summary with the explicit unsupported-version error', () => {
    const { parts: _parts, ...v2 } = valid;
    expect(() => normalizeAgentRunWorkflowResult({ ...v2, schemaVersion: 2 })).toThrow(
      UnsupportedRunResultVersionError,
    );
  });

  it.each([
    ['a null element', [null]],
    ['a non-object element', ['text']],
    ['an element with an unknown type', [{ type: 'hologram' }]],
    ['a text part without text', [{ type: 'text' }]],
    [
      'an image part carrying inline bytes',
      [
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'inline', data: 'AAAA', encoding: 'base64' },
        },
      ],
    ],
  ])('rejects a current-version summary whose parts hold %s', (_name, parts) => {
    expect(() => normalizeAgentRunWorkflowResult({ ...valid, parts })).toThrow(
      InvalidRunResultError,
    );
  });

  it('rejects a current-version summary without parts', () => {
    const { parts: _parts, ...withoutParts } = valid;
    expect(() => normalizeAgentRunWorkflowResult(withoutParts)).toThrow(InvalidRunResultError);
  });
});

describe('a durable run keeps parts', () => {
  it('keeps every step parts, the run-wide parts and the committed row ids, and survives a read from a fresh engine', async () => {
    const { storage, checkpointStore, engine } = await startEngine();
    const runId = 'multimodal-durable-run';
    try {
      const result = await startDurableRunResult(
        { engine, checkpointStore },
        {
          runId,
          sessionId: runId,
          options: {
            generate: scripted([
              {
                content: '',
                parts: [thinking],
                toolCalls: [
                  { id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } },
                ],
              },
              { content: 'Sunny.', parts: [{ type: 'text', text: 'Sunny.' }], toolCalls: [] },
            ]),
            toolbox: createTestToolbox([weatherTool]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
          },
        },
      );

      const rows = result.conversation.getMessages().filter((m) => m.role === 'assistant');
      expect(result.steps.map((step) => step.parts)).toEqual([
        [thinking],
        [{ type: 'text', text: 'Sunny.' }],
      ]);
      expect(result.steps.map((step) => step.messageId)).toEqual(rows.map((row) => row.id));
      expect(result.parts).toEqual([thinking, { type: 'text', text: 'Sunny.' }]);
      expect(rows[0]?.content).toEqual([thinking]);

      // A fresh engine over the same storage reads the same result back.
      const freshStore = createCheckpointStore(
        textValueStore(storage, { disposeUnderlyingStorage: false }),
      );
      const { engine: fresh } = await createRunEngine({
        storage,
        runWorkflow: createRunWorkflow(freshStore),
        recover: false,
      });
      try {
        const reading = await readDurableRunResult(
          { engine: fresh, checkpointStore: freshStore },
          runId,
          {
            runtime: createDefaultRuntimeServices(),
          },
        );
        expect(reading.status).toBe('completed');
        if (reading.status !== 'completed') return;
        expect(reading.result.parts).toEqual(result.parts);
        expect(reading.result.steps.map((step) => step.messageId)).toEqual(
          result.steps.map((step) => step.messageId),
        );
      } finally {
        fresh[Symbol.dispose]?.();
      }
    } finally {
      engine[Symbol.dispose]?.();
    }
  });

  it('includes an onMaximumSteps replacement row in the run-wide parts after a read-back', async () => {
    const { storage, checkpointStore, engine } = await startEngine();
    const runId = 'multimodal-durable-max-steps';
    try {
      const result = await startDurableRunResult(
        { engine, checkpointStore },
        {
          runId,
          sessionId: runId,
          options: {
            generate: scripted([
              {
                content: 'One.',
                toolCalls: [
                  { id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } },
                ],
              },
            ]),
            toolbox: createTestToolbox([weatherTool]),
            conversation: new Conversation(),
            maximumSteps: 1,
            onMaximumSteps: async () => 'Summary.',
          },
        },
      );
      expect(result.finishReason).toBe('maximum-steps');
      expect(result.parts).toEqual([
        { type: 'text', text: 'One.' },
        { type: 'text', text: 'Summary.' },
      ]);

      const freshStore = createCheckpointStore(
        textValueStore(storage, { disposeUnderlyingStorage: false }),
      );
      const cursor = await freshStore.loadCursor(runId, { strict: true });
      expect(cursor).toMatchObject({
        lastContent: 'Summary.',
        lastParts: [{ type: 'text', text: 'Summary.' }],
        finalRowIsReplacement: true,
      });
    } finally {
      engine[Symbol.dispose]?.();
    }
  });

  it('admits generated media inside the step, so storage only ever holds the managed-asset reference', async () => {
    const { storage, checkpointStore, engine } = await startEngine();
    const admitter = createScriptedMediaAdmitter();
    const runId = 'multimodal-durable-media';
    try {
      const result = await startDurableRunResult(
        { engine, checkpointStore },
        {
          runId,
          sessionId: runId,
          options: {
            generate: scripted([{ content: '', parts: [inlineImage], toolCalls: [] }]),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
            generatedMediaAdmitter: admitter.port,
          },
        },
      );

      expect(result.parts).toMatchObject([
        { type: 'image', source: { kind: 'managed-asset', assetId: 'asset-1' } },
      ]);
      const store = textValueStore(storage, { disposeUnderlyingStorage: false });
      const keys = await store.list('durable-run:');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect((await store.get(key)) ?? '').not.toContain('UNIQUEBYTES');
      }
      expect(admitter.admissions).toHaveLength(1);
    } finally {
      engine[Symbol.dispose]?.();
    }
  });
});

describe('a durable run waits for its generated-media admissions before closed() acknowledges cleanup', () => {
  async function closedAfter(closedOutcome?: {
    status: 'unresolved';
    reason: 'persistence-failed';
  }) {
    const { checkpointStore, engine } = await startEngine();
    const admitter = createScriptedMediaAdmitter(closedOutcome ? { closedOutcome } : {});
    try {
      const activeRun = createDurableActiveRun(
        { engine, checkpointStore },
        {
          runId: `closed-${closedOutcome === undefined ? 'ok' : 'unknown'}`,
          sessionId: 'closed-session',
          options: {
            generate: scripted([{ content: '', parts: [inlineImage], toolCalls: [] }]),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
            generatedMediaAdmitter: admitter.port,
          },
          prompt: 'Draw',
        },
      );
      const result = await activeRun.result;
      return { result, acknowledgement: await activeRun.closed(), admitter };
    } finally {
      engine[Symbol.dispose]?.();
    }
  }

  it('returns completed, never not-required, once every admission has settled', async () => {
    const { result, acknowledgement, admitter } = await closedAfter();
    expect(result.finishReason).toBe('stop-condition');
    expect(acknowledgement).toEqual({ status: 'completed' });
    expect(admitter.admissions[0]?.settlement?.outcome).toBe('available');
  });

  it('returns unresolved with unknown-effect when an admission outcome cannot be confirmed', async () => {
    const { acknowledgement } = await closedAfter({
      status: 'unresolved',
      reason: 'persistence-failed',
    });
    expect(acknowledgement).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
  });
});

describe('a durable run restarted over SQLite keeps its parts (COR-713)', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** Runs to completion on one SQLite-backed engine, closes it, and reads the run back on a second. */
  async function restart(
    runId: string,
    options: Parameters<typeof startDurableRunResult>[1]['options'],
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'corvidae-multimodal-durable-'));
    directories.push(directory);
    const path = join(directory, 'weft.sqlite');

    // Closed explicitly before engine B opens the file; `using` covers a failure before that.
    using storageA = new BunSQLiteStorage(path);
    const storeA = createCheckpointStore(
      textValueStore(storageA, { disposeUnderlyingStorage: false }),
    );
    const { engine: engineA } = await createRunEngine({
      storage: storageA,
      runWorkflow: createRunWorkflow(storeA),
      recover: false,
    });
    const live = await startDurableRunResult(
      { engine: engineA, checkpointStore: storeA },
      { runId, sessionId: runId, options },
    );
    engineA[Symbol.dispose]?.();
    storageA[Symbol.dispose]();

    using storageB = new BunSQLiteStorage(path);
    const storeB = createCheckpointStore(
      textValueStore(storageB, { disposeUnderlyingStorage: false }),
    );
    const { engine: engineB } = await createRunEngine({
      storage: storageB,
      runWorkflow: createRunWorkflow(storeB),
      recover: false,
    });
    try {
      const reading = await readDurableRunResult(
        { engine: engineB, checkpointStore: storeB },
        runId,
        { runtime: createDefaultRuntimeServices() },
      );
      if (reading.status !== 'completed')
        throw new Error(`expected completed, got ${reading.status}`);
      return { live, recovered: reading.result };
    } finally {
      engineB[Symbol.dispose]?.();
    }
  }

  it('keeps every step parts, the run-wide parts and each step row id', async () => {
    const { live, recovered } = await restart('sqlite-parts-run', {
      generate: scripted([
        {
          content: '',
          parts: [thinking],
          toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } }],
        },
        { content: 'Sunny.', parts: [{ type: 'text', text: 'Sunny.' }], toolCalls: [] },
      ]),
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: stopWhen.noToolCalls(),
    });

    expect(recovered.steps.map((step) => step.parts)).toEqual([
      [thinking],
      [{ type: 'text', text: 'Sunny.' }],
    ]);
    expect(recovered.parts).toEqual([thinking, { type: 'text', text: 'Sunny.' }]);
    expect(recovered.steps.map((step) => step.messageId)).toEqual(
      live.steps.map((step) => step.messageId),
    );
    expect(recovered.steps.every((step) => step.messageId !== undefined)).toBe(true);
  });

  it('keeps the context epoch each step ran under (COR-1640)', async () => {
    let next = 0;
    const { live, recovered } = await restart('sqlite-epoch-run', {
      generate: scripted([
        {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } }],
        },
        { content: 'Sunny.', toolCalls: [] },
      ]),
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: stopWhen.noToolCalls(),
      contextEpoch: createContextEpochSealer({ newEpochId: () => `epoch-${++next}` }),
    });

    expect(live.steps.map((step) => step.contextEpochId)).toEqual(['epoch-1', 'epoch-2']);
    expect(recovered.steps.map((step) => step.contextEpochId)).toEqual(['epoch-1', 'epoch-2']);
  });

  it('keeps an onMaximumSteps replacement row in the run-wide parts and its flag in the cursor', async () => {
    const { recovered } = await restart('sqlite-maximum-steps-run', {
      generate: scripted([
        {
          content: 'One.',
          toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } }],
        },
      ]),
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      maximumSteps: 1,
      onMaximumSteps: async () => 'Summary.',
    });

    expect(recovered.finishReason).toBe('maximum-steps');
    expect(recovered.content).toBe('Summary.');
    expect(recovered.parts).toEqual([
      { type: 'text', text: 'One.' },
      { type: 'text', text: 'Summary.' },
    ]);
    expect(recovered.steps.map((step) => step.parts)).toEqual([[{ type: 'text', text: 'One.' }]]);
  });
});
