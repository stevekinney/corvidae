/**
 * COR-1806 — what the AG-UI stream says besides text and tool calls: the model's reasoning, which
 * only the run's owner is sent and only as it happens, and one `CUSTOM` announcement each for a
 * memory record written, a wakeup scheduled, and a child run started and settled.
 */
import { EventType, type Event } from '@ag-ui/core';
import {
  createAgent,
  createOutputPIIValidator,
  createScriptedGenerate,
  stopWhen,
  type ScriptedGenerateStep,
  type Toolbox,
  waitForCondition,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createMemoryAssetStorage } from '../assets/storage';
import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau.ts';
import {
  as,
  attachRunRequest,
  authentication,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import {
  bureauMetadata,
  FrameReader,
  type ReceivedFrame,
  typesOf,
} from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { isReasoningEvent } from './ag-ui-vocabulary.ts';

async function withHarness<T>(
  options: Parameters<typeof openHarness>[0],
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

const reasoned = (thinking: string, content: string, extra: Record<string, unknown> = {}) => ({
  kind: 'respond' as const,
  response: {
    content,
    toolCalls: [],
    parts: [
      { type: 'thinking' as const, thinking, signature: 'private-signature' },
      { type: 'text' as const, text: content },
    ],
    ...extra,
  },
});

const reasoningOf = (frames: ReadonlyArray<ReceivedFrame>) =>
  frames.filter((frame) => isReasoningEvent(frame.event));

const customs = (frames: ReadonlyArray<ReceivedFrame>, name: string): Event[] =>
  frames.flatMap((frame) =>
    frame.event.type === EventType.CUSTOM && frame.event.name === name ? [frame.event] : [],
  );

describe('reasoning', () => {
  it('reaches the owner of a run that starts it, before the text, and no thought reaches the thread', async () => {
    await withHarness(
      { script: [reasoned('weigh the options', 'Pick the first.')] },
      async ({ handler }) => {
        const frames = await new FrameReader(await handler(startRequest(runAgentInput()))).rest();

        const kinds = typesOf(frames);
        const reasoning = reasoningOf(frames);
        expect(reasoning.map((frame) => frame.event.type)).toEqual([
          EventType.REASONING_START,
          EventType.REASONING_MESSAGE_START,
          EventType.REASONING_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_END,
          EventType.REASONING_END,
        ]);
        expect(reasoning[2]!.event).toMatchObject({ delta: 'weigh the options' });
        expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(
          kinds.indexOf(EventType.TEXT_MESSAGE_START),
        );
        // Live, never durable, and the signature is not on the wire.
        expect(reasoning.every((frame) => bureauMetadata(frame.event)['durable'] === false)).toBe(
          true,
        );
        expect(JSON.stringify(frames)).not.toContain('private-signature');
        expect(kinds.at(-1)).toBe(EventType.RUN_FINISHED);
      },
    );
  });

  it('is sent to the owner and to no other principal who attaches to the same run', async () => {
    await withHarness(
      {
        authentication,
        script: [{ kind: 'block', barrier: 'hold' }, reasoned('private thought', 'Done.')],
      },
      async ({ handler, generate }) => {
        const starter = new FrameReader(
          await handler(startRequest(runAgentInput(), as('alice-key'))),
        );
        await starter.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const runId = String(bureauMetadata(starter.received[0]!.event)['runId']);
        const operator = new FrameReader(await handler(attachRunRequest(runId, as('reader-key'))));
        const owner = new FrameReader(await handler(attachRunRequest(runId, as('alice-key'))));
        await operator.until(EventType.STATE_SNAPSHOT);
        await owner.until(EventType.STATE_SNAPSHOT);

        generate.release('hold');
        const operatorFrames = [...operator.received, ...(await operator.rest())];
        const ownerFrames = [...owner.received, ...(await owner.rest())];
        const starterFrames = [...starter.received, ...(await starter.rest())];

        expect(reasoningOf(operatorFrames)).toEqual([]);
        expect(JSON.stringify(operatorFrames)).not.toContain('private thought');
        // The operator still sees the run: its text arrived.
        expect(typesOf(operatorFrames)).toContain(EventType.TEXT_MESSAGE_CONTENT);
        expect(reasoningOf(ownerFrames)).toHaveLength(5);
        expect(reasoningOf(starterFrames)).toHaveLength(5);
      },
    );
  });

  it('is not read back out of the history of a run that has ended, when its start is retried', async () => {
    await withHarness(
      { script: [reasoned('a thought for one reader', 'The answer.')] },
      async ({ handler }) => {
        const first = await new FrameReader(await handler(startRequest(runAgentInput()))).rest();
        const again = await new FrameReader(await handler(startRequest(runAgentInput()))).rest();

        expect(reasoningOf(first)).toHaveLength(5);
        expect(typesOf(again)).toContain(EventType.TEXT_MESSAGE_CONTENT);
        expect(reasoningOf(again)).toEqual([]);
        expect(JSON.stringify(again)).not.toContain('a thought for one reader');
      },
    );
  });

  it('is not replayed to an owner who attaches after it was sent, nor held by a snapshot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = createTool({
      name: 'wait-for-gate',
      description: 'waits',
      input: z.object({}),
      async execute() {
        await gate;
        return 'done';
      },
    });
    await withHarness(
      {
        script: [
          reasoned('earlier thought', '', {
            toolCalls: [{ id: 'call-1', name: 'wait-for-gate', arguments: {} }],
          }),
          reasoned('later thought', 'All done.'),
        ],
        toolbox: createToolbox([tool]) as unknown as Toolbox,
      },
      async ({ handler, bureau }) => {
        const starter = new FrameReader(await handler(startRequest(runAgentInput())));
        await starter.until(EventType.TOOL_CALL_START);
        const runId = String(bureauMetadata(starter.received[0]!.event)['runId']);
        // The first step's reasoning was sent before this stream attached.
        expect(reasoningOf(starter.received)).toHaveLength(5);

        const late = new FrameReader(await handler(attachRunRequest(runId)));
        await late.until(EventType.STATE_SNAPSHOT);
        await waitForCondition(
          () => bureau.tasks.detail(runId)?.events.some((e) => e.event === 'tools.executing'),
          'the tool did not start',
        );
        release();
        const lateFrames = [...late.received, ...(await late.rest())];

        const snapshots = lateFrames.filter(
          (frame) => frame.event.type === EventType.MESSAGES_SNAPSHOT,
        );
        expect(snapshots.length).toBeGreaterThan(0);
        expect(JSON.stringify(snapshots)).not.toContain('earlier thought');
        // Nothing from the step it attached during, and the reasoning that happened after it
        // attached is a live event it is sent.
        expect(JSON.stringify(lateFrames)).not.toContain('earlier thought');
        const delivered = reasoningOf(lateFrames).filter(
          (frame) => frame.event.type === EventType.REASONING_MESSAGE_CONTENT,
        );
        expect(delivered.map((frame) => (frame.event as { delta: string }).delta)).toEqual([
          'later thought',
        ]);
        await starter.rest();
      },
    );
  });
});

