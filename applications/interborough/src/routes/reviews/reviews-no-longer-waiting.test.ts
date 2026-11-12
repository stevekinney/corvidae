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
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { until } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
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
    expect(getByTestId('reviews-announcement').textContent?.trim()).toBe(
      REVIEWS_COPY.announce(REVIEWS_COPY.announced.gone, 'Refund order-1001?'),
    );
    // Nothing was decided, and its decision bar is not there to be pressed.
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
    expect(container.querySelector(`[data-review="${APPROVAL.id}"]`)).toBeNull();

    // One button takes the person to the next review.
    await fireEvent.click(getByRole('button', { name: REVIEWS_COPY.noLongerWaiting.next }));
    await until(() => expect(router.search.get('review')).toBe(QUESTION_KEY));
    await until(() =>
      expect(container.querySelector('[data-testid="review-gone"]')?.outerHTML ?? null).toBeNull(),
    );
  });
});
