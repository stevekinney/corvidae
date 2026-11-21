/**
 * Input and output: the message in and the reply out of a chat run, the prompt and
 * result, and a workflow's input and output as payload cards that share one Fields or JSON choice,
 * with a value that names a chat, an agent or a run linked under its own name.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { WorkflowState } from '@lostgradient/weft';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import { TASK_COPY } from '../../../app/copy/tasks.ts';
import { contextDetailFixture, taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { SCHEDULER_ACTOR } from '../../../lib/bureau-tasks.ts';
import { bureau, landAt } from '../../chat/pages.test-support.ts';
import Harness from './run-input-output.test-harness.svelte';
import { payloadViewPreference } from './run-payload-view.svelte.ts';

const copy = RUN_DETAIL_COPY.io;

let restore: (() => void) | undefined;

beforeEach(() => {
  payloadViewPreference.choose('fields');
  // Every request is answered, so a run's thread and the things a payload names read as not found.
  restore = bureau({}, () => new Response('{}', { status: 404 })).restore;
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_1',
    type: 'order-fulfillment',
    status: 'running',
    input: { orderId: 'ord-1' },
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

/** Serves the chat thread of `session-1`: one message in, then a row of the run `run-1`. */
function serveThread(text: string) {
  restore?.();
  restore = bureau({}, (url) => {
    if (!url.endsWith('/messages')) return undefined;
    return Response.json({
      threadId: 'session-1',
      messages: [
        { id: 'm1', role: 'user', content: text },
        { id: 'run-1:step:0', role: 'assistant', content: 'Done.' },
      ],
    });
  }).restore;
}

describe('a workflow’s input and output', () => {
  test('a running workflow says its output appears when the run finishes, and draws no output card (54p)', () => {
    const { getByText, queryByRole, getByRole } = render(Harness, {
      props: { workflow: workflow({ status: 'running' }) },
    });

    expect(getByText(copy.appearsWhenFinished)).not.toBeNull();
    expect(getByRole('group', { name: copy.input })).not.toBeNull();
    expect(queryByRole('group', { name: copy.output })).toBeNull();
  });

  test('the description says what a running workflow will produce, and what a finished one produced (54p, 55c)', () => {
    const running = render(Harness, { props: { workflow: workflow({ status: 'running' }) } });
    expect(running.container.querySelector('[data-section="input-output"]')?.textContent).toContain(
      'What this run was started with, and what it will produce.',
    );
    running.unmount();

    const failed = render(Harness, { props: { workflow: workflow({ status: 'failed' }) } });
    expect(failed.container.querySelector('[data-section="input-output"]')?.textContent).toContain(
      'What this run was started with, and what it produced.',
    );
  });

  // COR-2329: the page drew a spinner of its own; it is Cinder's, hidden behind the sentence.
  test('a running workflow’s note turns with Cinder’s spinner, which the sentence speaks for', () => {
    const { getByText } = render(Harness, {
      props: { workflow: workflow({ status: 'running' }) },
    });
    const note = getByText(copy.appearsWhenFinished);
    const spinner = note.querySelector('.cinder-spinner');
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('data-cinder-size')).toBe('sm');
    expect(spinner?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(note.querySelector('.ib-run__spinner')).toBeNull();
  });

  test('a completed workflow shows an Input card and an Output card side by side', () => {
    const { getByRole, container } = render(Harness, {
      props: { workflow: workflow({ status: 'completed', result: { ok: true } }) },
    });

    expect(getByRole('group', { name: copy.input })).not.toBeNull();
    expect(getByRole('group', { name: copy.output })).not.toBeNull();
    expect(container.querySelectorAll('.ib-run__payloads')).toHaveLength(1);
  });

  test('a failed workflow leads with a Cinder Alert before its input, and keeps its cause out of raw JSON', () => {
    const { container, getByRole, getByText } = render(Harness, {
      props: {
        workflow: workflow({
          status: 'failed',
          failureCategory: 'timeout',
          error: 'the activity took too long',
        }),
      },
    });

    const alert = container.querySelector<HTMLElement>(
      '[data-run-failure][data-cinder-variant="danger"]',
    );
    const input = getByRole('group', { name: copy.input });
    if (alert === null) throw new Error('Expected the run failure alert');
    expect(alert.textContent).toContain('timeout');
    expect(alert.textContent).toMatch(/exceeded its configured deadline/);
    expect(alert.textContent).toContain('the activity took too long');
    expect(alert.textContent).not.toContain('{');
    expect(alert.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getByText(copy.noOutputFailed)).not.toBeNull();
  });

  test('a cancelled workflow says it has no output', () => {
    const { getByText } = render(Harness, {
      props: { workflow: workflow({ status: 'cancelled' }) },
    });

    expect(getByText(copy.noOutputEnded('was cancelled'))).not.toBeNull();
  });

  test('a timed-out workflow says it has no output', () => {
    const { getByText } = render(Harness, {
      props: { workflow: workflow({ status: 'timed-out' }) },
    });

    expect(getByText(copy.noOutputEnded('timed out'))).not.toBeNull();
  });

  test('a failed workflow with no failure category shows neither the badge nor the explanation', () => {
    const { container, getByText, queryByText } = render(Harness, {
      props: { workflow: workflow({ status: 'failed', error: 'boom' }) },
    });

    expect(
      container.querySelector('[data-run-failure][data-cinder-variant="danger"]'),
    ).not.toBeNull();
    expect(getByText('boom')).not.toBeNull();
    expect(queryByText(/could not be classified/)).toBeNull();
  });

  test('a failed workflow with an error stack renders a collapsible trigger for it', () => {
    // Cinder's `Collapsible` toggles via a `transition:` directive whose
    // lifecycle event dispatch happy-dom can't construct cross-realm — no
    // test in this repo drives a transitioning Cinder trigger via
    // `fireEvent.click` (see `advanced-options.test.ts`'s identical note).
    // This only asserts the trigger itself renders (the `errorStack.length >
    // 0` branch), not the post-expand content.
    const { getByRole } = render(Harness, {
      props: {
        workflow: workflow({
          status: 'failed',
          error: 'boom',
          errorStack: 'Error: boom\n    at doThing (file.ts:1:1)',
        }),
      },
    });

    expect(getByRole('button', { name: 'Show full stack trace' })).not.toBeNull();
  });

  test('the Bureau’s record of a workflow file’s run shows its trigger, result and error', () => {
    const view = render(Harness, {
      props: {
        record: {
          id: 'run-1',
          workflow: 'e2e-approval',
          workflowVersion: 'sha256:abc',
          status: 'failed',
          createdAt: '2026-10-31T11:26:19.437Z',
          updatedAt: '2026-10-31T11:26:20.437Z',
          trigger: { kind: 'signal' },
          result: { done: false },
          error: 'The approval was refused.',
        },
      },
    });

    expect(view.getByRole('group', { name: copy.input })).not.toBeNull();
    expect(view.getByRole('group', { name: copy.output })).not.toBeNull();
    expect(view.getByText('The approval was refused.')).not.toBeNull();
  });
});

