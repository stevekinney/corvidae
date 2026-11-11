/**
 * `/reviews`, an open question (COR-2014): a choice is picked from a grid that carries the
 * payload's own descriptions, with one field below it for an answer of your own; picking sends it
 * after a five-second Undo window held inline in the question, and a structured answer is committed
 * by "Send answer" in the footer, beside what the agent does next.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { REVIEWS_COPY } from '../../app/copy.ts';
import { setAnswerUndoMilliseconds } from '../../lib/answer-undo.ts';
import { humanWaitFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import Harness from './reviews-shell.test-harness.svelte';

let stub: BureauWorldStub | undefined;
let restoreWindow: (() => void) | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  restoreWindow?.();
  restoreWindow = undefined;
  if (jest.isFakeTimers()) {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
  stub?.restore();
  stub = undefined;
});

const RELEASE = humanWaitFixture({
  sessionId: 'session-2',
  inputSchema: {
    anyOf: [{ enum: ['staging', 'production'] }, { type: 'string', maxLength: 500 }],
    'x-allowOther': true,
    'x-labels': { staging: 'Staging', production: 'Production' },
    'x-descriptions': {
      staging: 'Deploys to the staging site',
      production: 'Deploys to the live site',
    },
  },
});

const DETAILS = humanWaitFixture({
  id: 'human-wait:run-3:details:0',
  runId: 'run-3',
  sessionId: 'session-3',
  prompt: 'Confirm the release details',
  inputSchema: {
    type: 'object',
    properties: {
      environment: { type: 'string', title: 'Environment', enum: ['staging', 'production'] },
      version: { type: 'string', title: 'Version' },
    },
    required: ['environment', 'version'],
  },
});

function respondsApplied(review: typeof RELEASE): void {
  stub?.on('bureau.tasks.respond', () => ({
    taskId: review.runId,
    messageId: 'm',
    reviewId: review.id,
    kind: 'human-wait',
    decision: 'approve',
    receipt: 'applied',
  }));
}

async function open(review: typeof RELEASE) {
  stub = installBureauWorld(emptyBureauWorld({ reviews: [review] }));
  router.navigate('/reviews', { replace: true });
  const view = render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
  await waitFor(() => expect(view.container.querySelectorAll('[data-review-row]').length).toBe(1));
  const row = view.container.querySelector<HTMLElement>('[data-review-row]')!;
  await fireEvent.click(row.querySelector<HTMLElement>('.cinder-selectable-row__primary') ?? row);
  await waitFor(() => expect(view.container.querySelector('.chat-question')).not.toBeNull());
  return view;
}

/** Moves the fake clock, then lets the promise continuations that follow settle. */
async function elapse(milliseconds: number): Promise<void> {
  jest.advanceTimersByTime(milliseconds);
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

describe('an open question with choices', () => {
  test('draws the payload’s own descriptions, one field for your own answer, and the footer', async () => {
    const { container, getByText, getByPlaceholderText, getByRole } = await open(RELEASE);

    expect(getByText('Staging')).not.toBeNull();
    expect(getByText('Deploys to the staging site')).not.toBeNull();
    expect(getByText('Production')).not.toBeNull();
    expect(getByText('Deploys to the live site')).not.toBeNull();
    expect(getByPlaceholderText('Choose an answer above, or type your own…')).not.toBeNull();
    expect(getByRole('button', { name: 'Answer' }).hasAttribute('disabled')).toBe(true);
    const footer = container.querySelector('.ib-review-pane__footer');
    expect(footer?.textContent?.trim()).toBe('The agent continues as soon as you answer.');
    // Nothing in the footer commits a choice: the pick is the answer.
    expect(footer?.querySelector('button')).toBeNull();
  });

  test('sends your own answer from the field, at once', async () => {
    const { getByPlaceholderText, getByRole } = await open(RELEASE);
    respondsApplied(RELEASE);

    await fireEvent.input(getByPlaceholderText('Choose an answer above, or type your own…'), {
      target: { value: 'canary' },
    });
    await fireEvent.click(getByRole('button', { name: 'Answer' }));

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({ answer: 'canary' });
  });

  test('holds a picked choice for five seconds with one inline Undo, then sends it', async () => {
    restoreWindow = setAnswerUndoMilliseconds(5000);
    const view = await open(RELEASE);
    respondsApplied(RELEASE);
    jest.useFakeTimers();

    await fireEvent.click(view.getByRole('button', { name: /Staging/ }));
    const status = view.container.querySelector('.chat-question-status');
    expect(status?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Answered Staging Undo (5 s)');
    expect(status?.querySelector('.chat-question-status-text')?.textContent).toBe(
      'Answered Staging',
    );
    expect(view.getAllByRole('button', { name: /Undo/ })).toHaveLength(1);
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);

    await elapse(4800);
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
    await elapse(300);
    jest.useRealTimers();
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({ answer: 'staging' });
  });

  test('Undo takes the pick back and sends nothing', async () => {
    restoreWindow = setAnswerUndoMilliseconds(5000);
    const view = await open(RELEASE);
    respondsApplied(RELEASE);
    jest.useFakeTimers();

    await fireEvent.click(view.getByRole('button', { name: /Production/ }));
    await fireEvent.click(view.getByRole('button', { name: /Undo/ }));
    await elapse(20000);

    expect(view.container.querySelector('.chat-question-status')).toBeNull();
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });
});

describe('an open question with a structured answer', () => {
  test('is committed by Send answer in the footer; the form has no button of its own', async () => {
    const { container, getByLabelText, getByRole } = await open(DETAILS);
    respondsApplied(DETAILS);

    const form = container.querySelector<HTMLFormElement>('form.cinder-schema-form');
    expect(form?.querySelector('[type="submit"]')).toBeNull();
    const send = getByRole('button', { name: REVIEWS_COPY.sendAnswer });
    expect(form?.id).toBeTruthy();
    expect(send.getAttribute('form')).toBe(form?.id ?? null);
    expect(container.querySelector('.ib-review-pane__footer')?.textContent).toContain(
      'The agent continues as soon as you answer.',
    );

    await fireEvent.input(getByLabelText(/Version/), { target: { value: '2.4' } });
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });
});
