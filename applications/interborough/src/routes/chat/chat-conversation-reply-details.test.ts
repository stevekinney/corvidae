/**
 * Reply details on the conversation page (COR-1983): a reply the Bureau names as a step of a run
 * (`<runId>:step:<n>`) offers its details, which read that run and step from `bureau.tasks.inspect`;
 * a reply with any other identifier, and a message of the person's, offers none.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { createQueryClient } from '../../lib/query.ts';
import ChatConversation from './chat-conversation.svelte';
import { AGENT, bureau, type Call, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const COPY = CHAT_COPY.replyDetails;

const STEP = {
  step: 1,
  messageId: 'run-1:step:1',
  contextEpochId: null,
  planReason: { code: 'pinned', detail: 'The agent names its model', rejected: [] },
  hasEffectiveContext: false,
  effectiveContext: null,
};

function serve(messages: readonly unknown[]) {
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.models': () => ({ selectable: true, models: [], default: null }),
      'bureau.contexts.get': () => CONTEXT,
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
      'bureau.tasks.inspect': () => ({ steps: [STEP] }),
    },
    (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
      if (url.includes('/threads/')) {
        return new Response(
          `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return undefined;
    },
  );
  restore = served.restore;
  landAt('/chats/session-1');
  return served;
}

function mount() {
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
      client: createQueryClient(),
    },
  } as never);
}

/** The calls made to `bureau.tasks.inspect`, in order. */
const inspections = (calls: Call[]): Call[] =>
  calls.filter((call) => call.method === 'bureau.tasks.inspect');

const detailButtons = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>('button')].filter(
    (button) => button.textContent?.trim() === COPY.action,
  );

describe('Reply details on a chat', () => {
  test('are offered on an agent reply the Bureau named as a step, and on no other message', async () => {
    const served = serve([
      { id: 'u1', role: 'user', content: 'Question' },
      { id: 'run-1:step:1', role: 'assistant', content: 'Step reply' },
      { id: 'u2', role: 'user', content: 'Another question' },
      { id: 'made-up', role: 'assistant', content: 'Reply with a made-up row id' },
    ]);
    const { container, findByText } = mount();
    await findByText('Reply with a made-up row id');

    expect(detailButtons(container)).toHaveLength(1);
    expect(inspections(served.calls)).toHaveLength(0);
  });

  test('read the reply’s run and step when opened, and print its plan reason', async () => {
    const served = serve([
      { id: 'u1', role: 'user', content: 'Question' },
      { id: 'run-1:step:1', role: 'assistant', content: 'Step reply' },
    ]);
    const { container, findByText, findByTestId } = mount();
    await findByText('Step reply');

    const [button] = detailButtons(container);
    if (button === undefined) throw new Error('The reply offers no details.');
    await fireEvent.click(button);
    const panel = await findByTestId('reply-details');
    await waitFor(() => expect(panel.textContent).toContain(COPY.planReasons.pinned));
    expect(panel.textContent).toContain('The agent names its model');
    expect(inspections(served.calls).at(-1)?.params).toEqual({
      taskId: 'run-1',
      step: 1,
    });
  });
});
