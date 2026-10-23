import { describe, expect, test } from 'bun:test';

import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { decidedKey, SeenReviews } from './decided-elsewhere.ts';

const approval = (callId: string) =>
  toolApprovalFixture({
    approval: { ...toolApprovalFixture().approval, callId },
  });

describe('reviews decided somewhere else', () => {
  test('a call the page has not seen pending is not decided, however empty the list', () => {
    const seen = new SeenReviews();
    // The list is cached and shared with the navigation: it can predate the review a chat has
    // just raised, and says nothing about a decision.
    const read = seen.observe([], { shownCalls: ['call-1'], questionOpen: false });
    expect(read).toEqual({ calls: [], questions: [] });
    expect(decidedKey(read)).toBe('');
  });

  test('a call seen pending and then gone is decided, and only that call', () => {
    const seen = new SeenReviews();
    const shown = { shownCalls: ['call-1', 'call-2'], questionOpen: false };
    expect(seen.observe([approval('call-1'), approval('call-2')], shown).calls).toEqual([]);

    const decided = seen.observe([approval('call-2')], shown);

    expect(decided.calls).toEqual(['call-1']);
    expect(decidedKey(decided)).toBe('call-1');
  });

  test('a question is decided by its own review, so the next question is a new decision', () => {
    const seen = new SeenReviews();
    const shown = { shownCalls: [], questionOpen: true };
    seen.observe([humanWaitFixture({ id: 'question-1' })], shown);
    const first = seen.observe([], shown);
    expect(first.questions).toEqual(['question-1']);
    seen.forget(first);

    // The thread was read and the question cleared; a second question is raised and answered.
    seen.observe([humanWaitFixture({ id: 'question-2' })], shown);
    const second = seen.observe([], shown);

    expect(second.questions).toEqual(['question-2']);
    expect(decidedKey(second)).not.toBe(decidedKey(first));
  });

  test('a question the chat does not show is not reported, and clearing forgets what was seen', () => {
    const seen = new SeenReviews();
    seen.observe([humanWaitFixture({ id: 'question-1' })], { shownCalls: [], questionOpen: true });
    expect(seen.observe([], { shownCalls: [], questionOpen: false }).questions).toEqual([]);

    seen.clear();

    expect(seen.observe([], { shownCalls: [], questionOpen: true }).questions).toEqual([]);
  });
});
