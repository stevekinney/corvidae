/**
 * `/reviews`: the Bureau's pending reviews and the engine's in one list, with the decision forms
 * each kind needs, over a Bureau that answers from a table (`bureau-world.test-support.ts`).
 */
import { HttpClient, type PendingReviewEntry, type ReviewListEntry } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { REVIEWS_COPY } from '../../app/copy.ts';
import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
import Harness from './reviews-shell.test-harness.svelte';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

export function weftPending(overrides: Partial<PendingReviewEntry> = {}): PendingReviewEntry {
  return {
    status: 'pending',
    reviewId: 'weft-review-1',
    workflowId: 'wf_4a9f8c31e7b2d05a6f912c10',
    artifact: {},
    reviewType: 'Contract approval',
    reviewers: ['ops@example.com'],
    allowPartial: false,
    createdAt: Date.now() - 60_000,
    timeout: 3_600_000,
    ...overrides,
  };
}

function open(
  world: Partial<BureauWorld> = {},
  scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES,
) {
  stub = installBureauWorld(emptyBureauWorld(world));
  router.navigate('/reviews', { replace: true });
  return render(Harness, {
    props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes },
  } as never);
}

const APPROVAL = toolApprovalFixture({ requestedAt: Date.now() - 120_000 });
const QUESTION = humanWaitFixture({ sessionId: 'session-2', requestedAt: Date.now() - 90_000 });

function countOf(container: HTMLElement): string | undefined {
  return container
    .querySelector('.weft-reviews-inbox__count')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.weft-reviews-inbox__list > li')];
}

