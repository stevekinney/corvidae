import type { GenerateFunction } from '@lostgradient/operative';
import { describe, expect, test } from 'bun:test';

import {
  createJourneyProviderResolver,
  createRecallAgents,
  JOURNEY_AUTHOR_REPLY,
  JOURNEY_MARKER,
  JOURNEY_TOOL_CALL_NAME,
  JOURNEY_WORKFLOW_CADENCE,
  JOURNEY_WORKFLOW_ID,
  RECALL_AGENT_NAME,
  RECALL_NOTHING_REPLY,
  recallOrEcho,
} from './e2e/journey-agent.ts';

type Row = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  metadata?: Record<string, unknown>;
  toolCall?: unknown;
  toolResult?: unknown;
};

/** The part of a generate context the journey's models read: the conversation's rows. */
function contextOf(...rows: Row[]) {
  const messages = rows.map((row) => ({ metadata: {}, ...row }));
  return { conversation: { getMessages: () => messages } } as never;
}

const STUB_REPLY = { content: 'the stub', toolCalls: [] };

/** A resolver that stands in for the provider path and counts how often it is asked for a model. */
function fallbackResolver() {
  const resolved: unknown[] = [];
  const stub: GenerateFunction = async () => STUB_REPLY;
  const resolver = ((_definitions: unknown, provider: unknown) => {
    resolved.push(provider);
    return stub;
  }) as never;
  return { resolved, resolver };
}

async function generateWith(...rows: Row[]) {
  const { resolver } = fallbackResolver();
  const generate = createJourneyProviderResolver(resolver)(
    [],
    { provider: 'anthropic', model: 'sonnet', apiKey: 'fixture' },
    undefined,
    undefined,
  );
  return generate(contextOf(...rows));
}

describe('the journey provider resolver', () => {
  test('answers the marked opener with one call to the workflow tool that writes the workflow', async () => {
    const response = await generateWith({ role: 'user', content: `${JOURNEY_MARKER} Write one.` });

    expect(response.toolCalls).toHaveLength(1);
    const [call] = response.toolCalls ?? [];
    expect(call?.name).toBe(JOURNEY_TOOL_CALL_NAME);
    expect(call?.arguments).toMatchObject({
      id: JOURNEY_WORKFLOW_ID,
      trigger: { kind: 'schedule', spec: JOURNEY_WORKFLOW_CADENCE },
    });
  });

  test('answers with a fixed text once the conversation holds a call, so the agent cannot loop', async () => {
    const response = await generateWith(
      { role: 'user', content: `${JOURNEY_MARKER} Write one.` },
      { role: 'assistant', content: '', toolCall: { id: 'call-1', name: JOURNEY_TOOL_CALL_NAME } },
      { role: 'tool', content: '', toolResult: { callId: 'call-1' } },
    );

    expect(response).toEqual({ content: JOURNEY_AUTHOR_REPLY, toolCalls: [] });
  });

  test('hands an opener without the marker to the resolver it wraps, and calls no tool', async () => {
    const response = await generateWith({ role: 'user', content: 'Hello there' });

    expect(response).toEqual(STUB_REPLY);
  });

  test('hands a conversation with no opener, or one that is not text, to the resolver it wraps', async () => {
    expect(await generateWith()).toEqual(STUB_REPLY);
    expect(await generateWith({ role: 'user', content: [{ type: 'image' }] })).toEqual(STUB_REPLY);
  });

  test('asks the resolver it wraps for the model of every agent, marked or not', () => {
    const { resolved, resolver } = fallbackResolver();
    const provider = { provider: 'anthropic', model: 'sonnet', apiKey: 'fixture' } as const;

    createJourneyProviderResolver(resolver)([], provider, undefined, undefined);

    expect(resolved).toEqual([provider]);
  });
});

describe('the recall echo', () => {
  const generate = async (...rows: Row[]) => recallOrEcho(contextOf(...rows));

  test('is one agent under the name the journey host serves', () => {
    const agents = createRecallAgents();

    expect(Object.keys(agents)).toEqual([RECALL_AGENT_NAME]);
    expect(agents[RECALL_AGENT_NAME].name).toBe(RECALL_AGENT_NAME);
  });

  test('echoes the last message when the run recalled nothing', async () => {
    const response = await generate(
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'a label' },
    );

    expect(response).toEqual({ content: 'a label', toolCalls: [] });
  });

  test('answers with the text of the memory it recalled instead of the message', async () => {
    const response = await generate(
      { role: 'user', content: 'Recall it' },
      { role: 'system', content: 'The corrected label', metadata: { memoryEvidence: {} } },
    );

    expect(response).toEqual({ content: 'The corrected label', toolCalls: [] });
  });

  test('ignores a system row that is not recalled memory', async () => {
    const response = await generate(
      { role: 'system', content: 'You are an echo.' },
      { role: 'user', content: 'plain' },
    );

    expect(response).toEqual({ content: 'plain', toolCalls: [] });
  });

  test('has nothing to echo when there is no user message and no memory', async () => {
    expect(await generate()).toEqual({ content: RECALL_NOTHING_REPLY, toolCalls: [] });
  });
});
