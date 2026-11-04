import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';

import { taskFixture, toolApprovalFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { bureau, landAt } from '../../chat/pages.test-support.ts';
import Harness from './run-activity.test-harness.svelte';
import { threadIdForTask } from './run-activity.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

describe('thread selection for run activity', () => {
  test.each([
    [
      'a catalog parent task',
      taskFixture({ kind: 'catalog', origin: { kind: 'parent' } }),
      undefined,
    ],
    ['a catalog API task', taskFixture({ kind: 'catalog', origin: { kind: 'api' } }), undefined],
    [
      'a catalog task with no origin',
      taskFixture({ kind: 'catalog', origin: undefined }),
      undefined,
    ],
    [
      'a catalog task with a null origin',
      taskFixture({ kind: 'catalog', origin: null }),
      undefined,
    ],
    ['a chat task', taskFixture({ kind: 'chat', origin: { kind: 'chat' } }), undefined],
    [
      'a schedule-fire task',
      taskFixture({ kind: 'schedule-fire', origin: { kind: 'schedule' } }),
      undefined,
    ],
    [
      'a direct catalog child task',
      taskFixture({ kind: 'catalog', origin: { kind: 'agent' } }),
      null,
    ],
    [
      'an explicit goal session',
      taskFixture({ kind: 'catalog', origin: { kind: 'goal' } }),
      'session-1',
    ],
    ['an explicit no-thread override', taskFixture({ kind: 'chat' }), null],
  ] as const)('%s keeps the expected thread meaning', (_name, task, expected) => {
    expect(threadIdForTask(task, expected)).toBe(expected);
  });

  test('a direct child does not read a handle as an AG-UI thread, including after a live event', async () => {
    const requested: string[] = [];
    restore = bureau(
      { 'bureau.reviews.get': () => toolApprovalFixture({ id: 'review-1' }) },
      (url) => {
        if (!url.includes('/threads/')) return undefined;
        requested.push(url);
        return new Response('{}', { status: 404 });
      },
    ).restore;
    landAt('/runs/child-1');
    const task = taskFixture({
      id: 'child-1',
      contextId: 'child-handle-1',
      kind: 'catalog',
      origin: { kind: 'agent', parentRunId: 'parent-1' },
      status: 'input-required',
      openWaits: [{ kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' }],
    });
    const view = render(Harness, { props: { task } } as never);

    await waitFor(() => expect(view.container.querySelectorAll('.ib-run-wait')).toHaveLength(1));
    await fireEvent.click(view.getByRole('button', { name: 'Report an event' }));
    await quietFor(400);

    expect(requested).toEqual([]);
    expect(view.container.querySelectorAll('.ib-run-wait')).toHaveLength(1);
  });
});