describe('a validate-mode agent (guardrails that scan the output)', () => {
  const PII = 'jane.doe@example.com';
  const validating = {
    mode: 'validate',
    output: { validators: [createOutputPIIValidator()], action: 'redact' },
  } as const;

  it('streams no frame that carries the PII of a response its guardrail redacted', async () => {
    await withHarness(
      {
        guardrails: validating,
        script: [reasoned(`her address is ${PII}`, `Write to ${PII} today.`)],
      },
      async ({ handler }) => {
        const frames = await new FrameReader(await handler(startRequest(runAgentInput()))).rest();

        expect(JSON.stringify(frames)).not.toContain(PII);
        // The redaction replaced the whole response, thinking included, before anything was projected.
        expect(reasoningOf(frames)).toEqual([]);
        expect(JSON.stringify(frames)).toContain('[EMAIL_REDACTED]');
        expect(typesOf(frames).at(-1)).toBe(EventType.RUN_FINISHED);
      },
    );
  });

  it('streams none under the default guardrails, which halt the run on the PII', async () => {
    await withHarness(
      { script: [reasoned(`her address is ${PII}`, `Write to ${PII} today.`)] },
      async ({ handler }) => {
        const frames = await new FrameReader(await handler(startRequest(runAgentInput()))).rest();

        expect(JSON.stringify(frames)).not.toContain(PII);
        expect(reasoningOf(frames)).toEqual([]);
        expect(typesOf(frames).at(-1)).toBe(EventType.RUN_ERROR);
      },
    );
  });

  it('still streams the reasoning of a response the guardrail passed', async () => {
    await withHarness(
      { guardrails: validating, script: [reasoned('a clean thought', 'A clean answer.')] },
      async ({ handler }) => {
        const frames = await new FrameReader(await handler(startRequest(runAgentInput()))).rest();
        expect(reasoningOf(frames)).toHaveLength(5);
      },
    );
  });
});

