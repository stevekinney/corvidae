import { QueryClient } from '@tanstack/svelte-query';
import { describe, expect, spyOn, test } from 'bun:test';

import type { BureauEventFrame } from '../lib/live-source/bureau-event-frame.ts';
import { queryKeys } from '../lib/query.ts';
import {
  invalidateForBureauEvent,
  isBureauGoalEventKind,
  isBureauReviewEventKind,
  subscribeBureauInvalidation,
} from './bureau-event-queries.ts';

const WATCHED = {
  bureauReviews: queryKeys.bureauReviews.list(),
  engineReviews: queryKeys.reviews.list({ status: 'pending' }),
  bureauTasks: queryKeys.bureauTasks.detail('task-1'),
  recentTasks: ['bureau-tasks', 'recent'] as const,
  chatTitles: queryKeys.contexts.titles(),
  runChats: queryKeys.contexts.runs(),
  chatDetail: queryKeys.contexts.detail('session-1'),
  goalList: queryKeys.goals.list(),
  goalRuns: queryKeys.goals.runs(),
  // A view whose probe found nothing to list, and one that has something.
  emptyView: queryKeys.view('runs', null),
  // Entries the feed does not drive.
  fullView: queryKeys.view('goals', null),
  workers: queryKeys.workers.list(),
  agents: queryKeys.agents.list(),
};

function seeded(): QueryClient {
  const queryClient = new QueryClient();
  for (const key of Object.values(WATCHED)) queryClient.setQueryData(key, () => []);
  queryClient.setQueryData(WATCHED.emptyView, () => ({ empty: true }));
  queryClient.setQueryData(WATCHED.fullView, () => ({ empty: false }));
  return queryClient;
}

function invalidated(queryClient: QueryClient): string[] {
  return Object.entries(WATCHED)
    .filter(([, key]) => queryClient.getQueryState(key)?.isInvalidated === true)
    .map(([name]) => name)
    .toSorted();
}

const REVIEWS_AND_TASKS = ['bureauReviews', 'bureauTasks', 'engineReviews', 'recentTasks'];
const CHATS = ['chatDetail', 'chatTitles', 'runChats'];
const GOALS = ['goalList', 'goalRuns'];

describe('invalidateForBureauEvent', () => {
  test.each([
    'review.requested',
    'review.approved',
    'review.denied',
    'review.rejected',
    'review.expired',
    'review.revoked',
    'review.canceled',
    'review.superseded',
  ])('%s asks for the reviews and the tasks that hold them', (kind) => {
    const queryClient = seeded();
    expect(invalidateForBureauEvent(queryClient, { kind })).toBe(true);
    expect(invalidated(queryClient)).toEqual(REVIEWS_AND_TASKS);
  });

  test.each(['run.removed', 'action', 'task.cleanup-acknowledged'])(
    '%s asks for the tasks, and nothing else',
    (kind) => {
      const queryClient = seeded();
      expect(invalidateForBureauEvent(queryClient, { kind })).toBe(true);
      expect(invalidated(queryClient)).toEqual(['bureauTasks', 'recentTasks']);
    },
  );

  test.each(['run.registered', 'run.settled'])(
    '%s asks for the tasks, and for a view that had nothing to list',
    (kind) => {
      const queryClient = seeded();
      expect(invalidateForBureauEvent(queryClient, { kind })).toBe(true);
      expect(invalidated(queryClient)).toEqual(['bureauTasks', 'emptyView', 'recentTasks']);
    },
  );

  test.each(['session.created', 'session.saved', 'session.deleted'])(
    '%s asks for the chats, and nothing else',
    (kind) => {
      const queryClient = seeded();
      expect(invalidateForBureauEvent(queryClient, { kind })).toBe(true);
      expect(invalidated(queryClient)).toEqual(CHATS);
    },
  );

  test.each([
    'goal.attempt.started',
    'goal.attempt.validated',
    'goal.succeeded',
    'goal.exhausted',
    'goal.canceled',
    'goal.failed',
    'goal.recovered',
  ])('%s asks for the goals, and nothing else', (kind) => {
    const queryClient = seeded();
    expect(invalidateForBureauEvent(queryClient, { kind })).toBe(true);
    expect(invalidated(queryClient)).toEqual(GOALS);
  });

  test('goal.started asks for the goals, and for a view that had nothing to list', () => {
    const queryClient = seeded();
    expect(invalidateForBureauEvent(queryClient, { kind: 'goal.started' })).toBe(true);
    expect(invalidated(queryClient)).toEqual(['emptyView', ...GOALS]);
  });

  test.each(['feed.gap', 'frames.dropped', 'feed.resync'])(
    '%s asks again for everything the feed drives',
    (kind) => {
      const queryClient = seeded();
      expect(invalidateForBureauEvent(queryClient, { kind })).toBe(true);
      expect(invalidated(queryClient)).toEqual(
        [...REVIEWS_AND_TASKS, ...CHATS, ...GOALS, 'emptyView'].toSorted(),
      );
    },
  );

  test.each(['bureau.disposed', 'diagnostic', 'definitions.changed', 'goals.changed'])(
    '%s drives no view, so it asks for nothing',
    (kind) => {
      const queryClient = seeded();
      expect(invalidateForBureauEvent(queryClient, { kind })).toBe(false);
      expect(invalidated(queryClient)).toEqual([]);
    },
  );

  test('a review is asked for once, not once for the reviews and again for the tasks', () => {
    const queryClient = seeded();
    const invalidate = spyOn(queryClient, 'invalidateQueries');
    invalidateForBureauEvent(queryClient, { kind: 'review.requested' });
    // Three prefixes: the Bureau's reviews, the engine's, and the Bureau's tasks.
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
});

describe('isBureauGoalEventKind', () => {
  test('is the goal family and no other kind that mentions goals', () => {
    expect(isBureauGoalEventKind('goal.started')).toBe(true);
    expect(isBureauGoalEventKind('goal.attempt.validated')).toBe(true);
    expect(isBureauGoalEventKind('goals.changed')).toBe(false);
    expect(isBureauGoalEventKind('run.registered')).toBe(false);
  });
});

describe('isBureauReviewEventKind', () => {
  test('is the review family and no other kind that mentions reviews', () => {
    expect(isBureauReviewEventKind('review.requested')).toBe(true);
    expect(isBureauReviewEventKind('reviews.changed')).toBe(false);
    expect(isBureauReviewEventKind('human-review:requested')).toBe(false);
  });
});

describe('subscribeBureauInvalidation', () => {
  test('applies every frame its source delivers, until it is unsubscribed', () => {
    const queryClient = seeded();
    let listener: ((frame: BureauEventFrame) => void) | undefined;
    let unsubscribed = false;
    const unsubscribe = subscribeBureauInvalidation(
      {
        subscribe(next) {
          listener = next;
          return () => {
            unsubscribed = true;
          };
        },
      },
      queryClient,
    );
    listener?.({ kind: 'run.settled', sequence: 1, cursor: 'a:1', emittedAtMs: 0, payload: {} });
    expect(invalidated(queryClient)).toEqual(['bureauTasks', 'emptyView', 'recentTasks']);
    unsubscribe();
    expect(unsubscribed).toBe(true);
  });
});
