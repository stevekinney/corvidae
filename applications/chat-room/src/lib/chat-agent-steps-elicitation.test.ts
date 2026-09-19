import { describe, expect, test } from 'bun:test';
import {
  createAgent,
  createChatStreamWriter,
  createToolbox,
  createTool,
  conversationWith,
  decodeLines,
  disposeRun,
  expectWellFormedWire,
  ofType,
  pumpChatRun,
  requestContext,
  runAndCollect,
  stopWhen,
  z,
  type AnyToolbox,
  type BeforeToolExecutionHook,
  type ChatStreamEvent,
  type StreamingGenerateFunction,
} from './chat-agent-test-helpers';
import { createChatRunOptions } from './chat-agent.ts';

import type { OnElicitation } from '@corvidae/operative';

const NOTE_TOOL = 'remember_note';

/**
 * A generate function that calls the note tool on its first step and replies
 * on its second — the two-step shape the server-owned family produces and the
 * one whose live ordering the step frames exist to fix.
 */
function twoStepGenerate(): StreamingGenerateFunction {
  let calls = 0;
  return async ({ streaming }) => {
    calls += 1;
    if (calls === 1) {
      streaming.update('Saving that.');
      return {
        content: 'Saving that.',
        toolCalls: [{ id: 'call-1', name: NOTE_TOOL, arguments: { text: 'a note' } }],
      };
    }
    streaming.update('Saved that note.');
    return { content: 'Saved that note.', toolCalls: [] };
  };
}

function noteToolbox(): AnyToolbox {
  return createToolbox([
    createTool({
      name: NOTE_TOOL,
      version: '1.0.0',
      description: 'Remember a note.',
      input: z.object({ text: z.string() }),
      async execute({ text }) {
        return { saved: true, text };
      },
    }),
  ]);
}

/**
 * A turn under the SERVER-OWNED stop set, which is the one that produces more
 * than one step: the browser-owned default stops after any tool call and hands
 * control back, so a two-step response cannot happen there at all — and a
 * two-step response is exactly what the step frames exist to delineate.
 */
async function runTwoStep(): Promise<ChatStreamEvent[]> {
  const lines: string[] = [];
  const writer = createChatStreamWriter((line) => lines.push(line));
  const agent = createAgent(
    createChatRunOptions({
      generate: twoStepGenerate(),
      toolbox: noteToolbox(),
      requestContext,
      writer,
      stopWhen: [stopWhen.noToolCalls()],
    }),
  );
  const run = agent.run({ conversation: conversationWith('remember this') });
  await pumpChatRun(run, writer).finally(() => disposeRun(run));
  const frames = decodeLines(lines);
  expectWellFormedWire(frames);
  return frames;
}

/**
 * One turn of the event loop.
 *
 * The real answer to an elicitation arrives on a SEPARATE HTTP request, so the
 * pump always has turns to spare between the question being asked and it being
 * answered. A test whose callback answers in the same microtask would be
 * modelling a gap that cannot occur, and asserting on a wire the pump has not
 * been given a chance to write to yet.
 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('assistant.step.* frames', () => {
  test('brackets each step with the host identifier Operative minted for its row', async () => {
    const frames = await runTwoStep();

    const started = ofType(frames, 'assistant.step.started');
    const completed = ofType(frames, 'assistant.step.completed');
    expect(started.map((frame) => frame.step)).toEqual([0, 1]);
    expect(completed.map((frame) => frame.step)).toEqual([0, 1]);

    // THE HOST'S id, not a provider block id and not one this lab minted.
    // Every step's id is distinct, and each is a real row in the conversation
    // the run finished with — which is what lets the client put a step's text
    // into the row the server will persist it as, rather than reconciling its
    // own guess afterwards.
    const ids = started.map((frame) => frame.messageId);
    expect(new Set(ids).size).toBe(2);
    const conversation = ofType(frames, 'run.completed')[0]?.conversation;
    for (const id of ids) expect(conversation?.ids).toContain(id);
    expect(completed.map((frame) => frame.messageId)).toEqual(ids);
  });

  test("a step's boundary frames bracket that step's own text", async () => {
    const frames = await runTwoStep();
    const types = frames.map((frame) => frame.type);

    const firstStarted = types.indexOf('assistant.step.started');
    const firstCompleted = types.indexOf('assistant.step.completed');
    const secondStarted = types.lastIndexOf('assistant.step.started');
    const secondCompleted = types.lastIndexOf('assistant.step.completed');

    expect(firstStarted).toBeLessThan(firstCompleted);
    expect(firstCompleted).toBeLessThan(secondStarted);
    expect(secondStarted).toBeLessThan(secondCompleted);

    // The second step's reply is inside the second step's brackets, which is
    // the whole claim: a client can tell which row that text belongs to
    // without waiting for the terminal frame to tell it.
    const reply = frames.findIndex(
      (frame) => frame.type === 'text' && frame.text.includes('Saved that note.'),
    );
    expect(reply).toBeGreaterThan(secondStarted);
    expect(reply).toBeLessThan(secondCompleted);
  });

  test('writes the boundary before the provider has emitted anything', async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const generate: StreamingGenerateFunction = async ({ streaming }) => {
      // Read at the top of the provider call: everything the provider goes on
      // to emit belongs to the row this id names.
      seen.push(...decodeLines([...lines]).map((frame) => frame.type));
      streaming.update('hi');
      return { content: 'hi', toolCalls: [] };
    };
    await runAndCollect(generate, createToolbox([]), lines);
    expect(seen).toEqual(['assistant.step.started']);
  });
});

/**
 * Runs one turn whose gated tool call parks on `answer`, so a test can assert
 * on what has already reached the wire WHILE the question is still open.
 */