describe('bureau.memory-written', () => {
  it('follows a memory_store call that stored a record, naming it, its collection and class', async () => {
    const memoryStore = createTool({
      name: 'memory_store',
      description: 'Store information in memory for later recall',
      input: z.object({ content: z.string() }),
      async execute() {
        return { stored: true, id: 'record-1', collection: 'assistant', memoryClass: 'episodic' };
      },
    });
    await withHarness(
      {
        toolbox: createToolbox([memoryStore]) as unknown as Toolbox,
        script: [
          {
            kind: 'respond',
            response: {
              content: '',
              toolCalls: [{ id: 'call-1', name: 'memory_store', arguments: { content: 'x' } }],
            },
          },
          { kind: 'respond', response: { content: 'Remembered.', toolCalls: [] } },
        ],
      },
      async ({ handler }) => {
        const frames = await new FrameReader(await handler(startRequest(runAgentInput()))).rest();

        const [announced, ...rest] = customs(frames, 'bureau.memory-written');
        expect(rest).toEqual([]);
        const runId = String(bureauMetadata(frames[0]!.event)['runId']);
        expect(announced).toMatchObject({
          value: {
            messageId: `${runId}:step:0`,
            recordId: 'record-1',
            collection: 'assistant',
            class: 'episodic',
            runId,
            sessionId: 'thread-1',
          },
        });
        const kinds = typesOf(frames);
        expect(kinds.indexOf(EventType.TOOL_CALL_RESULT)).toBeLessThan(
          kinds.indexOf(EventType.CUSTOM),
        );
      },
    );
  });
});

describe('bureau.wakeup-scheduled', () => {
  it('announces a scheduleWakeup call the run made, with the time it is due', async () => {
    const before = Date.now();
    await withHarness(
      {
        stopWhen: stopWhen.noToolCalls(),
        script: [
          {
            kind: 'respond',
            response: {
              content: '',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'scheduleWakeup',
                  arguments: { in: '1h', note: 'check the deploy' },
                },
              ],
            },
          },
          { kind: 'respond', response: { content: 'I will check back.', toolCalls: [] } },
        ],
      },
      async ({ handler }) => {
        const stream = new FrameReader(await handler(startRequest(runAgentInput())));
        const read = await stream.until(EventType.RUN_STARTED);
        const runId = String(bureauMetadata(read[0]!.event)['runId']);
        let frames: ReceivedFrame[] = read;
        while (customs(frames, 'bureau.wakeup-scheduled').length === 0) {
          const next = await stream.next();
          if (next === undefined) break;
          frames = [...frames, next];
        }

        const [announced, ...rest] = customs(frames, 'bureau.wakeup-scheduled');
        expect(rest).toEqual([]);
        expect(announced).toMatchObject({
          value: { runId, duration: '1h', note: 'check the deploy' },
        });
        const { wakeAt } = (announced as { value: { wakeAt: number } }).value;
        // Due an hour after the request was accepted, which was not before the test began.
        expect(wakeAt).toBeGreaterThanOrEqual(before + 3_600_000);
        await stream.cancel();
      },
    );
  });
});

describe('bureau.child-run-started and bureau.child-run-settled', () => {
  it('announce a child of the topology on its parent’s stream, once each', async () => {
    const script = createScriptedGenerate([
      { kind: 'block', barrier: 'hold' },
      { kind: 'respond', response: { content: 'Parent done.', toolCalls: [] } },
      { kind: 'block', barrier: 'child-hold' },
      { kind: 'respond', response: { content: 'Child done.', toolCalls: [] } },
    ] satisfies ScriptedGenerateStep[]);
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'child-announcements',
      agents: {
        assistant: createAgent({ generate: script, name: 'assistant' }),
        worker: createAgent({ generate: script, name: 'worker' }),
        default: createAgent({
          generate: script,
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      children: {},
    });
    const handler = createBureauHandler(bureau, {
      unauthenticatedAccess: 'allow',
      a2aAgents: ['assistant', 'worker', 'default'],
      agUi: {},
    });
    try {
      const parent = new FrameReader(await handler(startRequest(runAgentInput())));
      await parent.until(EventType.STEP_STARTED);
      await script.reached('hold');
      const parentRunId = String(bureauMetadata(parent.received[0]!.event)['runId']);
      const dispatched = await bureau.children.dispatch({
        parentRunId,
        agentName: 'worker',
        input: 'child work',
      });
      if (dispatched.outcome !== 'started') throw new Error('expected a started child');
      const childRunId = dispatched.child.childRunId;
      await script.reached('child-hold');
      script.release('child-hold');
      await bureau.children.wait({ parentRunId, childRunId });
      script.release('hold');
      const frames = [...parent.received, ...(await parent.rest())];

      const started = customs(frames, 'bureau.child-run-started');
      const settled = customs(frames, 'bureau.child-run-settled');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        value: { parentRunId, childRunId, childAgentName: 'worker', durable: true },
      });
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ value: { childRunId, status: 'completed' } });
      expect(JSON.stringify(frames)).not.toContain('child work');
      expect(frames.indexOf(frames.find((f) => f.event === started[0])!)).toBeLessThan(
        frames.indexOf(frames.find((f) => f.event === settled[0])!),
      );
    } finally {
      script.release('hold');
      script.release('child-hold');
      await bureau.dispose();
    }
  });
});
