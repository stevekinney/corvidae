/**
 * The conversation page over stubbed Bureau requests: a new chat chooses its agent above the
 * composer and becomes its session when the run starts, and an existing session shows its header,
 * its transcript, and the approvals it waits on.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import ChatConversation from './chat-conversation.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const RESEARCHER = { ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' };
const INTERNAL = {
  ...AGENT,
  name: 'internal',
  displayName: 'Internal',
  publishState: 'unpublished',
};

const mount = (props: Record<string, unknown>) =>
  render(QueryPage, { props: { page: ChatConversation, pageProps: props } } as never);

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

async function sendMessage(container: HTMLElement, text: string): Promise<void> {
  const box = container.querySelector('textarea');
  if (box === null) throw new Error('The composer did not render.');
  await fireEvent.input(box, { target: { value: text } });
  await fireEvent.keyDown(box, { key: 'Enter' });
}

describe('a new chat', () => {
  const served = (runs: string[] = []) =>
    bureau(
      {
        'bureau.agents.list': () => ({ agents: [AGENT, RESEARCHER, INTERNAL] }),
        'bureau.contexts.get': () => ({ ...CONTEXT, id: 'thread-1', title: 'Hello there' }),
      },
      (url, init) => {
        if (!url.includes('/ag-ui/agents/')) return undefined;
        runs.push(url);
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const input: { threadId: string; runId: string } = JSON.parse(body);
        return sse([
          { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
          { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Hi.' },
          { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
          {
            type: 'RUN_FINISHED',
            threadId: input.threadId,
            runId: input.runId,
            outcome: { type: 'success' },
          },
        ]);
      },
    );

  test('offers the published agents in a searchable list above the composer, starting from the agent it was given', async () => {
    restore = served().restore;
    landAt('/chat/new');

    const { findByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'assistant',
      isNew: true,
    });

    const agent = await findByRole('combobox', { name: 'Agent' });
    // The list fills once the Bureau has said which agents there are.
    await waitFor(() => expect((agent as HTMLInputElement).value).toMatch(/assistant/i));
    await fireEvent.input(agent, { target: { value: '' } });
    await fireEvent.focus(agent);
    const listbox = await findByRole('listbox');
    const options = listbox.querySelectorAll('[role="option"]');
    const names = [...options].map((option) => option.textContent ?? '');
    expect(names.some((name) => name.includes('Researcher'))).toBe(true);
    // An agent that is not published is not one to start a chat with.
    expect(names.some((name) => name.includes('Internal'))).toBe(false);
  });

  test('replaces ?agent= when the agent is changed, without adding a history entry', async () => {
    restore = served().restore;
    landAt('/chat/new');
    const length = window.history.length;
    const { findByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'assistant',
      isNew: true,
    });
    const agent = await findByRole('combobox', { name: 'Agent' });
    await waitFor(() => expect((agent as HTMLInputElement).value).toMatch(/assistant/i));

    await fireEvent.input(agent, { target: { value: '' } });
    await fireEvent.focus(agent);
    const listbox = await findByRole('listbox');
    const option = [...listbox.querySelectorAll('[role="option"]')].find((entry) =>
      (entry.textContent ?? '').includes('Researcher'),
    );
    if (option === undefined) throw new Error('Expected the researcher to be offered.');
    await fireEvent.mouseDown(option);

    expect(router.current.search.get('agent')).toBe('researcher');
    expect(window.history.length).toBe(length);
  });

  test('starts the first run with the chosen agent, becomes the session by replacing its address, and fixes the agent', async () => {
    const runs: string[] = [];
    restore = served(runs).restore;
    landAt('/chat/new?agent=researcher');
    const { container, findByText, queryByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'researcher',
      isNew: true,
    });
    const length = window.history.length;

    await sendMessage(container, 'Hello there');

    await waitFor(() => expect(router.pathname).toBe('/chat/thread-1'));
    expect(runs).toEqual(['/bureau/ag-ui/agents/researcher/run']);
    expect(window.history.length).toBe(length);
    await findByText('Hi.');
    expect(queryByRole('combobox', { name: 'Agent' })).toBeNull();
    // The title is the Bureau's once the session exists.
    await findByText('Hello there', { selector: 'h1' });
  });
});

describe('an existing session', () => {
  test('shows its title and its agent once, and no agent chooser', async () => {
    const served = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      return undefined;
    });
    restore = served.restore;
    landAt('/chat/session-1');

    const { container, findByRole, queryByRole } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Plan the week');
    expect(container.querySelectorAll('.weft-chat-header__agent')).toHaveLength(1);
    expect(queryByRole('combobox', { name: 'Agent' })).toBeNull();
    // Reading the session's title must not ask for it again each time the answer arrives.
    await Bun.sleep(100);
    const asked = served.calls.filter((call) => call.method === 'bureau.contexts.get');
    expect(asked.length).toBeLessThanOrEqual(2);
  });

  test('restores a finished session’s transcript when it opens', async () => {
    restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
      if (url.endsWith('/messages')) {
        return Response.json({
          threadId: 'session-1',
          messages: [
            { id: 'u1', role: 'user', content: 'Plan the week' },
            { id: 'a1', role: 'assistant', content: 'Start with Monday.' },
          ],
        });
      }
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      return undefined;
    }).restore;
    landAt('/chat/session-1');

    const { findByText } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });

    expect(await findByText('Start with Monday.')).not.toBeNull();
  });
});
