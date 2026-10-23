/**
 * The conversation page over stubbed Bureau requests: a new chat chooses its agent above the
 * composer and becomes its session when the run starts, and an existing session shows its header,
 * its transcript, and the approvals it waits on.
 */
import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { settle, until } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import ChatConversation from './chat-conversation.svelte';
import { AGENT, bureau as bureauOf, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

/**
 * The most times any test here lets the page read a session's title. The page reads it when it
 * opens and once more when a run ends, so a test reaches the cap only when the page reads it in a
 * loop: it asks again each time an answer lands, so no timer ever runs, and a test that waits on
 * one waits for ever instead of failing. The read past the cap never answers, which stops the loop
 * where it is, and the afterEach below fails the test that made it.
 */
const CONTEXT_READ_CAP = 6;
let contextReads = 0;

/** `bureau` from the shared support, with every test's reads of the session counted and capped. */
function bureau(
  answers: Parameters<typeof bureauOf>[0],
  other: Parameters<typeof bureauOf>[1] = () => undefined,
): ReturnType<typeof bureauOf> {
  return bureauOf(answers, (url, init) => {
    if (typeof init?.body === 'string' && init.body.includes('"bureau.contexts.get"')) {
      contextReads += 1;
      if (contextReads > CONTEXT_READ_CAP) return new Response(new ReadableStream({ start() {} }));
    }
    return other(url, init);
  });
}

let restore: (() => void) | undefined;
beforeEach(() => {
  contextReads = 0;
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  restore?.();
  restore = undefined;
  expect(contextReads).toBeLessThanOrEqual(CONTEXT_READ_CAP);
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

  test('shows the agent’s card with its prompts, and the other agents to choose from until one is chosen', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({
        agents: [
          { ...AGENT, examples: ['Say hello', 'Plan the week', 'Summarise it', 'A fourth one'] },
          { ...RESEARCHER, description: 'Finds things.', examples: ['Find the latest filing'] },
          INTERNAL,
        ],
      }),
    }).restore;
    landAt('/chat/new');

    const { findByTestId, findByRole, queryByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'assistant',
      isNew: true,
    });

    const card = await findByTestId('agent-card');
    expect(card.textContent).toContain(AGENT.description);
    // Up to three prompts, as buttons, and an agent that suggests none shows none.
    const group = await findByRole('group', { name: 'Example prompts' });
    expect(
      [...group.querySelectorAll('button')].map((button) => button.textContent?.trim()),
    ).toEqual(['Say hello', 'Plan the week', 'Summarise it']);
    // The other published agents are cards to choose from, and an unpublished one is not.
    const others = await findByRole('heading', { name: 'Or start with another agent' });
    const grid = others.parentElement;
    expect(grid?.textContent).toContain('Finds things.');
    expect(grid?.textContent).not.toContain('Internal');
    expect(queryByRole('group', { name: 'Example prompts' })).not.toBeNull();
  });

  test('shows only the card of an agent the address names, with its prompts', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({
        agents: [AGENT, { ...RESEARCHER, examples: ['Find the latest filing'] }],
      }),
    }).restore;
    landAt('/chat/new?agent=researcher');

    const { findByTestId, queryByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'researcher',
      agentChosen: true,
      isNew: true,
    });

    const card = await findByTestId('agent-card');
    expect(card.textContent).toContain('Researcher');
    expect(card.textContent).toContain('Find the latest filing');
    expect(queryByRole('heading', { name: 'Or start with another agent' })).toBeNull();
  });

  test('puts a prompt in the composer without sending it, and choosing an agent’s card selects that agent', async () => {
    const runs: string[] = [];
    restore = bureau(
      {
        'bureau.agents.list': () => ({
          agents: [
            { ...AGENT, examples: ['Say hello'] },
            { ...RESEARCHER, description: 'Finds things.' },
          ],
        }),
      },
      (url) => {
        if (url.includes('/ag-ui/agents/')) runs.push(url);
        return undefined;
      },
    ).restore;
    landAt('/chat/new');
    const { container, findByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'assistant',
      isNew: true,
    });

    await fireEvent.click(await findByRole('button', { name: 'Say hello' }));

    await waitFor(() => expect(container.querySelector('textarea')?.value).toBe('Say hello'));
    expect(runs).toEqual([]);

    await fireEvent.click(await findByRole('button', { name: /Researcher/ }));

    expect(router.current.search.get('agent')).toBe('researcher');
  });

  test('names an agent whose display name is its identifier once, in monospace, on its card and on its choice', async () => {
    const echo = { ...AGENT, name: 'echo', displayName: 'echo', description: null };
    const runner = {
      ...AGENT,
      name: 'tool-runner',
      displayName: 'tool-runner',
      description: null,
    };
    restore = bureau({ 'bureau.agents.list': () => ({ agents: [echo, runner] }) }).restore;
    landAt('/chat/new');
    const { findByTestId, findByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'echo',
      isNew: true,
    });

    const card = await findByTestId('agent-card');
    const others = await findByRole('heading', { name: 'Or start with another agent' });
    const choice = others.parentElement?.querySelector('li');

    expect(card.querySelector('h2')?.textContent?.trim()).toBe('echo');
    expect(card.querySelectorAll('h2 code.ib-identifier')).toHaveLength(1);
    expect(choice?.textContent?.trim()).toBe('tool-runner');
    expect(choice?.querySelectorAll('code.ib-identifier')).toHaveLength(1);
    expect(choice?.querySelector('.ib-agent-choice__description')).toBeNull();
  });

  test('replaces a draft in the composer with the prompt, however many times it is clicked', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [{ ...AGENT, examples: ['Say hello'] }] }),
    }).restore;
    landAt('/chat/new');
    const { container, findByRole } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'assistant',
      isNew: true,
    });
    const box = container.querySelector('textarea');
    if (box === null) throw new Error('The composer did not render.');
    await fireEvent.input(box, { target: { value: 'half a thought' } });
    const prompt = await findByRole('button', { name: 'Say hello' });

    await fireEvent.click(prompt);
    await waitFor(() => expect(box.value).toBe('Say hello'));
    await fireEvent.click(prompt);

    expect(box.value).toBe('Say hello');
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

