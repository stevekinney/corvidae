/**
 * A review that leaves the waiting list while it is open (the agent moved on, or it was decided
 * elsewhere): its place says "No longer waiting" in plain text with one "Next review" button, the
 * same polite message as a decision is announced, and nothing is decided. The poll that notices is
 * five seconds, so the clocks here are fake and no case waits for it.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { until } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { NO_LONGER_WAITING_LINGER_MILLISECONDS } from './review-items.ts';
import Harness from './reviews-shell.test-harness.svelte';

let stub: BureauWorldStub | undefined;
let world: BureauWorld;
let restoreMeasure: (() => void) | undefined;

// The route's code is loaded once, under real timers, so the outlet does not wait on the module
// system with the clock faked.
beforeAll(async () => {
  await import('./index.svelte');
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  restoreMeasure?.();
  restoreMeasure = undefined;
  stub?.restore();
  stub = undefined;
  jest.useRealTimers();
});

/** ListDetail measures its own width, and happy-dom has no layout, so the page is given one. */
function measuredAt(width: number): void {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width, height: 800, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800 }) as DOMRect;
  restoreMeasure = () => {
    HTMLElement.prototype.getBoundingClientRect = measure;
  };
}

function open(initial: Partial<BureauWorld>) {
  world = emptyBureauWorld(initial);
  stub = installBureauWorld(world);
  router.navigate('/reviews', { replace: true });
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const APPROVAL = toolApprovalFixture({ requestedAt: Date.now() - 120_000 });
const QUESTION = humanWaitFixture({ sessionId: 'session-2', requestedAt: Date.now() - 90_000 });
const QUESTION_KEY = `bureau:${QUESTION.id}`;
const APPROVAL_KEY = `bureau:${APPROVAL.id}`;

describe('a review that left while it was open', () => {
  test('says it is no longer waiting, announces it, and offers the next review', async () => {
    measuredAt(1200);
    const { container, getByRole, getByTestId } = open({ reviews: [APPROVAL, QUESTION] });
    // The oldest opens on arrival.
    await until(() => expect(getByRole('button', { name: 'Approve' })).not.toBeNull());

    // The agent moved on: the Bureau no longer lists it, and the next poll notices.
    world.reviews = world.reviews.filter((review) => review.id !== APPROVAL.id);
    jest.advanceTimersByTime(5_000);
    await until(() => expect(getByTestId('review-gone')).not.toBeNull());

    expect(getByTestId('review-gone').textContent).toContain(REVIEWS_COPY.noLongerWaiting.message);
    // Nothing was decided, and its decision bar is not there to be pressed.
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
    expect(container.querySelector(`[data-review="${APPROVAL.id}"]`)).toBeNull();
    // Its row stays a moment, and nothing is announced yet (row 26h).
    expect(container.querySelector(`[data-review-row="${APPROVAL_KEY}"]`)).not.toBeNull();
    expect(getByTestId('reviews-announcement').textContent?.trim()).toBe('');

    // After a moment the row leaves, and that is announced as a decision is.
    jest.advanceTimersByTime(NO_LONGER_WAITING_LINGER_MILLISECONDS);
    await until(() =>
      expect(
        container.querySelector(`[data-review-row="${APPROVAL_KEY}"]`)?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(getByTestId('reviews-announcement').textContent?.trim()).toBe(
      REVIEWS_COPY.announce(REVIEWS_COPY.announced.gone, 'Refund order-1001?'),
    );
    expect(getByTestId('review-gone').textContent).toContain(REVIEWS_COPY.noLongerWaiting.message);

    // One button takes the person to the next review.
    await fireEvent.click(getByRole('button', { name: REVIEWS_COPY.noLongerWaiting.next }));
    await until(() => expect(router.search.get('review')).toBe(QUESTION_KEY));
    await until(() =>
      expect(container.querySelector('[data-testid="review-gone"]')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('says so in its place when an approve finds it already resolved, and then it leaves (rows 26g, 26h, COR-2426)', async () => {
    measuredAt(1200);
    const { container, getByRole, getByTestId, queryByRole } = open({
      reviews: [APPROVAL, QUESTION],
    });
    await until(() => expect(getByRole('button', { name: 'Approve' })).not.toBeNull());
    // The agent already moved on: the Bureau refuses the decision as already resolved.
    stub?.on('bureau.reviews.resolve', () => {
      world.reviews = world.reviews.filter((review) => review.id !== APPROVAL.id);
      throw new StubFault('Conflict', 409, 'Review is already resolved', {
        reason: 'REVIEW_ALREADY_RESOLVED',
      });
    });

    await fireEvent.click(getByRole('button', { name: 'Approve' }));
    await fireEvent.click(getByRole('button', { name: 'Press again to approve' }));

    await until(() => expect(getByTestId('review-gone')).not.toBeNull());
    expect(getByTestId('review-gone').textContent).toContain(REVIEWS_COPY.noLongerWaiting.message);
    // Not a failure: no fault toast, no danger alert, and no decision bar to press again.
    expect(container.ownerDocument.querySelector('.cinder-toast')).toBeNull();
    expect(container.textContent?.includes(REVIEWS_COPY.approvalFailed.approve)).toBe(false);
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(getByRole('button', { name: REVIEWS_COPY.noLongerWaiting.next })).not.toBeNull();
    // Its row stays a moment, then leaves, and that is announced.
    expect(container.querySelector(`[data-review-row="${APPROVAL_KEY}"]`)).not.toBeNull();
    jest.advanceTimersByTime(NO_LONGER_WAITING_LINGER_MILLISECONDS);
    await until(() =>
      expect(
        container.querySelector(`[data-review-row="${APPROVAL_KEY}"]`)?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(getByTestId('reviews-announcement').textContent?.trim()).toBe(
      REVIEWS_COPY.announce(REVIEWS_COPY.announced.gone, 'Refund order-1001?'),
    );
  });

  test('says a NotFound for a review the Bureau still lists is a failure, and hides nothing (COR-2426)', async () => {
    measuredAt(1200);
    const { container, getByRole, queryByTestId } = open({
      reviews: [APPROVAL, QUESTION],
    });
    await until(() => expect(getByRole('button', { name: 'Approve' })).not.toBeNull());
    // A caller who may not decide it is answered NotFound, though it is still waiting.
    stub?.on('bureau.reviews.resolve', () => {
      throw new StubFault('NotFound', 404, 'No review', { resource: 'review' });
    });

    await fireEvent.click(getByRole('button', { name: 'Approve' }));
    await fireEvent.click(getByRole('button', { name: 'Press again to approve' }));

    await until(() => expect(container.textContent).toContain(REVIEWS_COPY.approvalFailed.approve));
    jest.advanceTimersByTime(NO_LONGER_WAITING_LINGER_MILLISECONDS + 5_000);
    await until(() =>
      expect(container.querySelector(`[data-review-row="${APPROVAL_KEY}"]`)).not.toBeNull(),
    );
    expect(queryByTestId('review-gone')?.outerHTML ?? null).toBeNull();
    expect(getByRole('button', { name: 'Approve' })).not.toBeNull();
  });
});
