/**
 * One Bureau review in the list (`bureau-review-row.svelte`). It links once: to the chat when the
 * review names a session, otherwise to its task when `bureau.tasks.get` answers for its run,
 * otherwise to the run.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  humanWaitFixture,
  taskFixture,
  toolApprovalFixture,
} from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import RowHarness from './bureau-review-row.test-harness.svelte';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/', { replace: true });
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function mount(
  review: ReturnType<typeof toolApprovalFixture> | ReturnType<typeof humanWaitFixture>,
  tasks = [] as ReturnType<typeof taskFixture>[],
) {
  stub = installBureauWorld(emptyBureauWorld({ tasks }));
  return render(RowHarness, {
    props: { review, selected: false, now: review.requestedAt + 60_000 },
  } as never);
}

const hrefs = (container: HTMLElement) =>
  [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'));

describe('a Bureau review’s link', () => {
  test('is the chat when the review names a session, and asks the Bureau about no task', async () => {
    const { container } = mount(toolApprovalFixture({ sessionId: 'session-9', runId: 'run-9' }));
    await waitFor(() => expect(hrefs(container)).toEqual(['/chat/session-9']));
    expect(stub?.callsTo('bureau.tasks.get')).toEqual([]);
  });

  test('is the task when the review names no session and the Bureau answers for its run', async () => {
    const wait = humanWaitFixture({ runId: 'run-fire-1' });
    const { container } = mount(wait, [taskFixture({ id: 'run-fire-1' })]);
    await waitFor(() => expect(hrefs(container)).toEqual(['/tasks/run-fire-1']));
    expect(stub?.callsTo('bureau.tasks.get').at(-1)?.params).toEqual({ taskId: 'run-fire-1' });
  });

  test('is the run when the review names no session and the Bureau has no task for its run', async () => {
    const wait = humanWaitFixture({ runId: 'run-engine-1' });
    const { container } = mount(wait, []);
    await waitFor(() => expect(hrefs(container)).toEqual(['/runs/run-engine-1']));
  });

  test('is the run when the Bureau cannot say whether there is a task', async () => {
    stub = installBureauWorld(emptyBureauWorld());
    stub.on('bureau.tasks.get', () => {
      throw new Error('The Bureau broke.');
    });
    const wait = humanWaitFixture({ runId: 'run-engine-2' });
    const { container } = render(RowHarness, {
      props: { review: wait, selected: false, now: wait.requestedAt },
    } as never);
    await waitFor(() => expect(hrefs(container)).toEqual(['/runs/run-engine-2']));
  });

  test('is one link, and is none while the Bureau is still being asked', async () => {
    const wait = humanWaitFixture({ runId: 'run-fire-1' });
    stub = installBureauWorld(emptyBureauWorld({ tasks: [taskFixture({ id: 'run-fire-1' })] }));
    const { container } = render(RowHarness, {
      props: { review: wait, selected: false, now: wait.requestedAt },
    } as never);
    expect(container.querySelectorAll('a').length).toBe(0);
    await waitFor(() => expect(container.querySelectorAll('a').length).toBe(1));
  });
});

describe('a Bureau review’s row', () => {
  test('says what is waiting: the tool for an approval, and the question for a wait', () => {
    const approval = mount(toolApprovalFixture());
    expect(approval.container.textContent).toContain('issue-refund');
    expect(approval.container.textContent).toContain('tool-runner');
    approval.unmount();
    stub?.restore();

    const wait = mount(humanWaitFixture({ sessionId: 's' }));
    expect(wait.container.textContent).toContain('Which environment should the release go to?');
    expect(wait.container.textContent).toContain('request-human-input');
  });
});
