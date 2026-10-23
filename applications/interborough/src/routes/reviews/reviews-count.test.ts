/**
 * The count of what is waiting, in the navigation and on `/reviews`: one number from the Bureau's
 * reviews and the engine's, kept current by asking again every five seconds and at once after each
 * decision this application makes. The clocks here are fake, so no case waits five seconds.
 */
import { HttpClient, type PendingReviewEntry, type ReviewListEntry } from '@lostgradient/weft';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { settle, until } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
import Harness from './reviews-shell.test-harness.svelte';

let stub: BureauWorldStub | undefined;
let world: BureauWorld;

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
  stub?.restore();
  stub = undefined;
  jest.useRealTimers();
});

function weft(id: string): ReviewListEntry {
  const entry: PendingReviewEntry = {
    status: 'pending',
    reviewId: id,
    workflowId: `wf_${id}`,
    artifact: {},
    reviewType: 'Contract approval',
    reviewers: [],
    allowPartial: false,
    createdAt: Date.now() - 60_000,
  };
  return entry;
}

function open(
  path: string,
  initial: Partial<BureauWorld>,
  scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES,
) {
  world = emptyBureauWorld(initial);
  stub = installBureauWorld(world);
  router.navigate(path, { replace: true });
  return render(Harness, {
    props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes },
  } as never);
}

/** What the Reviews entry in the navigation says, with its count. */
function navigationLabel(container: HTMLElement): string {
  const link = container.querySelector('a[href="/reviews"]');
  return link?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function countOf(container: HTMLElement): string | undefined {
  return container.querySelector('.ib-reviews__count')?.getAttribute('aria-label') ?? undefined;
}

const approval = (id: string) => toolApprovalFixture({ id, runId: `run-${id}` });

describe('the count in the navigation', () => {
  test('is the Bureau’s pending reviews and the engine’s, as one number', async () => {
    const { container } = open('/chat', {
      reviews: [approval('a'), humanWaitFixture({ sessionId: 's' })],
      weftReviews: [weft('w1')],
    });
    await until(() => expect(navigationLabel(container)).toBe('Reviews 3'));
  });

  test('is the Bureau’s alone when the principal lacks reviews:read, and asks the engine nothing', async () => {
    const { container } = open(
      '/chat',
      { reviews: [approval('a')], weftReviews: [weft('w1'), weft('w2')] },
      AUTHORIZATION_SCOPES.filter((scope) => scope !== 'reviews:read'),
    );
    await until(() => expect(navigationLabel(container)).toBe('Reviews 1'));
    expect(stub?.weftRequests).toEqual([]);
  });

  test('leaves out an engine review whose deadline has passed, as the page files it under Timed out', async () => {
    const late: PendingReviewEntry = {
      status: 'pending',
      reviewId: 'late',
      workflowId: 'wf_late',
      artifact: {},
      reviewType: 'Contract approval',
      reviewers: [],
      allowPartial: false,
      createdAt: Date.now() - 120_000,
      timeout: 60_000,
    };
    const { container } = open('/chat', {
      reviews: [approval('a')],
      weftReviews: [late, weft('w1')],
    });
    await until(() => expect(navigationLabel(container)).toBe('Reviews 2'));
  });

  test('has no number when nothing is waiting', async () => {
    const { container } = open('/chat', {});
    await until(() => expect(stub?.callsTo('bureau.reviews.list').length).toBeGreaterThan(0));
    await settle();
    expect(navigationLabel(container)).toBe('Reviews');
  });

  test('changes after five seconds when a review arrives, and not before', async () => {
    const { container } = open('/chat', { reviews: [approval('a')] });
    await until(() => expect(navigationLabel(container)).toBe('Reviews 1'));

    world.reviews = [...world.reviews, approval('b')];
    // Not at four seconds: the poll is every five, and the fake clock may have moved a millisecond
    // while the page rendered, so the boundary is checked with a margin on either side.
    jest.advanceTimersByTime(4_000);
    await settle();
    expect(navigationLabel(container)).toBe('Reviews 1');

    jest.advanceTimersByTime(1_000);
    await until(() => expect(navigationLabel(container)).toBe('Reviews 2'));
  });

  test('counts a review of the engine’s that arrives after five seconds, too', async () => {
    const { container } = open('/chat', { reviews: [approval('a')] });
    await until(() => expect(navigationLabel(container)).toBe('Reviews 1'));
    world.weftReviews = [weft('w1')];
    jest.advanceTimersByTime(5_000);
    await until(() => expect(navigationLabel(container)).toBe('Reviews 2'));
  });

  test('changes at once after a decision this application makes, with no time advanced', async () => {
    const { container, findAllByRole } = open('/reviews', {
      reviews: [approval('a'), approval('b')],
    });
    await until(() => expect(navigationLabel(container)).toBe('Reviews 2'));
    await until(() =>
      expect(container.querySelectorAll('.ib-review').length).toBe(2),
    );

    await fireEvent.click((await findAllByRole('button', { name: 'Approve' }))[0]!);
    await until(() => expect(navigationLabel(container)).toBe('Reviews 1'));
    expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1);
  });
});

describe('answering a question in the inbox', () => {
  test('changes the count at once, with no time advanced', async () => {
    const question = humanWaitFixture({ sessionId: 'session-q' });
    const { container, findByRole, findByLabelText } = open('/reviews', { reviews: [question] });
    await until(() => expect(navigationLabel(container)).toBe('Reviews 1'));
    await until(() =>
      expect(container.querySelectorAll('.ib-review').length).toBe(1),
    );
    stub?.on('bureau.tasks.respond', () => {
      world.reviews = [];
      return {
        taskId: question.runId,
        messageId: 'm',
        reviewId: question.id,
        kind: 'human-wait',
        decision: 'approve',
        receipt: 'applied',
      };
    });

    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(await findByRole('button', { name: 'Send answer' }));

    await until(() => expect(navigationLabel(container)).toBe('Reviews'));
    expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1);
  });
});

describe('the list on /reviews', () => {
  const rows = (container: HTMLElement) =>
    container.querySelectorAll('.ib-review').length;

  test('shows a review that arrives after five seconds, and says how many wait', async () => {
    const { container } = open('/reviews', { reviews: [approval('a')] });
    await until(() => expect(rows(container)).toBe(1));
    expect(countOf(container)).toBe('1 waiting on you');

    world.reviews = [...world.reviews, approval('b')];
    jest.advanceTimersByTime(4_000);
    await settle();
    expect(rows(container)).toBe(1);
    jest.advanceTimersByTime(1_000);
    await until(() => expect(rows(container)).toBe(2));
    expect(countOf(container)).toBe('2 waiting on you');
  });

  test('drops a review that was resolved elsewhere after five seconds', async () => {
    const { container } = open('/reviews', { reviews: [approval('a'), approval('b')] });
    await until(() => expect(rows(container)).toBe(2));
    world.reviews = world.reviews.slice(1);
    jest.advanceTimersByTime(5_000);
    await until(() => expect(rows(container)).toBe(1));
  });
});
