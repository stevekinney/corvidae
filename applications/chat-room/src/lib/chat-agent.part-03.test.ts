import { describe, expect, mock, test } from 'bun:test';
import type { BeforeToolExecutionHook, StreamingGenerateFunction } from './chat-agent-test-helpers';
import {
  createChatStreamWriter,
  createTool,
  createToolbox,
  decodeLines,
  legacyFrames,
  ofType,
  runAndCollect,
  z,
} from './chat-agent-test-helpers';

const rollDiceToolCall = { id: 'call-1', name: 'roll_dice', arguments: { sides: 6, count: 1 } };

const oneRollDiceCallGenerate: StreamingGenerateFunction = async () => ({
  content: '',
  toolCalls: [rollDiceToolCall],
});

const invalidRollDiceGenerate: StreamingGenerateFunction = async () => ({
  content: '',
  toolCalls: [{ id: 'call-bad', name: 'roll_dice', arguments: { sides: 'six' } }],
});

const deniedRollDiceGenerate: StreamingGenerateFunction = async () => ({
  content: '',
  toolCalls: [{ id: 'call-denied', name: 'roll_dice', arguments: { sides: 6, count: 1 } }],
});

const rememberNoteGenerate: StreamingGenerateFunction = async () => ({
  content: '',
  toolCalls: [{ id: 'call-note', name: 'remember_note', arguments: { text: 'milk' } }],
});

const denyRollDiceTool: BeforeToolExecutionHook = async ({ toolCalls }) =>
  toolCalls.filter((toolCall) => toolCall.name !== 'roll_dice');