describe('quoting an agent’s reply', () => {
  /**
   * Waits until the run is over, which is when Chat stops offering Stop. A message sent before that
   * is a follow-up to the run in flight, and these tests are about the message that starts one. The
   * wait asserts a boolean, not the element's absence: a failed `expect` on an element makes Bun
   * print the whole DOM, which crashes Bun 1.4.2 (`scripts/check-wait-for-element-assertions.ts`).
   */
  async function settled(container: HTMLElement): Promise<void> {
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Stop generating"]') === null).toBe(true),
    );
  }

  /** A Bureau whose agent answers `reply`, recording the body of every run it is asked to start. */
  function replying(
    reply: string,
    bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>,
  ) {
    return bureau(
      {
        'bureau.agents.list': () => ({ agents: [AGENT] }),
        'bureau.contexts.get': () => ({ ...CONTEXT, id: 'thread-1', title: 'Quoting' }),
        'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
      },
      (url, init) => {
        if (!url.includes('/ag-ui/agents/')) return undefined;
        const input = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          threadId: string;
          runId: string;
          messages: Array<{ role: string; content: unknown }>;
        };
        bodies.push(input);
        return sse([
          { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
          { type: 'TEXT_MESSAGE_START', messageId: `reply-${bodies.length}`, role: 'assistant' },
          {
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: `reply-${bodies.length}`,
            delta: reply,
          },
          { type: 'TEXT_MESSAGE_END', messageId: `reply-${bodies.length}` },
          {
            type: 'RUN_FINISHED',
            threadId: input.threadId,
            runId: input.runId,
            outcome: { type: 'success' },
          },
        ]);
      },
    );
  }

  test('offers Quote on an agent’s reply, gathers the quote above the composer, and sends it as a block quote ahead of the typed text', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    restore = replying('The first item is alpha.', bodies).restore;
    landAt('/chat/new?agent=assistant');
    const { container, findByRole, findByText } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'assistant',
      isNew: true,
    });
    await sendMessage(container, 'List the items');
    await findByText('The first item is alpha.');
    // The first run is over, so the next message starts a run of its own and is not a follow-up.
    await settled(container);

    await fireEvent.click(await findByRole('button', { name: 'Quote message' }));
    const chips = await findByRole('list', { name: 'Quoted excerpts' });
    expect(chips.textContent).toContain('The first item is alpha.');

    await sendMessage(container, 'Why first?');

    await waitFor(() => expect(bodies).toHaveLength(2));
    const sent = bodies[1]?.messages.findLast((message) => message.role === 'user');
    expect(sent?.content).toBe('> The first item is alpha.\n\nWhy first?');
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

  test('names its agent as a link to the agent’s page, which a modified click leaves to the browser', async () => {
    restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      return undefined;
    }).restore;
    landAt('/chat/session-1');
    const { container } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });

    const link = await waitFor(() => {
      const found = container.querySelector<HTMLAnchorElement>('a.weft-chat-header__agent');
      if (found === null) throw new Error('The agent link did not render.');
      return found;
    });
    expect(link.getAttribute('href')).toBe('/agents/assistant');
    expect(await fireEvent.click(link, { button: 0, ctrlKey: true })).toBe(true);
    expect(router.pathname).toBe('/chat/session-1');
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/agents/assistant');
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

  test('says what became of the session’s runs, linking to the run, and asks for those of this session alone', async () => {
    const stub = bureau({
      'bureau.contexts.get': () => CONTEXT,
      'bureau.tasks.list': () => ({
        tasks: [
          {
            id: 'run-7',
            contextId: 'session-1',
            agentName: 'assistant',
            owner: 'anonymous:local',
            actor: null,
            status: 'failed',
            finishReason: null,
            statusMessage: null,
            createdAt: '2026-10-19T08:00:00.000Z',
            updatedAt: '2026-10-19T08:00:01.000Z',
            cleanup: null,
            openWaits: [],
          },
        ],
        nextPageToken: null,
      }),
    });
    restore = stub.restore;
    landAt('/chat/session-1');
    const { container } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });
    await waitFor(() => expect(container.querySelector('a[href="/runs/run-7"]')).not.toBeNull());
    expect(container.querySelector('a[href="/runs/run-7"]')?.textContent).toBe('Run failed');
    expect(stub.calls.find((call) => call.method === 'bureau.tasks.list')?.params).toEqual({
      contextId: 'session-1',
      limit: 50,
    });
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

