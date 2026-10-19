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
  });

  test('reads its title once when it opens and once more when its run is over, and never in a loop', async () => {
    // A loop never lets a timer run, so a test that waits on a clock waits for ever. This one counts
    // the reads instead, and the read past the cap never answers, which stops a loop where it is.
    const READ_CAP = 6;
    let reads = 0;
    let transcriptReads = 0;
    const served = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url, init) => {
      if (url.endsWith('/messages')) {
        transcriptReads += 1;
        return Response.json({ threadId: 'session-1', messages: [] });
      }
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      if (typeof init?.body !== 'string' || !init.body.includes('bureau.contexts.get')) {
        return undefined;
      }
      reads += 1;
      return reads > READ_CAP ? new Response(new ReadableStream({ start() {} })) : undefined;
    });
    restore = served.restore;
    landAt('/chat/session-1');

    mount({ sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' });

    // The page has read its title and its transcript. Its own reads are the one it opens with and,
    // at most, the one its idle session asks again; any more is a loop.
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(transcriptReads).toBeGreaterThanOrEqual(1));
    expect(reads).toBeLessThanOrEqual(2);
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

describe('a run that waits on a person’s answer', () => {
  const WAIT = {
    id: 'human-wait:native-1:environment:0',
    reason: 'human-wait',
    message: 'Which environment should the release go to?',
  };

  test('shows the question above the transcript, and the next message answers it', async () => {
    const bodies: Array<{ messages: unknown[]; resume?: unknown }> = [];
    restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url, init) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      if (!url.includes('/agents/')) return undefined;
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      const first = bodies.length === 1;
      return sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: `run-${bodies.length}` },
        {
          type: 'RUN_FINISHED',
          threadId: 'session-1',
          runId: `run-${bodies.length}`,
          outcome: first ? { type: 'interrupt', interrupts: [WAIT] } : { type: 'success' },
        },
      ]);
    }).restore;
    landAt('/chat/session-1');
    const { container, findByText, queryByText } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });
    await findByText('Plan the week');

    await sendMessage(container, 'Ship it');

    expect(await findByText(WAIT.message)).not.toBeNull();
    await sendMessage(container, 'staging');
    await waitFor(() => expect(queryByText(WAIT.message)?.textContent ?? null).toBeNull());
    expect(bodies[1]?.resume).toEqual([
      {
        interruptId: WAIT.id,
        status: 'resolved',
        payload: { decision: 'approve', answer: 'staging' },
      },
    ]);
  });
});

describe('what went wrong', () => {
  test('is shown when the session could not be read, and again when the same thing fails after a dismissal', async () => {
    restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
      if (url.endsWith('/messages') || url.includes('/threads/')) {
        throw new TypeError('Failed to fetch');
      }
      if (url.includes('/agents/')) {
        return sse([{ type: 'RUN_ERROR', message: 'The thread is busy.', code: 'X' }]);
      }
      return undefined;
    }).restore;
    landAt('/chat/session-1');
    const { container, findByText, findByRole, queryByText } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });

    // The attach failed: the page says so instead of showing an empty transcript.
    expect(await findByText('Failed to fetch')).not.toBeNull();

    await sendMessage(container, 'Hello');
    expect(await findByText('The thread is busy.')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Dismiss alert' }));
    await waitFor(() => expect(queryByText('The thread is busy.')?.textContent ?? null).toBeNull());

    await sendMessage(container, 'Hello again');
    expect(await findByText('The thread is busy.')).not.toBeNull();
  });
});