async function runWithElicitation(options: {
  answer: (context: { message: string; frames: () => ChatStreamEvent[] }) => Promise<boolean>;
}): Promise<ChatStreamEvent[]> {
  const lines: string[] = [];
  const writer = createChatStreamWriter((line) => lines.push(line));
  const onElicitation: OnElicitation = async (elicitation) => {
    const accepted = await options.answer({
      message: elicitation.message,
      frames: () => decodeLines([...lines]),
    });
    return accepted
      ? {
          requestId: elicitation.requestId,
          ...(elicitation.toolCallId === undefined ? {} : { toolCallId: elicitation.toolCallId }),
          data: elicitation.schema.parse({ approved: true }),
        }
      : null;
  };
  const beforeToolExecution: BeforeToolExecutionHook = async (context) => {
    const elicit = context.elicit;
    if (elicit === undefined) return context.toolCalls;
    const denied = new Set<string>();
    for (const call of context.toolCalls.filter((one) => one.name === NOTE_TOOL)) {
      const decision = await elicit('Save this note?', z.object({ approved: z.literal(true) }), {
        toolCallId: call.id,
      });
      if (decision === null) denied.add(call.id);
    }
    return context.toolCalls.filter((call) => !denied.has(call.id));
  };
  const agent = createAgent(
    createChatRunOptions({
      generate: twoStepGenerate(),
      toolbox: noteToolbox(),
      requestContext,
      writer,
      onElicitation,
      beforeToolExecution: [beforeToolExecution],
      // The server-owned family's set: the run carries on to a second
      // generate rather than handing control back after the tool call.
      stopWhen: [stopWhen.noToolCalls()],
    }),
  );
  const run = agent.run({ conversation: conversationWith('remember this') });
  await pumpChatRun(run, writer).finally(() => disposeRun(run));
  return decodeLines(lines);
}

describe('elicitation.* frames', () => {
  test('the question reaches the wire before anyone answers it', async () => {
    // THE POINT OF THE VOCABULARY. A question that only becomes visible once
    // it has been answered is not a question; the client has to learn about it
    // on the stream that is already open, while the run is still waiting.
    let framesWhileOpen: ChatStreamEvent[] = [];
    await runWithElicitation({
      answer: async ({ frames }) => {
        // The question is STILL OPEN at this point: this callback is what the
        // run is parked on, and it has not answered yet.
        await tick();
        framesWhileOpen = frames();
        return true;
      },
    });

    const requested = ofType(framesWhileOpen, 'elicitation.requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]?.message).toBe('Save this note?');
    expect(requested[0]?.toolCallId).toBe('call-1');
    expect(requested[0]?.requestId).toBeTruthy();
    // And nothing has resolved yet, because nobody has decided.
    expect(ofType(framesWhileOpen, 'elicitation.resolved')).toHaveLength(0);
  });

  test('an approval resolves as accepted, under the same request identity', async () => {
    const frames = await runWithElicitation({ answer: async () => true });

    const requested = ofType(frames, 'elicitation.requested');
    const resolved = ofType(frames, 'elicitation.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.accepted).toBe(true);
    // IMMUTABLE IDENTITY: the id the client was shown is the id the answer
    // came back under. A resolution nobody can correlate to a question is not
    // a resolution.
    expect(resolved[0]?.requestId).toBe(requested[0]?.requestId ?? '');
    expect(resolved[0]?.toolCallId).toBe('call-1');
  });

  test('a denial resolves as not accepted, and is NOT the call settling', async () => {
    const frames = await runWithElicitation({ answer: async () => false });

    const resolved = ofType(frames, 'elicitation.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.accepted).toBe(false);

    // The two are DIFFERENT EVENTS, and conflating them is the defect this
    // vocabulary exists to avoid. The human answered no; the call still
    // settles afterwards, with its own frame saying the tool did not run.
    const settled = ofType(frames, 'tool.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result.outcome).toBe('error');
    const types = frames.map((frame) => frame.type);
    expect(types.indexOf('elicitation.resolved')).toBeLessThan(types.indexOf('tool.settled'));
  });
});