describe('a run that waits on several questions', () => {
  const FIRST = {
    id: 'human-wait:native-1:environment:0',
    reason: 'human-wait',
    message: 'Which environment should the release go to?',
  };
  const SECOND = {
    id: 'human-wait:native-1:region:0',
    reason: 'human-wait',
    message: 'Which region should the release go to?',
  };

  test('shows each question in turn, holds the answers as rows, and sends one resume for them all', async () => {
    const bodies: Array<{ messages: unknown[]; resume?: Array<{ interruptId: string }> }> = [];
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
          outcome: first ? { type: 'interrupt', interrupts: [FIRST, SECOND] } : { type: 'success' },
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

    // One question is shown at a time, the first one the run asked.
    expect(await findByText(FIRST.message)).not.toBeNull();
    expect(queryByText(SECOND.message)).toBeNull();
    await sendMessage(container, 'staging');

    // The answer is a row in the transcript, once, and the alert moves on. Nothing was sent.
    expect(await findByText(SECOND.message)).not.toBeNull();
    await waitFor(() => expect(queryByText(FIRST.message)?.textContent ?? null).toBeNull());
    expect(container.textContent?.split('staging').length).toBe(2);
    expect(bodies).toHaveLength(1);

    await sendMessage(container, 'eu');

    await waitFor(() => expect(queryByText(SECOND.message)?.textContent ?? null).toBeNull());
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toEqual([]);
    expect(bodies[1]?.resume?.map((entry) => entry.interruptId)).toEqual([FIRST.id, SECOND.id]);
  });
});

describe('a run that waits on a tool approval', () => {
  const APPROVAL = {
    id: 'approval:native-1:call-refund',
    reason: 'tool-approval',
    toolCallId: 'call-refund',
    message: 'Refund order-1001?',
  };
  const toolCall = [
    { type: 'TOOL_CALL_START', toolCallId: 'call-refund', toolCallName: 'issue-refund' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-refund', delta: '{"cents":4200}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call-refund' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: 'result-1',
      toolCallId: 'call-refund',
      content: 'requires approval',
      role: 'tool',
    },
  ];

  test('is decided in its row under the call, and the decision makes the inbox read again at once', async () => {
    const bodies: Array<{ resume?: unknown }> = [];
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
        ...(first ? toolCall : []),
        {
          type: 'RUN_FINISHED',
          threadId: 'session-1',
          runId: `run-${bodies.length}`,
          outcome: first ? { type: 'interrupt', interrupts: [APPROVAL] } : { type: 'success' },
        },
      ]);
    }).restore;
    landAt('/chat/session-1');
    const { container, findByRole } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });
    await sendMessage(container, 'Refund it');
    // The approval is one flat row with the question it asks, which is the approval's own message
    // here. No run identifier and no policy string reaches the page.
    await waitFor(() =>
      expect(container.querySelector('.ib-decision__question')?.textContent).toBe(
        'Refund order-1001?',
      ),
    );
    expect(container.textContent).not.toContain('requires approval');
    expect(container.textContent).not.toMatch(/run-\d/);

    const invalidated = spyOn(QueryClient.prototype, 'invalidateQueries');
    try {
      await fireEvent.click(await findByRole('button', { name: 'Approve' }));

      await waitFor(() => expect(bodies[1]?.resume).toBeDefined());
      // The Bureau's reviews, the engine's, and the tasks that hold them are all asked again: the
      // approval is not what `/reviews` last listed, and the inbox does not wait for its poll.
      await waitFor(() =>
        expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey?.[0])).toEqual(
          expect.arrayContaining(['bureau-reviews', 'reviews', 'bureau-tasks']),
        ),
      );
    } finally {
      invalidated.mockRestore();
    }
  });
});

