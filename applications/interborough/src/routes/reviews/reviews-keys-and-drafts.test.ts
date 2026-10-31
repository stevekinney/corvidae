/**
 * `/reviews`, the two ways a person could answer the wrong review (COR-1849): a draft typed on one
 * review that survived into the next one opened, and a decision key that landed on a review the
 * person had not yet seen (a held key, a second press behind the first, a dialog open over the page).
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import { HttpClient, type PendingReviewEntry } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import Harness from './reviews-shell.test-harness.svelte';

let stub: BureauWorldStub | undefined;
const realAnimationFrame = globalThis.requestAnimationFrame;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  globalThis.requestAnimationFrame = realAnimationFrame;
});

function open(world: Partial<BureauWorld>) {
  stub = installBureauWorld(emptyBureauWorld(world));
  router.navigate('/reviews', { replace: true });
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-review-row]')];
}

async function openRow(container: HTMLElement, index: number): Promise<void> {
  await waitFor(() => expect(rows(container).length).toBeGreaterThan(index));
  const row = rows(container)[index]!;
  await fireEvent.click(row.querySelector<HTMLElement>('.cinder-selectable-row__primary') ?? row);
}

/** The field the open question is answered in. */
function answerField(container: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    '.ib-review-pane__answer input:not([type="radio"]):not([type="checkbox"]), .ib-review-pane__answer textarea',
  );
  if (field === null) throw new Error('The open question has no field to answer in.');
  return field;
}

function press(key: string, context: { repeat?: boolean; dialogOpen?: boolean } = {}): boolean {
  return shortcuts.handleKey(
    {
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      editable: false,
      ...(context.repeat === undefined ? {} : { repeat: context.repeat }),
    },
    {
      routePattern: '/reviews',
      regions: ['list-detail'],
      ...(context.dialogOpen === undefined ? {} : { dialogOpen: context.dialogOpen }),
    },
    Date.now(),
  );
}

const OLDER = Date.now() - 200_000;
const NEWER = Date.now() - 100_000;

describe('a draft stays with the review it was typed on', () => {
  test('text typed on one question is not sent as the answer to the next', async () => {
    const first = humanWaitFixture({
      id: 'human-wait:run-a:environment:0',
      runId: 'run-a',
      sessionId: 'session-a',
      requestedAt: OLDER,
    });
    const second = humanWaitFixture({
      id: 'human-wait:run-b:environment:0',
      runId: 'run-b',
      sessionId: 'session-b',
      requestedAt: NEWER,
    });
    const { container, getByRole } = open({ reviews: [first, second] });
    await openRow(container, 0);
    await waitFor(() => expect(answerField(container)).toBeDefined());
    await fireEvent.input(answerField(container), { target: { value: 'production' } });

    await openRow(container, 1);
    await waitFor(() =>
      expect(
        container.querySelector('[data-review="human-wait:run-b:environment:0"]'),
      ).not.toBeNull(),
    );
    expect(answerField(container).value).toBe('');
    await fireEvent.click(getByRole('button', { name: 'Send' }));
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });

  test('a secret draft is not shown in plain text on the next question', async () => {
    const secret = humanWaitFixture({
      id: 'human-wait:run-a:token:0',
      runId: 'run-a',
      sessionId: 'session-a',
      requestedAt: OLDER,
      inputSchema: { type: 'string', title: 'Token', 'x-secret': true },
    });
    const plain = humanWaitFixture({
      id: 'human-wait:run-b:environment:0',
      runId: 'run-b',
      sessionId: 'session-b',
      requestedAt: NEWER,
    });
    const { container } = open({ reviews: [secret, plain] });
    await openRow(container, 0);
    await waitFor(() => expect(answerField(container).type).toBe('password'));
    await fireEvent.input(answerField(container), { target: { value: 'hunter2' } });

    await openRow(container, 1);
    await waitFor(() =>
      expect(
        container.querySelector('[data-review="human-wait:run-b:environment:0"]'),
      ).not.toBeNull(),
    );
    expect(answerField(container).type).not.toBe('password');
    expect(answerField(container).value).toBe('');
    expect(container.innerHTML).not.toContain('hunter2');
  });

  test('feedback typed on one workflow review is not carried to the next', async () => {
    const review = (reviewId: string, createdAt: number): PendingReviewEntry => ({
      status: 'pending',
      reviewId,
      workflowId: `wf_${reviewId}`,
      artifact: { sections: { headline: 'Ship it' } },
      reviewType: 'Copy review',
      reviewers: [],
      allowPartial: true,
      createdAt,
    });
    const { container, getByLabelText, findByLabelText } = open({
      weftReviews: [review('review-a', OLDER), review('review-b', NEWER)],
    });
    await openRow(container, 0);
    await fireEvent.input(await findByLabelText(/Feedback/), { target: { value: 'Too long.' } });

    await openRow(container, 1);
    await waitFor(() => expect(container.textContent).toContain('wf_review-b'));
    expect((getByLabelText(/Feedback/) as HTMLTextAreaElement).value).toBe('');
  });
});

describe('a key never decides a review the person has not seen', () => {
  const first = toolApprovalFixture({
    id: 'approval:run-1:call-1',
    runId: 'run-1',
    requestedAt: OLDER,
  });
  const second = toolApprovalFixture({
    id: 'approval:run-2:call-2',
    runId: 'run-2',
    requestedAt: NEWER,
  });

  test('a held key decides once at most, and not on its repeats', async () => {
    const { container, findByRole } = open({ reviews: [first, second] });
    await openRow(container, 0);
    await findByRole('button', { name: 'Approve' });

    expect(press('a', { repeat: true })).toBe(false);
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
    press('a');
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(press('a', { repeat: true })).toBe(false);
    expect(press('a', { repeat: true })).toBe(false);
    expect(stub?.callsTo('bureau.reviews.resolve')).toHaveLength(1);
  });

  test('a second press behind the first waits for the next review to be seen', async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    const { container, findByRole } = open({ reviews: [first, second] });
    await openRow(container, 0);
    await findByRole('button', { name: 'Approve' });

    press('a');
    press('a');
    await waitFor(() =>
      expect(container.querySelector(`[data-review="${second.id}"]`)).not.toBeNull(),
    );
    // The first decision is settled, so only the wait for the next review to be seen holds the key.
    await waitFor(() =>
      expect(container.querySelector('.ib-review-pane button')?.hasAttribute('disabled')).toBe(
        false,
      ),
    );
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    // The next review is open but has not been painted: the key acts on nothing.
    press('a');
    await quietFor(100);
    expect(stub?.callsTo('bureau.reviews.resolve')).toHaveLength(1);

    // Painted, a fresh press decides it.
    while (frames.length > 0) frames.shift()?.(0);
    await findByRole('button', { name: 'Approve' });
    press('a');
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(2));
    expect(stub?.callsTo('bureau.reviews.resolve')[1]?.params).toMatchObject({ id: second.id });
  });

  test('nothing is decided while a dialog is open over the page', async () => {
    const { container, findByRole } = open({ reviews: [first] });
    await openRow(container, 0);
    await findByRole('button', { name: 'Approve' });

    expect(press('a', { dialogOpen: true })).toBe(false);
    expect(press('d', { dialogOpen: true })).toBe(false);
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
    press('a', { dialogOpen: false });
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
  });
});
