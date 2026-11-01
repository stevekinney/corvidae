/**
 * Try it, when the run parks: a question the agent asks is shown in the drawer, so the person
 * answers it knowingly; a tool that asks first ends the trial and says why, because the drawer has
 * no approval to give and the next message would answer it unseen. An agent with `references` is
 * tried without them, and the drawer names them.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import {
  catalogFixture,
  installBureauStub,
  readyAgent,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

const copy = AGENT_EDITOR_COPY;
const TRIED = { contextId: 'ctx-1', agentName: 'try:one', taskId: 'task-1' };

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const QUESTION = {
  id: 'human-wait:native-1:environment:0',
  reason: 'human-wait',
  message: 'Which environment should the release go to?',
  responseSchema: {
    type: 'object',
    properties: {
      decision: { enum: ['approve', 'deny', 'reject'] },
      answer: { type: 'string', enum: ['staging', 'production'] },
    },
    required: ['decision'],
  },
};

const APPROVAL = {
  id: 'approval:native-1:call-refund',
  reason: 'tool-approval',
  toolCallId: 'call-refund',
  message: 'Refund order-1001?',
};

/** The events of the tried run, parked on `interrupt`; an approval comes with the call it is for. */
function parkedRun(interrupt: unknown, withCall: boolean): readonly unknown[] {
  return [
    { type: 'RUN_STARTED', threadId: TRIED.contextId, runId: 'run-1' },
    ...(withCall
      ? [
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
        ]
      : []),
    {
      type: 'RUN_FINISHED',
      threadId: TRIED.contextId,
      runId: 'run-1',
      outcome: { type: 'interrupt', interrupts: [interrupt] },
    },
  ];
}

/** The bodies of the runs the page started after the first, which carry an answer. */
let resumes: { resume?: unknown }[] = [];
let stub: BureauStub | undefined;
let restoreRun: (() => void) | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/', { replace: true });
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  restoreRun?.();
  restoreRun = undefined;
});

/** A Bureau whose tried run is parked on `interrupt`; the editor shows `agent`. */
function park(interrupt: unknown, withCall: boolean, agent = readyAgent()): BureauStub {
  resumes = [];
  restoreRun = installFetchImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/agents/')) {
      resumes.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return sse([
        { type: 'RUN_STARTED', threadId: TRIED.contextId, runId: 'run-2' },
        {
          type: 'RUN_FINISHED',
          threadId: TRIED.contextId,
          runId: 'run-2',
          outcome: { type: 'success' },
        },
      ]);
    }
    if (url.endsWith('/messages')) {
      return Response.json({ threadId: TRIED.contextId, messages: [] });
    }
    if (url.includes('/threads/')) return sse(parkedRun(interrupt, withCall));
    return new Response('Not found', { status: 404 });
  });
  stub = installBureauStub(
    {
      'bureau.agents.catalog': () => catalogFixture(),
      'bureau.agents.definitions.get': () => agent,
      'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
      'bureau.agents.versions.list': () => ({ versions: [] }),
      'bureau.agents.try': () => TRIED,
      'bureau.contexts.delete': (params) => ({
        contextId: params['contextId'],
        receipt: 'applied',
      }),
    },
    { passThrough: true },
  );
  return stub;
}

function mount() {
  return render(Harness, { props: { id: 'researcher' } } as never);
}

type View = ReturnType<typeof mount>;

async function startChat(view: View): Promise<void> {
  await fireEvent.click(await view.findByRole('button', { name: copy.try.action }));
  await fireEvent.input(await view.findByRole('textbox', { name: copy.try.messageLabel }), {
    target: { value: 'Refund it' },
  });
  await fireEvent.click(view.getByRole('button', { name: copy.try.send }));
}

describe('Try it, parked on a question', () => {
  test('shows the question in the drawer', async () => {
    park(QUESTION, false);
    const view = mount();
    await startChat(view);

    const question = await view.findByTestId('agent-try-question');
    expect(question.textContent).toContain(QUESTION.message);
    // The trial goes on: it is waiting for the answer, not over.
    expect(view.getByRole('region', { name: copy.try.chatLabel })).not.toBeNull();
    expect(view.queryByTestId('agent-try-failure')).toBeNull();
  });

  test('answers it from the drawer, and the run goes on with the answer', async () => {
    park(QUESTION, false);
    const view = mount();
    await startChat(view);

    await fireEvent.click(await view.findByRole('button', { name: 'production' }));

    await waitFor(() => expect(resumes).toHaveLength(1));
    expect(JSON.stringify(resumes[0]?.resume)).toContain('production');
  });
});

describe('Try it, parked on an approval', () => {
  test('ends the trial and says why, instead of parking unseen', async () => {
    const calls = park(APPROVAL, true);
    const view = mount();
    await startChat(view);

    const failure = await view.findByTestId('agent-try-failure');
    expect(failure.textContent).toBe(copy.try.approvalEnded);
    expect(view.queryByRole('region', { name: copy.try.chatLabel })).toBeNull();
    await waitFor(() =>
      expect(calls.callsTo('bureau.contexts.delete')).toEqual([
        { method: 'bureau.contexts.delete', params: { contextId: 'ctx-1' } },
      ]),
    );
  });
});

describe('Try it, on an agent with references', () => {
  test('names the documents it runs without, and sends none', async () => {
    const file = readyAgent();
    const calls = park(QUESTION, false, {
      ...file,
      definition:
        file.definition === null
          ? null
          : { ...file.definition, references: ['notes.md', 'style.md'] },
    });
    const view = mount();
    await fireEvent.click(await view.findByRole('button', { name: copy.try.action }));

    const note = await view.findByTestId('agent-try-left-out');
    expect(note.textContent?.trim()).toBe(copy.try.leftOut(['notes.md', 'style.md']));

    await fireEvent.input(await view.findByRole('textbox', { name: copy.try.messageLabel }), {
      target: { value: 'Hi' },
    });
    await fireEvent.click(view.getByRole('button', { name: copy.try.send }));
    await view.findByRole('region', { name: copy.try.chatLabel });
    const sent = calls.callsTo('bureau.agents.try')[0]?.params['definition'];
    expect(sent).not.toHaveProperty('references');
  });
});