describe('a decision made somewhere else', () => {
  test('is read again at the next poll when the first read of the thread failed', async () => {
    let messageReads = 0;
    let listReads = 0;
    restore = bureau(
      {
        'bureau.contexts.get': () => CONTEXT,
        // The review is pending at first, so the page has seen it, and gone after.
        'bureau.reviews.list': () => {
          listReads += 1;
          return {
            reviews:
              listReads === 1
                ? [
                    toolApprovalFixture({
                      sessionId: 'session-1',
                      approval: { ...toolApprovalFixture().approval, callId: 'call-refund' },
                    }),
                  ]
                : [],
          };
        },
      },
      (url, init) => {
        if (url.endsWith('/messages')) {
          messageReads += 1;
          // The open read, then the read after the decision, which fails once.
          if (messageReads === 2) throw new TypeError('Failed to fetch');
          return Response.json({ threadId: 'session-1', messages: [] });
        }
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        if (!url.includes('/agents/')) return undefined;
        const input: { runId: string } = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        );
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: input.runId },
          { type: 'TOOL_CALL_START', toolCallId: 'call-refund', toolCallName: 'issue-refund' },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'call-refund', delta: '{"cents":4200}' },
          { type: 'TOOL_CALL_END', toolCallId: 'call-refund' },
          {
            type: 'TOOL_CALL_RESULT',
            messageId: 'result-1',
            toolCallId: 'call-refund',
            content: 'requires approval',
            role: 'tool',
          },
          {
            type: 'RUN_FINISHED',
            threadId: 'session-1',
            runId: input.runId,
            outcome: {
              type: 'interrupt',
              interrupts: [
                {
                  id: 'approval:native-1:call-refund',
                  reason: 'tool-approval',
                  toolCallId: 'call-refund',
                  message: 'Refund order-1001?',
                },
              ],
            },
          },
        ]);
      },
    ).restore;
    landAt('/chat/session-1');
    // The poll is TanStack Query's refetch interval, so the clock is faked from here and the test
    // moves it; the afterEach above puts the real one back.
    jest.useFakeTimers();
    const { container } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });
    await sendMessage(container, 'Refund it');
    await until(() => expect(container.querySelector('.ib-decision')).not.toBeNull());
    expect(messageReads).toBe(1);

    // The poll finds the review gone and the read fails; the next poll reads the thread again.
    jest.advanceTimersByTime(3_000);
    await until(() => expect(messageReads).toBe(2));
    await settle();
    jest.advanceTimersByTime(3_000);
    await until(() => expect(messageReads).toBeGreaterThanOrEqual(3));
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