describe('the Fields or JSON choice of the cards', () => {
  test('is one value: choosing JSON on a card changes every card and is announced politely', async () => {
    const view = render(Harness, {
      props: { workflow: workflow({ status: 'completed', result: { ok: true } }) },
    });
    const status = view.getByTestId('payload-view-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent?.trim()).toBe('');

    const [first] = view.getAllByRole('radio', { name: 'JSON' });
    await fireEvent.click(first as HTMLElement);

    await waitFor(() => expect(status.textContent?.trim()).toBe(copy.viewAnnouncement.json));
    expect(payloadViewPreference.view).toBe('json');
    for (const radio of view.getAllByRole('radio', { name: 'JSON' })) {
      expect(radio.getAttribute('aria-checked')).toBe('true');
    }
  });

  test('is remembered by the next card that mounts', () => {
    payloadViewPreference.choose('json');

    const view = render(Harness, {
      props: { workflow: workflow({ status: 'completed', result: { ok: true } }) },
    });

    for (const radio of view.getAllByRole('radio', { name: 'JSON' })) {
      expect(radio.getAttribute('aria-checked')).toBe('true');
    }
  });
});

describe('a value that names something in Interborough', () => {
  test('links a known chat, agent and run under their own names and leaves the rest as text', async () => {
    restore?.();
    restore = bureau({
      'bureau.contexts.get': () =>
        contextDetailFixture('chat-1', { title: 'Please refund order 4471…' }),
      'bureau.agents.list': () => ({
        agents: [
          {
            name: 'tool-runner',
            displayName: 'tool-runner',
            description: null,
            definitionRevision: 1,
            kind: 'code',
            a2a: false,
          },
        ],
      }),
      'bureau.tasks.get': () => taskFixture({ id: 'run-8f2c0d71' }),
    }).restore;
    const view = render(Harness, {
      props: {
        workflow: workflow({
          input: {
            chatId: 'chat-1',
            agent: 'tool-runner',
            orderId: '4471',
            runId: 'run-8f2c0d71',
          },
        }),
      },
    });

    const chat = await view.findByRole('link', { name: 'Please refund order 4471…' });
    expect(chat.getAttribute('href')).toContain('chat-1');
    const awaited236 = await view.findByRole('link', { name: 'Tool runner' });
    expect(awaited236.getAttribute('href')).toContain('tool-runner');
    const awaited239 = await view.findByRole('link', { name: 'Run 8f2c' });
    expect(awaited239.getAttribute('href')).toContain('run-8f2c0d71');
    expect(view.getByText('4471')).not.toBeNull();
    expect(view.getAllByRole('link')).toHaveLength(3);
  });

  test('leaves an identifier the Bureau does not have as plain text, never a dead link', async () => {
    const view = render(Harness, {
      props: { workflow: workflow({ input: { chatId: 'chat-gone' } }) },
    });

    expect(await view.findByText('chat-gone')).not.toBeNull();
    expect(view.queryByRole('link')).toBeNull();
  });
});

describe('the message in and the reply out of a chat run', () => {
  test('shows the message that started the run, from you, with when it was sent', async () => {
    serveThread('Can you look up order 4468?');
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({ id: 'run-1', contextId: 'session-1', status: 'completed' }),
        startedAt: Date.parse('2026-10-19T08:00:00.000Z'),
      },
    });

    await waitFor(() =>
      expect(view.getByTestId('run-message-in').textContent).toBe('Can you look up order 4468?'),
    );
    expect(view.getByRole('heading', { level: 3, name: copy.messageIn })).not.toBeNull();
    expect(view.getByText(copy.fromYou)).not.toBeNull();
    expect(view.getByText(/^Sent in the chat, /)).not.toBeNull();
    expect(view.getByRole('heading', { level: 3, name: copy.replyOut })).not.toBeNull();
  });

  test('a run waiting on a question says it is waiting for the answer, in place of a reply (54w)', async () => {
    serveThread('Ship the release notes fix.');
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({
          id: 'run-1',
          contextId: 'session-1',
          agentName: 'request-human-input',
          status: 'input-required',
          openWaits: [{ kind: 'human-wait', reviewId: 'review-1', signalName: 'environment' }],
        }),
        startedAt: Date.parse('2026-10-19T08:00:00.000Z'),
      },
    });

    expect(view.getByText(copy.noReplyWaitingAnswer)).not.toBeNull();
    expect(view.getByText(copy.fromAgent('Request human input'))).not.toBeNull();
    await waitFor(() =>
      expect(view.getByTestId('run-message-in').textContent).toBe('Ship the release notes fix.'),
    );
  });

  test('a run waiting on an approval says it is waiting for the approval (55s)', () => {
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({
          id: 'run-1',
          contextId: 'session-1',
          status: 'input-required',
          openWaits: [{ kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' }],
        }),
      },
    });

    expect(view.getByText(copy.noReplyWaitingApproval)).not.toBeNull();
    expect(view.queryByText(copy.noReplyWaitingAnswer)).toBeNull();
  });

  test('says the message is not kept when the thread cannot be read', async () => {
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: { task: taskFixture({ id: 'run-1', contextId: 'session-1' }) },
    });

    expect(await view.findByText(copy.noMessageIn)).not.toBeNull();
  });

  test('a run a schedule started reads Prompt and Result, with no chat to send it in', async () => {
    serveThread('Summarize yesterday’s chats and open reviews.');
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({
          id: 'run-1',
          contextId: 'session-1',
          status: 'completed',
          actor: SCHEDULER_ACTOR,
        }),
        startedAt: Date.parse('2026-10-19T08:00:00.000Z'),
      },
    });

    expect(view.getByRole('heading', { level: 3, name: copy.prompt })).not.toBeNull();
    expect(view.getByRole('heading', { level: 3, name: copy.result })).not.toBeNull();
    expect(view.getByText(copy.fromSchedule)).not.toBeNull();
    expect(view.getByText(copy.scheduleDescription)).not.toBeNull();
    expect(view.queryByText(/^Sent in the chat, /)).toBeNull();
  });

  test('a goal’s attempt reads the goal’s Prompt, from the goal, never from you or sent in a chat', async () => {
    serveThread('Summarize open refunds.');
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({
          id: 'run-1',
          contextId: 'session-1',
          status: 'completed',
          origin: { kind: 'goal', goalRunId: 'goal-1', attemptId: 'attempt-1' },
        }),
        startedAt: Date.parse('2026-10-19T08:00:00.000Z'),
      },
    });

    await waitFor(() =>
      expect(view.getByTestId('run-message-in').textContent).toBe('Summarize open refunds.'),
    );
    expect(view.getByRole('heading', { level: 3, name: copy.prompt })).not.toBeNull();
    expect(view.getByText(copy.fromGoal)).not.toBeNull();
    expect(view.getByText(copy.goalDescription)).not.toBeNull();
    expect(view.queryByText(copy.fromYou)).toBeNull();
    expect(view.queryByText(/^Sent in the chat, /)).toBeNull();
  });

  test('a task’s answer is shown as the Markdown it was rendered to, and says when it was cut short', () => {
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({ id: 'run-1', status: 'working' }),
        answer: 'The release is **ready**.',
        answerTruncated: true,
      },
    });

    expect(view.container.querySelector('.ib-run__answer strong')?.textContent).toBe('ready');
    // Paragraphs keep Cinder's Markdown rhythm instead of running together.
    expect(view.container.querySelector('.ib-run__answer')?.classList).toContain(
      'cinder-markdown-content',
    );
    expect(view.getByText('The answer was cut short.')).not.toBeNull();
    expect(view.queryByText('The agent has not answered yet.')).toBeNull();
    expect(view.getByText(copy.fromAgent('Assistant'))).not.toBeNull();
  });

  test('holds a long reply to a few lines until Show all opens it', async () => {
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({ id: 'run-1', status: 'completed' }),
        answer: 'Four refunds are waiting for approval. '.repeat(30),
      },
    });
    const reply = view.container.querySelector('.ib-run__answer') as HTMLElement;
    expect(reply.hasAttribute('data-clamped')).toBe(true);

    await fireEvent.click(view.getByRole('button', { name: copy.showAll }));

    expect(reply.hasAttribute('data-clamped')).toBe(false);
    expect(view.getByRole('button', { name: copy.showLess }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  test('a short reply has nothing to open', () => {
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({ id: 'run-1', status: 'completed' }),
        answer: 'Done.',
      },
    });

    expect(view.queryByRole('button', { name: copy.showAll })).toBeNull();
  });

  test('offers the raw payloads under the reply only where the page can open them', async () => {
    landAt('/runs/run-1');
    let opened = 0;
    const view = render(Harness, {
      props: {
        task: taskFixture({ id: 'run-1', status: 'completed' }),
        answer: 'Done.',
        onShowRaw: () => (opened += 1),
      },
    });

    expect(view.getByText(copy.deliveredToChat, { exact: false })).not.toBeNull();
    // COR-2489 design round: the action follows the note on its line, and takes a line of its own
    // only when it wraps (tasks.css pulls the row back so a wrapped label starts on the text edge).
    const showRaw = view.getByRole('button', { name: copy.showRawPayloads });
    const row = showRaw.closest('[data-run-delivered]');
    expect(row?.classList.contains('ib-run__delivered')).toBe(true);
    expect(row?.querySelector(':scope > .ib-run__note')?.textContent).toBe(copy.deliveredToChat);
    expect(showRaw.parentElement).toBe(row as HTMLElement);
    expect(showRaw.hasAttribute('data-cinder-flush')).toBe(false);
    await fireEvent.click(showRaw);

    expect(opened).toBe(1);
  });

  test('the raw payloads action takes its own line only when it wraps, its words on the text edge', () => {
    const css = readFileSync(new URL('../../../styles/tasks.css', import.meta.url), 'utf8');
    const rule = (selector: string): string => {
      const start = css.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start));
    };
    const row = rule('.ib-run__delivered');
    expect(row).toContain('flex-wrap: wrap;');
    expect(row).toContain(
      '--_ib-run-delivered-pull: calc(var(--cinder-button-padding-x-sm) + 1px);',
    );
    expect(row).toContain('margin-inline-start: calc(-1 * var(--_ib-run-delivered-pull));');
    expect(rule('.ib-run__delivered > .ib-run__note')).toContain(
      'padding-inline-start: var(--_ib-run-delivered-pull);',
    );
  });

  test('a task with no answer says whether it is still to come', () => {
    landAt('/runs/run-1');
    const running = render(Harness, {
      props: { task: taskFixture({ id: 'run-1', status: 'working' }) },
    });
    expect(running.getByText(TASK_COPY.noAnswerYet)).not.toBeNull();
    running.unmount();

    const over = render(Harness, {
      props: { task: taskFixture({ id: 'run-1', status: 'completed' }) },
    });
    expect(over.getByText(TASK_COPY.noAnswer)).not.toBeNull();
  });

  test('a task that cannot be followed live says so under its answer', () => {
    landAt('/runs/run-1');
    const view = render(Harness, {
      props: {
        task: taskFixture({ id: 'run-1', status: 'working' }),
        followState: 'reconnecting',
      },
    });

    expect(view.getByRole('status').textContent).toContain('Reconnecting');
  });
});
