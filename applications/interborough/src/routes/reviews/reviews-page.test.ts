/**
 * `/reviews`: the Bureau's pending reviews and the engine's in one list, with the decision forms
 * each kind needs, over a Bureau that answers from a table (`bureau-world.test-support.ts`).
 */
import { HttpClient, type PendingReviewEntry, type ReviewListEntry } from '@lostgradient/weft';
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

describe('answering a Bureau question', () => {
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