describe('attachments', () => {
  const MIB = 1024 * 1024;
  const MODEL_MEDIA = {
    modalities: {
      text: { input: true, output: true },
      image: { input: true, output: false },
      document: { input: true, output: false },
    },
    mimeFamilies: ['text', 'image', 'document'],
    mediaLimits: [{ modality: 'image', maxBytes: 10 * MIB }],
  };
  const SEER = { ...AGENT, name: 'seer', displayName: 'Seer', media: MODEL_MEDIA };

  const jsonRpcFault = (httpStatus: number, weftCode: string, data: object = {}) =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'No.', data: { weftCode, httpStatus, ...data } },
    });
  const session = {
    uploadId: 'upload-1',
    declaredMediaType: null,
    declaredByteLength: 4,
    receivedBytes: 0,
    state: 'open',
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2026-10-19T01:00:00.000Z',
  };

  type Served = {
    runs: Array<{ messages: Array<{ content: unknown }> }>;
    methods: string[];
    uploadFault: { current: ((method: string) => Response | undefined) | undefined };
  };

  /** A session of `seer`, over a Bureau whose run answers with `reply`. */
  function served(
    agents: unknown[],
    reply: () => Response = () =>
      sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
        {
          type: 'RUN_FINISHED',
          threadId: 'session-1',
          runId: 'run-1',
          outcome: { type: 'success' },
        },
      ]),
    history: unknown[] = [],
  ): Served {
    const state: Served = { runs: [], methods: [], uploadFault: { current: undefined } };
    const answered = bureau(
      {
        'bureau.contexts.get': () => ({ ...CONTEXT, agentName: 'seer' }),
        'bureau.agents.list': () => ({ agents }),
        'bureau.assets.uploads.create': () => session,
        'bureau.assets.uploads.append': () => session,
        'bureau.assets.uploads.complete': () => ({
          assetId: 'asset-1',
          state: 'available',
          mediaType: 'image/png',
        }),
      },
      (url, init) => {
        if (url.endsWith('/messages')) {
          return Response.json({ threadId: 'session-1', messages: history });
        }
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        if (url.includes('/agents/')) {
          state.runs.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
          return reply();
        }
        const method = (
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { method?: string }
        ).method;
        if (method?.startsWith('bureau.assets.')) {
          state.methods.push(method);
          return state.uploadFault.current?.(method);
        }
        return undefined;
      },
    );
    restore = answered.restore;
    return state;
  }

  const open = () => {
    landAt('/chat/session-1');
    return mount({ sessionId: 'session-1', title: 'Plan the week', agentName: 'seer' });
  };

  const picker = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[type="file"]');

  async function attach(container: HTMLElement, ...files: File[]): Promise<void> {
    const input = await waitFor(() => {
      const found = picker(container);
      if (found === null) throw new Error('The file picker did not render.');
      return found;
    });
    await fireEvent.change(input, { target: { files } });
  }

  const states = (container: HTMLElement) =>
    [...container.querySelectorAll('.chat-attachment-preview')].map((node) =>
      node.getAttribute('data-state'),
    );
  const png = (size = 4) => new File([new Uint8Array(size)], 'photo.png', { type: 'image/png' });

  test('turns the composer’s file picker on for an agent whose model takes media, accepting what it takes', async () => {
    const state = served([SEER]);
    const { container } = open();

    await waitFor(() => expect(picker(container)).not.toBeNull());

    expect(picker(container)?.getAttribute('accept')).toBe('text/*,image/*,application/pdf');
    expect(state.runs).toEqual([]);
  });

  test('offers no file picker for an agent that names no model, or while the agents are not known', async () => {
    served([{ ...SEER, media: null }]);
    const { container, findByText } = open();
    await findByText('Plan the week');

    await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());
    expect(picker(container)).toBeNull();
  });

  test('uploads an attached file through the three upload operations and shows it ready', async () => {
    const state = served([SEER]);
    const { container } = open();

    await attach(container, png());

    await waitFor(() => expect(states(container)).toEqual(['ready']));
    expect(state.methods).toEqual([
      'bureau.assets.uploads.create',
      'bureau.assets.uploads.append',
      'bureau.assets.uploads.complete',
    ]);
  });

  test('sends the message with the uploaded asset as a file part, and clears the composer', async () => {
    const state = served([SEER]);
    const { container } = open();
    await attach(container, png());
    await waitFor(() => expect(states(container)).toEqual(['ready']));

    await sendMessage(container, 'What is this?');

    await waitFor(() => expect(state.runs).toHaveLength(1));
    expect(state.runs[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'What is this?' },
      {
        type: 'image',
        source: { type: 'file', provider: 'bureau', value: 'asset-1', mimeType: 'image/png' },
      },
    ]);
    await waitFor(() => expect(states(container)).toEqual([]));
  });

  test('refuses a file over the limit for its type without uploading it, in the page’s words', async () => {
    const state = served([SEER]);
    const { container, findByText } = open();
    const big = png();
    Object.defineProperty(big, 'size', { value: 10 * MIB + 1 });

    await attach(container, big);

    await waitFor(() => expect(states(container)).toEqual(['error']));
    expect(await findByText(/larger than the 10 MB this agent accepts/)).not.toBeNull();
    expect(state.methods).toEqual([]);
  });

  test('refuses a file larger than any limit of the model, and one of a type it does not take, without uploading', async () => {
    const state = served([
      {
        ...SEER,
        media: {
          ...MODEL_MEDIA,
          mimeFamilies: ['image'],
          mediaLimits: [{ modality: 'image', maxBytes: 3 * MIB }],
        },
      },
    ]);
    const { container, findByText } = open();
    const big = png();
    Object.defineProperty(big, 'size', { value: 4 * MIB });

    await attach(container, big, new File(['zip'], 'a.zip', { type: 'application/zip' }));

    await waitFor(() => expect(states(container)).toEqual(['error', 'error']));
    expect(await findByText(/larger than the 3\.0 MB this agent accepts/)).not.toBeNull();
    expect(await findByText(/does not accept that type of file/)).not.toBeNull();
    expect(state.methods).toEqual([]);
  });

  test.each([
    ['bureau.assets.uploads.append', () => jsonRpcFault(404, 'NotFound'), /upload expired/],
    [
      'bureau.assets.uploads.complete',
      () => jsonRpcFault(422, 'Unprocessable', { reason: 'safety-gate-flagged' }),
      /would not accept this file/,
    ],
    [
      'bureau.assets.uploads.complete',
      () => jsonRpcFault(422, 'Unprocessable', { reason: 'upload-incomplete' }),
      /could not be uploaded/,
    ],
    [
      'bureau.assets.uploads.append',
      () => new Response('Too large', { status: 413 }),
      /could not be uploaded/,
    ],
  ] as const)(
    'shows an upload fault from %s on the attachment as an error',
    async (failing, answer, words) => {
      const state = served([SEER]);
      state.uploadFault.current = (method) => (method === failing ? answer() : undefined);
      const { container, findByText } = open();

      await attach(container, png());

      await waitFor(() => expect(states(container)).toEqual(['error']));
      expect(await findByText(words)).not.toBeNull();
    },
  );

  test('refuses, without sending, a file already attached when the agent is switched to one that takes none', async () => {
    const plain = { ...AGENT, name: 'plain', displayName: 'Plain', media: null };
    const state = served([SEER, plain]);
    landAt('/chat/new?agent=seer');
    const { container, findByRole, findByText } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'seer',
      isNew: true,
    });
    await attach(container, png());
    await waitFor(() => expect(states(container)).toEqual(['ready']));

    const chooser = await findByRole('combobox', { name: 'Agent' });
    await fireEvent.input(chooser, { target: { value: '' } });
    await fireEvent.focus(chooser);
    const listbox = await findByRole('listbox');
    const option = [...listbox.querySelectorAll('[role="option"]')].find((entry) =>
      (entry.textContent ?? '').includes('Plain'),
    );
    if (option === undefined) throw new Error('Expected the plain agent to be offered.');
    await fireEvent.mouseDown(option);

    await waitFor(() => expect(states(container)).toEqual(['error']));
    expect(await findByText(/does not accept that type of file/)).not.toBeNull();
    await sendMessage(container, 'Hello');
    await waitFor(() => expect(state.runs).toHaveLength(1));
    expect(state.runs[0]?.messages[0]?.content).toBe('Hello');
  });

  test('offers no file picker while the page is still joining the session’s run', async () => {
    // The attach never answers, so the page is still joining when the picker would otherwise show.
    restore = bureau(
      {
        'bureau.contexts.get': () => ({ ...CONTEXT, agentName: 'seer' }),
        'bureau.agents.list': () => ({ agents: [SEER] }),
      },
      (url) => {
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (url.includes('/threads/') && url.endsWith('/run')) {
          return new Response(new ReadableStream({ start() {} }), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return undefined;
      },
    ).restore;
    landAt('/chat/session-1');
    const { container, findByText } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'seer',
    });
    await findByText('Plan the week');
    // The agents are known by now, which is what would turn the picker on.
    await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(picker(container)).toBeNull();
  });

  test('turns the picker off while a run is going', async () => {
    served(
      [SEER],
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' })}\n\n`,
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const { container } = open();
    await waitFor(() => expect(picker(container)).not.toBeNull());

    await sendMessage(container, 'Hello');

    await waitFor(() => expect(picker(container)).toBeNull());
  });

  test('turns the picker off while the run waits on a person’s answer', async () => {
    served([SEER], () =>
      sse([
        { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
        {
          type: 'RUN_FINISHED',
          threadId: 'session-1',
          runId: 'run-1',
          outcome: {
            type: 'interrupt',
            interrupts: [
              { id: 'human-wait:native-1:q:0', reason: 'human-wait', message: 'Which one?' },
            ],
          },
        },
      ]),
    );
    const { container, findByText } = open();
    await waitFor(() => expect(picker(container)).not.toBeNull());

    await sendMessage(container, 'Ship it');

    expect(await findByText('Which one?')).not.toBeNull();
    expect(picker(container)).toBeNull();
  });

  test.each(['UNSUPPORTED_MEDIA_TYPE', 'MEDIA_NOT_ADMITTED', 'INVALID_INPUT'])(
    'tells a run refused with %s over an attachment in the page’s words, never the raw message',
    async (code) => {
      served([SEER], () =>
        sse([{ type: 'RUN_ERROR', message: 'Asset "asset-1" is deleted', code }]),
      );
      const { container, findByText, queryByText } = open();
      await attach(container, png());
      await waitFor(() => expect(states(container)).toEqual(['ready']));

      await sendMessage(container, 'Look');

      expect(await findByText(/model could not take an attached file/)).not.toBeNull();
      expect(queryByText(/asset-1/)).toBeNull();
    },
  );

  test('keeps the raw message for an INVALID_INPUT on a turn with no attachment', async () => {
    served([SEER], () =>
      sse([{ type: 'RUN_ERROR', message: 'The input is not valid.', code: 'INVALID_INPUT' }]),
    );
    const { container, findByText } = open();
    await findByText('Plan the week');

    await sendMessage(container, 'Hello');

    expect(await findByText('The input is not valid.')).not.toBeNull();
  });
});