describe('the reviews page', () => {
  test('lists the Bureau’s reviews and the engine’s in one list, with one count', async () => {
    const { container } = open({
      reviews: [APPROVAL, QUESTION],
      weftReviews: [weftPending()],
    });
    await waitFor(() => expect(rows(container).length).toBe(3));
    expect(container.querySelector('h1')?.textContent).toBe('Reviews');
    expect(countOf(container)).toBe('3 pending');
    // The longest-waiting first, across both sources.
    expect(rows(container)[0]?.dataset['kind'] ?? rows(container)[0]?.textContent).toBeDefined();
    expect(rows(container)[0]?.textContent).toContain('issue-refund');
    expect(rows(container)[2]?.textContent).toContain('Contract approval');
  });

  test('has no Archive, because no operation lists the Bureau’s resolved reviews', async () => {
    const { container, queryByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(queryByRole('radio', { name: 'Archive' })).toBeNull();
    expect(container.textContent).not.toContain('Archive');
  });

  test('reads the engine’s reviews only when the principal holds reviews:read', async () => {
    const without = open(
      { reviews: [APPROVAL, QUESTION], weftReviews: [weftPending()] },
      AUTHORIZATION_SCOPES.filter((scope) => scope !== 'reviews:read'),
    );
    await waitFor(() => expect(rows(without.container).length).toBe(2));
    expect(stub?.weftRequests).toEqual([]);
    expect(without.container.textContent).not.toContain('Contract approval');
    without.unmount();
    stub?.restore();

    const withScope = open({
      reviews: [APPROVAL, QUESTION],
      weftReviews: [weftPending()],
    });
    await waitFor(() => expect(rows(withScope.container).length).toBe(3));
    expect(stub?.weftRequests.length).toBeGreaterThan(0);
  });

  test('says nothing is waiting when neither source has a review', async () => {
    const { findByText } = open({});
    await findByText('All caught up');
  });
});

describe('deciding a Bureau tool approval', () => {
  test('approves through bureau.reviews.resolve with the review’s id, and the row goes', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toEqual({
      id: APPROVAL.id,
      decision: 'approve',
    });
    await waitFor(() => expect(rows(container).length).toBe(0));
  });

  test('rejects only with a reason, and sends it', async () => {
    const { container, findByRole, getByLabelText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    const reject = await findByRole('button', { name: 'Reject' });
    expect(reject.hasAttribute('disabled')).toBe(true);
    await fireEvent.input(getByLabelText(/Reason/), { target: { value: 'Wrong order.' } });
    await fireEvent.click(reject);
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toEqual({
      id: APPROVAL.id,
      decision: 'reject',
      reason: 'Wrong order.',
    });
  });

  test('refetches the list the moment a decision is made', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL, QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    const before = stub?.callsTo('bureau.reviews.list').length ?? 0;
    await fireEvent.click(await findByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(stub?.callsTo('bureau.reviews.list').length).toBeGreaterThan(before),
    );
  });

  test('says the decision was not recorded when the Bureau refuses it, and keeps the review', async () => {
    const { container, findByRole, findByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    stub?.on('bureau.reviews.resolve', () => {
      throw new Error('The Bureau broke.');
    });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText('The decision was not recorded');
    expect(rows(container).length).toBe(1);
  });
});

describe('a decision that took effect', () => {
  const NOT_WRITTEN =
    'APPROVAL_OUTCOME_NOT_WRITTEN: The decision was recorded, but its outcome could not be written into the conversation.';

  /** Answers as the Bureau does: the decision is committed, so the review leaves the pending list, and then the write fails. */
  function writeFails(world: BureauWorld, decidedId: string): void {
    stub?.on('bureau.reviews.resolve', () => {
      world.reviews = world.reviews.filter((review) => review.id !== decidedId);
      throw new StubFault('Conflict', 409, 'The decision was recorded.', { reason: NOT_WRITTEN });
    });
  }

  for (const others of [0, 1]) {
    test(`is told on the page after the review has left the list (${others} other review)`, async () => {
      const decided = toolApprovalFixture({
        id: 'approval:run-a:call-1',
        runId: 'run-a',
        sessionId: 'session-a',
        requestedAt: Date.now() - 200_000,
      });
      const other = toolApprovalFixture({
        id: 'approval:run-b:call-1',
        runId: 'run-b',
        sessionId: 'session-b',
        requestedAt: Date.now() - 100_000,
      });
      const world = emptyBureauWorld({ reviews: others === 0 ? [decided] : [decided, other] });
      stub = installBureauWorld(world);
      router.navigate('/reviews', { replace: true });
      const { container, findByRole, findByText, queryByText } = render(Harness, {
        props: {
          client: new HttpClient({ baseUrl: 'http://localhost/api' }),
          scopes: AUTHORIZATION_SCOPES,
        },
      } as never);
      await waitFor(() => expect(rows(container).length).toBe(1 + others));
      writeFails(world, decided.id);
      const reads = stub.callsTo('bureau.reviews.list').length;

      await fireEvent.click(await findByRole('button', { name: 'Approve' }));

      // The refetch drops the decided review, and the warning is still on the page.
      await waitFor(() => expect(rows(container).length).toBe(others));
      await findByText(REVIEWS_COPY.outcomeNotWritten.title);
      expect(container.textContent).toContain(REVIEWS_COPY.outcomeNotWritten.message);
      expect(queryByText(REVIEWS_COPY.decisionFailed)).toBeNull();
      expect(stub.callsTo('bureau.reviews.list').length).toBeGreaterThan(reads);
      // The other review, if any, has not taken the alert into its own pane.
      expect(container.querySelectorAll('.weft-review-detail [role="alert"]').length).toBe(0);
    });
  }

  test('stays until the operator dismisses it', async () => {
    const decided = toolApprovalFixture({ id: 'approval:run-a:call-1', runId: 'run-a' });
    const world = emptyBureauWorld({ reviews: [decided] });
    stub = installBureauWorld(world);
    router.navigate('/reviews', { replace: true });
    const { container, findByRole, findByText, queryByText } = render(Harness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
    await waitFor(() => expect(rows(container).length).toBe(1));
    writeFails(world, decided.id);
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(REVIEWS_COPY.outcomeNotWritten.title);

    await fireEvent.click(await findByRole('button', { name: /dismiss/i }));
    await waitFor(() =>
      expect(queryByText(REVIEWS_COPY.outcomeNotWritten.title)?.textContent ?? null).toBeNull(),
    );
  });

  test('does not hide a Conflict that is a lost race, which is a decision that was not recorded', async () => {
    const { container, findByRole, findByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    stub?.on('bureau.reviews.resolve', () => {
      throw new StubFault('Conflict', 409, 'Another resolver won.', {
        reason: 'Another resolver won.',
      });
    });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(REVIEWS_COPY.decisionFailed);
  });
});

describe('what became of a decision', () => {
  test('is shown with the review it was about, and not beside another one', async () => {
    const first = toolApprovalFixture({
      id: 'approval:run-a:call-1',
      runId: 'run-a',
      sessionId: 'session-a',
      requestedAt: Date.now() - 200_000,
    });
    const second = toolApprovalFixture({
      id: 'approval:run-b:call-1',
      runId: 'run-b',
      sessionId: 'session-b',
      requestedAt: Date.now() - 100_000,
    });
    const { container, findByRole, findByText, queryByText } = open({ reviews: [first, second] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    stub?.on('bureau.reviews.resolve', () => {
      throw new Error('The Bureau broke.');
    });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(REVIEWS_COPY.decisionFailed);

    const other = rows(container)[1]?.querySelector('button');
    if (other === null || other === undefined) throw new Error('Expected a second row.');
    await fireEvent.click(other);
    await waitFor(() =>
      expect(queryByText(REVIEWS_COPY.decisionFailed)?.textContent ?? null).toBeNull(),
    );

    // Back on the first review, what became of it is still told.
    const again = rows(container)[0]?.querySelector('button');
    if (again === null || again === undefined) throw new Error('Expected a first row.');
    await fireEvent.click(again);
    await findByText(REVIEWS_COPY.decisionFailed);
  });
});

describe('a decision the Bureau gated again', () => {
  test('says the approval is still waiting and the tool did not run', async () => {
    const { container, findByRole, findByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    stub?.on('bureau.reviews.resolve', () => ({
      id: APPROVAL.id,
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'superseded',
    }));
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(REVIEWS_COPY.superseded);
  });
});

describe('answering a Bureau question', () => {
  test('retries an answer whose response was lost under the same message identifier, and a changed answer under a new one', async () => {
    const { container, findByLabelText, getByRole } = open({ reviews: [QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    let lost = true;
    stub?.on('bureau.tasks.respond', () => {
      // The Bureau applied the answer, but the response never arrived.
      if (lost) throw new Error('The response was lost.');
      return {
        taskId: QUESTION.runId,
        messageId: 'm',
        reviewId: QUESTION.id,
        kind: 'human-wait',
        decision: 'approve',
        receipt: 'applied',
      };
    });
    const field = await findByLabelText('Your answer');
    const identifiers = () =>
      stub?.callsTo('bureau.tasks.respond').map((call) => call.params['messageId']);
    const send = async (count: number) => {
      await fireEvent.click(getByRole('button', { name: 'Send answer' }));
      await waitFor(() => expect(identifiers()?.length).toBe(count));
      await waitFor(() =>
        expect(getByRole('button', { name: 'Send answer' }).hasAttribute('disabled')).toBe(false),
      );
    };

    await fireEvent.input(field, { target: { value: 'staging' } });
    await send(1);
    await send(2);
    await fireEvent.input(field, { target: { value: 'production' } });
    await send(3);
    lost = false;
    await send(4);

    const [first, retry, changed, changedRetry] = identifiers() ?? [];
    expect(retry).toBe(first);
    expect(changed).not.toBe(first);
    expect(changedRetry).toBe(changed);
  });

  test('says the answer was not sent when the Bureau refuses it', async () => {
    const { container, findByLabelText, findByText, getByRole } = open({ reviews: [QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    stub?.on('bureau.tasks.respond', () => {
      throw new Error('The Bureau broke.');
    });
    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await findByText(REVIEWS_COPY.answerFailed);
    expect(rows(container).length).toBe(1);
  });

  test('is one text field, sent through bureau.tasks.respond to the run that asked', async () => {
    const { container, findByLabelText, getByRole } = open({ reviews: [QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    stub?.on('bureau.tasks.respond', () => ({
      taskId: QUESTION.runId,
      messageId: 'm',
      reviewId: QUESTION.id,
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    }));
    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      taskId: QUESTION.runId,
      answer: 'staging',
      signalName: QUESTION.signalName,
    });
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
  });
});

describe('an engine review', () => {
  test('is decided through its own form, and goes from the list', async () => {
    const { container, findByRole, getByLabelText } = open({
      weftReviews: [weftPending()],
    });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(await findByRole('radio', { name: 'Approve' }));
    await fireEvent.input(getByLabelText(/Reviewer/), { target: { value: 'ops@example.com' } });
    await fireEvent.click(await findByRole('button', { name: 'Submit decision' }));
    await waitFor(() => expect(stub?.weftDecisions.length).toBe(1));
    expect(stub?.weftDecisions[0]).toMatchObject({
      reviewId: 'weft-review-1',
      body: { decision: 'approved', reviewer: 'ops@example.com' },
    });
    await waitFor(() => expect(rows(container).length).toBe(0));
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
  });

  test('keeps its own decision form, with the reviewer’s name and the sections', async () => {
    const { container, findByRole, getByLabelText } = open({
      weftReviews: [weftPending()],
    });
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(await findByRole('button', { name: 'Submit decision' })).not.toBeNull();
    expect(getByLabelText(/Reviewer/)).not.toBeNull();
    // It is not the Bureau's form: there is no Deny, and no reason to give.
    expect(container.textContent).not.toContain('Reason (required to reject)');
  });

  test('links to the run it is a review of', async () => {
    const { container } = open({ weftReviews: [weftPending()] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(container.querySelector('.weft-review-detail a')?.getAttribute('href')).toBe(
      '/runs/wf_4a9f8c31e7b2d05a6f912c10',
    );
  });

  test('shows the decided and timed-out states for the engine’s own reviews', async () => {
    const decided: ReviewListEntry = {
      status: 'completed',
      reviewId: 'weft-review-2',
      workflowId: 'wf_decided',
      artifact: {},
      reviewType: 'Contract approval',
      reviewers: ['ops@example.com'],
      allowPartial: false,
      createdAt: 1,
      decision: 'approved',
      reviewer: 'ops@example.com',
      timestamp: 2,
    };
    const { container, findByRole } = open({ reviews: [APPROVAL], weftReviews: [decided] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(await findByRole('radio', { name: 'Decided' }));
    await waitFor(() => expect(container.textContent).toContain('wf_decid'));
    expect(container.textContent).not.toContain('issue-refund');
  });
});
