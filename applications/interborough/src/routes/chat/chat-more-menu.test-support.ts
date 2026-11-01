/**
 * The Bureau and the mounted page the More menu's tests share (COR-1968): a session `session-1`
 * whose transcript is the one a test gives, with the run endpoint recording what is sent to it.
 */
import { fireEvent, render } from '@testing-library/svelte';

import { CHAT_COPY } from '../../app/copy.ts';
import { createQueryClient } from '../../lib/query.ts';
import ChatConversation from './chat-conversation.svelte';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';

const MORE = CHAT_COPY.more;

let restore: (() => void) | undefined;

/** Puts the real `fetch` back; each test file calls it after every test. */
export function restoreBureau(): void {
  restore?.();
  restore = undefined;
}

export const TURNS = [
  { id: 'u1', role: 'user', content: 'First question' },
  { id: 'a1', role: 'assistant', content: 'First answer' },
  { id: 'u2', role: 'user', content: 'Second question' },
  { id: 'a2', role: 'assistant', content: 'Second answer' },
];

export type Answers = Record<string, (params: Record<string, unknown>) => unknown>;

/** A Bureau holding the session `session-1`, whose transcript is `messages`. */
export function serve(
  messages: readonly unknown[] = TURNS,
  answers: Answers = {},
  runResponse?: () => Response,
) {
  const runs: Array<Record<string, unknown>> = [];
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.models': () => ({ selectable: true, models: [], default: null }),
      'bureau.contexts.get': () => CONTEXT,
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
      ...answers,
    },
    (url, init) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
      if (url.includes('/ag-ui/agents/')) {
        runs.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        if (runResponse !== undefined) return runResponse();
        return new Response(
          [
            { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-9' },
            {
              type: 'RUN_FINISHED',
              threadId: 'session-1',
              runId: 'run-9',
              outcome: { type: 'success' },
            },
          ]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
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
  return { ...served, runs };
}

export function mount(sessionId = 'session-1') {
  const client = createQueryClient();
  const view = render(ChatToasts, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId, title: 'Plan the week', agentName: 'assistant' },
      client,
    },
  } as never);
  return { ...view, client };
}

export type Mounted = ReturnType<typeof mount>;

export async function openMenu(view: Mounted): Promise<void> {
  await view.findByText('Second answer');
  await fireEvent.click(await view.findByRole('button', { name: MORE.label }));
}

export const callsTo = (served: ReturnType<typeof serve>, method: string) =>
  served.calls.filter((call) => call.method === method);
