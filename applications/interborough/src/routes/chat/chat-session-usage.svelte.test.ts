/**
 * What a session keeps of the tokens a run reported (COR-1983): the counts of a run it watched end,
 * under the run’s Bureau identifier, for the reply details of that run’s steps.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import type { Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const THREAD = 'thread-1';

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const started = {
  type: 'RUN_STARTED',
  threadId: THREAD,
  runId: 'run-1',
  metadata: { '@lostgradient/bureau': { runId: 'native-1', sessionId: THREAD, durable: false } },
};

const finished = (extra: Record<string, unknown>) => ({
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId: 'run-1',
  outcome: { type: 'success' },
  ...extra,
});

let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

function open(fetchAgUi: Fetcher): ChatSessionState {
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'assistant',
    fetch: fetchAgUi,
  });
  sessions.push(session);
  return session;
}

describe('the usage of a run the session watched end', () => {
  test('is kept under the run’s Bureau identifier', async () => {
    const session = open(async () =>
      sse([started, finished({ usage: [{ inputTokens: 90, totalTokens: 120 }] })]),
    );

    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);

    expect(session.usage.get('native-1')).toEqual({ inputTokens: 90, totalTokens: 120 });
    expect(session.usage.size).toBe(1);
  });

  test('is not kept for a run whose end carried no count', async () => {
    const session = open(async () => sse([started, finished({ usage: [{}] })]));

    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);

    expect(session.usage.size).toBe(0);
  });
});