describe('the files on a row', () => {
  const SEER = { ...AGENT, name: 'seer', displayName: 'Seer', media: null };
  const reload = (history: unknown[]) => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.agents.list': () => ({ agents: [SEER] }) },
      (url) => {
        if (url.endsWith('/messages')) {
          return Response.json({ threadId: 'session-1', messages: history });
        }
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        return undefined;
      },
    ).restore;
    landAt('/chat/session-1');
    return mount({ sessionId: 'session-1', title: 'Plan the week', agentName: 'seer' });
  };

  test('shows an image a run announces on the assistant row it ends with', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.agents.list': () => ({ agents: [SEER] }) },
      (url) => {
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        if (!url.includes('/agents/')) return undefined;
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
          { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Here it is.' },
          {
            type: 'CUSTOM',
            name: 'bureau.asset-part',
            value: { messageId: 'reply', index: 1, assetId: 'returned-1', mediaType: 'image/png' },
          },
          { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
          {
            type: 'RUN_FINISHED',
            threadId: 'session-1',
            runId: 'run-1',
            outcome: { type: 'success' },
          },
        ]);
      },
    ).restore;
    landAt('/chat/session-1');
    const { container, findByText } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'seer',
    });
    await findByText('Plan the week');

    await sendMessage(container, 'Draw it');

    await findByText('Here it is.');
    await waitFor(() =>
      expect(
        container.querySelector('img[src="/bureau/assets/returned-1/content"]'),
      ).not.toBeNull(),
    );
  });

  test('shows the same assistant row after a reload, from the snapshot', async () => {
    const { container, findByText } = reload([
      { id: 'u1', role: 'user', content: 'Draw it' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Here it is.',
        metadata: {
          'bureau:assetParts': [{ index: 1, assetId: 'returned-1', mediaType: 'image/png' }],
        },
      },
    ]);

    await findByText('Here it is.');

    await waitFor(() =>
      expect(
        container.querySelector('img[src="/bureau/assets/returned-1/content"]'),
      ).not.toBeNull(),
    );
  });

  test('still shows a row that has no text of its own and no file, such as a tool call', async () => {
    const { findByText } = reload([
      { id: 'u1', role: 'user', content: 'Look it up' },
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup-order', arguments: '{"id":"order-1"}' },
          },
        ],
      },
      { id: 't1', role: 'tool', toolCallId: 'call-1', content: 'found' },
      { id: 'a2', role: 'assistant', content: 'Done.' },
    ]);

    expect(await findByText('lookup-order')).not.toBeNull();
  });

  test('shows only the files of a message that is only files, with no empty bubble', async () => {
    const { container, findByText } = reload([
      {
        id: 'u1',
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'file', provider: 'bureau', value: 'mine-1', mimeType: 'image/png' },
          },
        ],
      },
      { id: 'a1', role: 'assistant', content: 'Seen.' },
    ]);

    await findByText('Seen.');

    await waitFor(() =>
      expect(container.querySelector('img[src="/bureau/assets/mine-1/content"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll('.chat-message-wrapper[data-role="user"]')).toHaveLength(0);
  });

  const TOOL_STEP_ASSET = { index: 0, assetId: 'step-image', mediaType: 'image/png' };

  test('shows an asset a step with tool calls and no text returned, after a reload, and keeps the tool call', async () => {
    const { container, findByText } = reload([
      { id: 'u1', role: 'user', content: 'Draw it' },
      {
        id: 'step-0',
        role: 'assistant',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'lookup-order', arguments: '{}' } },
        ],
        metadata: { 'bureau:assetParts': [TOOL_STEP_ASSET] },
      },
      { id: 't1', role: 'tool', toolCallId: 'call-1', content: 'found' },
      { id: 'a2', role: 'assistant', content: 'Done.' },
    ]);

    expect(await findByText('lookup-order')).not.toBeNull();
    await waitFor(() =>
      expect(
        container.querySelector('img[src="/bureau/assets/step-image/content"]'),
      ).not.toBeNull(),
    );
  });

  test('shows an asset a step with tool calls and no text returned, live, and keeps the tool call', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.agents.list': () => ({ agents: [SEER] }) },
      (url) => {
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        if (!url.includes('/agents/')) return undefined;
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
          {
            type: 'TOOL_CALL_START',
            toolCallId: 'call-1',
            toolCallName: 'lookup-order',
            parentMessageId: 'step-0',
          },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '{}' },
          { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
          {
            type: 'CUSTOM',
            name: 'bureau.asset-part',
            value: { messageId: 'step-0', ...TOOL_STEP_ASSET },
          },
          {
            type: 'TOOL_CALL_RESULT',
            messageId: 'r1',
            toolCallId: 'call-1',
            content: 'found',
            role: 'tool',
          },
          { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Done.' },
          { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
          {
            type: 'RUN_FINISHED',
            threadId: 'session-1',
            runId: 'run-1',
            outcome: { type: 'success' },
          },
        ]);
      },
    ).restore;
    landAt('/chat/session-1');
    const { container, findByText } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'seer',
    });
    await findByText('Plan the week');

    await sendMessage(container, 'Draw it');

    expect(await findByText('lookup-order')).not.toBeNull();
    await waitFor(() =>
      expect(
        container.querySelector('img[src="/bureau/assets/step-image/content"]'),
      ).not.toBeNull(),
    );
  });

  /** A session of `seer` whose run announces an image in a reply, then ends as `ending`. */
  const endingRun = (ending: unknown) => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.agents.list': () => ({ agents: [SEER] }) },
      (url) => {
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        if (!url.includes('/agents/')) return undefined;
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
          { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Here it is.' },
          {
            type: 'CUSTOM',
            name: 'bureau.asset-part',
            value: { messageId: 'reply', index: 1, assetId: 'returned-1', mediaType: 'image/png' },
          },
          { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
          ending,
        ]);
      },
    ).restore;
    landAt('/chat/session-1');
    return mount({ sessionId: 'session-1', title: 'Plan the week', agentName: 'seer' });
  };

  test('shows the assets a run announced when it is stopped, on the row the stop leaves', async () => {
    const { container, findByText } = endingRun({
      type: 'RUN_FINISHED',
      threadId: 'session-1',
      runId: 'run-1',
      outcome: { type: 'cancelled' },
    });
    await findByText('Plan the week');

    await sendMessage(container, 'Draw it');

    await findByText('Here it is.');
    await waitFor(() =>
      expect(
        container.querySelector('img[src="/bureau/assets/returned-1/content"]'),
      ).not.toBeNull(),
    );
  });

  test('shows no asset for a run that ends in an error, whose rows the chat rolls back, and says it failed', async () => {
    const { container, findByText, queryByText } = endingRun({
      type: 'RUN_ERROR',
      message: 'The model failed.',
      code: 'UNKNOWN',
    });
    await findByText('Plan the week');

    await sendMessage(container, 'Draw it');

    expect(await findByText('The model failed.')).not.toBeNull();
    expect(queryByText('Here it is.')).toBeNull();
    expect(container.querySelector('img[src="/bureau/assets/returned-1/content"]')).toBeNull();
  });

  test('shows the person’s own attachments on their row after a reload, by kind', async () => {
    const { container, findByText } = reload([
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'text', text: 'Look at these' },
          {
            type: 'image',
            source: { type: 'file', provider: 'bureau', value: 'mine-1', mimeType: 'image/png' },
          },
          {
            type: 'document',
            source: {
              type: 'file',
              provider: 'bureau',
              value: 'mine-2',
              mimeType: 'application/pdf',
            },
          },
        ],
      },
      { id: 'a1', role: 'assistant', content: 'Seen.' },
    ]);

    await findByText('Seen.');

    await waitFor(() => {
      expect(container.querySelector('img[src="/bureau/assets/mine-1/content"]')).not.toBeNull();
      expect(
        container.querySelector('a[href="/bureau/assets/mine-2/content"][download]'),
      ).not.toBeNull();
    });
    expect(container.textContent).toContain('Look at these');
  });
});