describe('pumpChatRun: roll_dice tool path', () => {
  const rollDice = createTool({
    name: 'roll_dice',
    version: '1.0.0',
    description: 'Roll one die and always return 4 — deterministic, for tests.',
    input: z.object({ sides: z.number().int(), count: z.number().int() }),
    async execute() {
      return { rolls: [4], total: 4 };
    },
  });

  // The run stops right after the tool step — see `stopAfterAnyToolCall` in
  // `chat-agent.ts` — so this request never reaches a second `generate` call
  // for a follow-up reply. `generate` below asserts that by throwing if it is
  // ever invoked a second time: the pre-Operative contract this restores has
  // the client's existing continuation loop (`components/chat`'s
  // `createChatSessionController`) re-POST for the follow-up instead.
  test('emits a tool_call then a tool_result carrying 4, and stops without generating a follow-up', async () => {
    let calls = 0;
    const generate: StreamingGenerateFunction = async () => {
      calls += 1;
      if (calls > 1) throw new Error('generate should not be called a second time in this run');
      return {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'roll_dice', arguments: { sides: 6, count: 1 } }],
      };
    };

    const { frames, envelope } = await runAndCollect(generate, createToolbox([rollDice]));

    expect(legacyFrames(frames)).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'roll_dice', arguments: { sides: 6, count: 1 } },
      {
        type: 'tool_result',
        callId: 'call-1',
        outcome: 'success',
        content: { rolls: [4], total: 4 },
      },
    ]);
    expect(envelope).toEqual({ ok: true, status: 'completed', content: '' });
    expect(calls).toBe(1);
  });

  test('emits tool.started then tool.settled keyed by toolCallId, with the result as a ChatToolResult', async () => {
    const { frames } = await runAndCollect(oneRollDiceCallGenerate, createToolbox([rollDice]));

    expect(
      ofType(frames, 'tool.started').map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
    ).toEqual([{ toolCallId: 'call-1', toolName: 'roll_dice' }]);
    const settled = ofType(frames, 'tool.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'roll_dice',
      result: { callId: 'call-1', outcome: 'success', content: { rolls: [4], total: 4 } },
    });
    const order = frames.map((frame) => frame.type);
    expect(order.indexOf('tool.started')).toBeLessThan(order.indexOf('tool.settled'));
    // The typed completion of the tool-call block rides along with parsed arguments.
    expect(ofType(frames, 'stream:tool-call-complete')[0]).toMatchObject({
      toolName: 'roll_dice',
      arguments: { sides: 6, count: 1 },
    });
  });

  test('forwards stream:tool-call-start/-delta the moment the generate function reports them', async () => {
    const lines: string[] = [];
    let liveFramesWhenReported = -1;
    const generate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'roll_dice',
        blockId: 'toolu_1',
      });
      streaming.report?.({
        type: 'stream:tool-call-delta',
        toolName: 'roll_dice',
        blockId: 'toolu_1',
        partialArguments: '{"sides": 6',
      });
      // Captured BEFORE this function resolves: the frames are on the wire
      // while the provider response is still open, which is the whole point
      // of `liveToolCalls`.
      liveFramesWhenReported = decodeLines(lines).filter((frame) =>
        frame.type.startsWith('stream:tool-call-'),
      ).length;
      return {
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'roll_dice', arguments: { sides: 6, count: 1 } }],
      };
    };

    const { frames } = await runAndCollect(generate, createToolbox([rollDice]), lines);

    expect(liveFramesWhenReported).toBe(2);
    expect(ofType(frames, 'stream:tool-call-start')[0]).toMatchObject({
      toolName: 'roll_dice',
      blockId: 'toolu_1',
    });
    expect(ofType(frames, 'stream:tool-call-delta')[0]).toMatchObject({
      blockId: 'toolu_1',
      partialArguments: '{"sides": 6',
    });
    // With live reporting the block id IS the provider's tool-call id, so the
    // mid-stream frames and the later `tool.*` frames correlate directly.
    expect(ofType(frames, 'tool.started')[0]?.toolCallId).toBe('toolu_1');
  });

  test('an invalid tool call settles as an error with a JSON-safe tool.error, never the raw cause', async () => {
    const { frames } = await runAndCollect(invalidRollDiceGenerate, createToolbox([rollDice]));

    const [toolError] = ofType(frames, 'tool.error');
    expect(toolError).toMatchObject({ toolCallId: 'call-bad', toolName: 'roll_dice' });
    expect(toolError?.error).toMatchObject({ name: 'ZodError', message: expect.any(String) });
    expect(ofType(frames, 'tool.settled')[0]).toMatchObject({
      toolCallId: 'call-bad',
      result: { callId: 'call-bad', outcome: 'error' },
    });
    expect(legacyFrames(frames).at(-1)).toMatchObject({ type: 'tool_result', outcome: 'error' });
  });

  test('an approval-gated call settles as action_required with the pending approval descriptor', async () => {
    const rememberNote = createTool({
      name: 'remember_note',
      version: '1.0.0',
      description: 'Save a note — approval-gated.',
      input: z.object({ text: z.string() }),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Save this note?' }) },
      async execute({ text }) {
        return { saved: true, text };
      },
    });
    const { frames } = await runAndCollect(
      rememberNoteGenerate,
      createToolbox([rememberNote], { approvalSecret: 'test-secret' }),
    );

    // Operative never emits a `tool.settled` bubble for a paused call — the
    // authoritative result only appears on `tools.executed` — so the frame
    // has to be sourced from there, and this pins that it is.
    const [settled] = ofType(frames, 'tool.settled');
    const expectedAction = {
      type: 'approval',
      message: 'Save this note?',
      risk: 'high',
      operation: { kind: 'other', argsPreview: { text: 'milk' } },
      policyVersion: 'policy:1',
      idempotencyKey: expect.stringMatching(/^approval:/),
    };
    expect(settled).toMatchObject({
      toolCallId: 'call-note',
      toolName: 'remember_note',
      result: {
        callId: 'call-note',
        outcome: 'action_required',
        content: 'Save this note?',
        action: expectedAction,
        pendingApproval: {
          callId: 'call-note',
          toolName: 'remember_note',
          arguments: { text: 'milk' },
          reason: 'Save this note?',
          policyPauseTier: 'tool',
          approvalToken: expect.any(String),
          approvalBinding: {
            agentId: 'test-assistant',
            ownerId: 'test-session',
            principalId: 'test-user',
            runId: 'test-run',
            tenantId: 'test-tenant',
            policyRevision: 'policy:1',
            toolDefinitionRevision: 'default:remember_note@1.0.0',
          },
          action: expectedAction,
        },
      },
    });
    const pendingApproval = settled?.result.pendingApproval;
    if (
      typeof pendingApproval !== 'object' ||
      pendingApproval === null ||
      Array.isArray(pendingApproval)
    ) {
      throw new Error('Expected pending approval metadata to be an object.');
    }
    expect(Reflect.get(pendingApproval, 'action')).toEqual(settled?.result.action);
    expect(legacyFrames(frames).at(-1)).toMatchObject({
      type: 'tool_result',
      outcome: 'action_required',
    });
  });

  test('a filtered denied call settles typed and legacy consumers', async () => {
    const execute = mock(async () => ({ rolls: [4], total: 4 }));
    const deniedTool = createTool({
      name: 'roll_dice',
      description: 'A tool that must not execute after denial.',
      input: z.object({ sides: z.number().int(), count: z.number().int() }),
      execute,
    });
    const { frames, envelope } = await runAndCollect(
      deniedRollDiceGenerate,
      createToolbox([deniedTool]),
      [],
      [denyRollDiceTool],
    );
    expect(execute).not.toHaveBeenCalled();
    expect(envelope).toEqual({ ok: true, status: 'completed', content: '' });
    expect(ofType(frames, 'run.completed')).toHaveLength(1);
    expect(
      frames
        .filter((frame) => ['tool_call', 'tool.settled', 'tool_result'].includes(frame.type))
        .map((frame) => frame.type),
    ).toEqual(['tool_call', 'tool.settled', 'tool_result']);
    const [settled] = ofType(frames, 'tool.settled');
    expect(settled).toMatchObject({
      toolCallId: 'call-denied',
      toolName: 'roll_dice',
      result: {
        callId: 'call-denied',
        outcome: 'error',
        content: 'This call did not run, and reported no result.',
      },
    });
    const legacy = legacyFrames(frames);
    const callIndex = legacy.findIndex((frame) => frame['type'] === 'tool_call');
    const resultIndex = legacy.findIndex(
      (frame) => frame['type'] === 'tool_result' && frame['callId'] === 'call-denied',
    );
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(legacy.filter((frame) => frame['type'] === 'tool_call')).toHaveLength(1);
    expect(legacy.filter((frame) => frame['type'] === 'tool_result')).toHaveLength(1);
    expect(legacy[callIndex]).toMatchObject({ id: 'call-denied', name: 'roll_dice' });
    expect(legacyFrames(frames).at(-1)).toMatchObject({
      type: 'tool_result',
      callId: 'call-denied',
      outcome: 'error',
    });
  });
});

describe('createChatStreamWriter', () => {
  test('envelopes every frame with wireVersion 2 and a strictly increasing sequence', () => {
    const lines: string[] = [];
    const writer = createChatStreamWriter((line) => lines.push(line));
    writer.write({ type: 'text', text: 'a' });
    writer.write({ type: 'tool.started', toolCallId: 'c', toolName: 't' });
    expect(decodeLines(lines)).toEqual([
      { type: 'text', text: 'a', wireVersion: 2, sequence: 0 },
      { type: 'tool.started', toolCallId: 'c', toolName: 't', wireVersion: 2, sequence: 1 },
    ]);
  });

  test('drops everything after the first terminal frame', () => {
    const lines: string[] = [];
    const writer = createChatStreamWriter((line) => lines.push(line));
    writer.write({ type: 'run.aborted', reason: 'stop' });
    expect(writer.terminated).toBe(true);
    writer.write({ type: 'text', text: 'late' });
    writer.write({
      type: 'run.error',
      error: { name: 'E', message: 'm', kind: 'generate', code: 'UNKNOWN' },
    });
    expect(decodeLines(lines).map((frame) => frame.type)).toEqual(['run.aborted']);
  });
});