describe('a stop before the run’s first event', () => {
  test('shows the turn as stopped and takes no message until the run has been cancelled', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const cancels: string[] = [];
    const stub = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url, init) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      if (url.includes('/cancel')) {
        cancels.push(url);
        return Response.json({ runId: 'native-1', status: 'aborted' });
      }
      if (url.includes('/runs/')) {
        return sse([{ type: 'RUN_ERROR', message: 'over', code: 'RUN_NOT_FOUND' }]);
      }
      if (!url.includes('/agents/')) return undefined;
      starts.push(typeof init?.body === 'string' ? init.body : '');
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await held;
          const started = {
            type: 'RUN_STARTED',
            threadId: 'session-1',
            runId: 'run-1',
            metadata: { '@lostgradient/bureau': { runId: 'native-1', sessionId: 'session-1' } },
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(started)}\n\n`));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    restore = stub.restore;
    landAt('/chat/session-1');
    const { container, findByText, findByRole, queryByText } = mount({
      sessionId: 'session-1',
      title: 'Plan the week',
      agentName: 'assistant',
    });
    await findByText('Plan the week');
    await sendMessage(container, 'Start');
    await waitFor(() => expect(starts).toHaveLength(1));

    await fireEvent.click(await findByRole('button', { name: /stop/i }));

    // The page says the turn is stopped, and its composer takes nothing: Enter sends no follow-up.
    await waitFor(() => expect(queryByText('Stopping…')).not.toBeNull());
    const composer = container.querySelector('textarea');
    expect(composer?.disabled).toBe(true);
    await fireEvent.keyDown(composer!, { key: 'Enter' });
    expect(stub.calls.map((call) => call.method)).not.toContain('bureau.contexts.input');
    expect(starts).toHaveLength(1);
    expect(cancels).toEqual([]);

    release();

    await waitFor(() => expect(cancels).toHaveLength(1));
    await waitFor(() => expect(queryByText('Stopping…')?.textContent ?? null).toBeNull());
    expect(container.querySelector('textarea')?.disabled).toBe(false);
  });
});
