/**
 * `/reviews`: one inbox of everything waiting on the person, the longest waiting first, with the
 * open review beside the list and a Done tab of what was decided, over a Bureau that answers from a
 * table (`bureau-world.test-support.ts`). The keys that act on the open review are checked through
 * the registry, as the shell reads them (`lib/shortcuts.ts`).
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
import { shortcuts } from '../../lib/shortcuts.ts';
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
  address = '/reviews',
) {
  stub = installBureauWorld(emptyBureauWorld(world));
  router.navigate(address, { replace: true });
  return render(Harness, {
    props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes },
  } as never);
}

const APPROVAL = toolApprovalFixture({ requestedAt: Date.now() - 120_000 });
const QUESTION = humanWaitFixture({ sessionId: 'session-2', requestedAt: Date.now() - 90_000 });

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-review-row]')];
}

/** Opens the row at `index`, as a click on it does. */
async function openRow(container: HTMLElement, index: number): Promise<void> {
  const row = rows(container)[index];
  const primary = row?.querySelector<HTMLElement>('.cinder-selectable-row__primary') ?? row;
  if (primary === undefined) throw new Error(`There is no row ${String(index)}.`);
  await fireEvent.click(primary);
}

/** The key press the shell would hand the registry on `/reviews`, with focus where `editable` says. */
function press(key: string, editable = false): boolean {
  return shortcuts.handleKey(
    { key, metaKey: false, ctrlKey: false, altKey: false, editable },
    { routePattern: '/reviews', regions: ['list-detail'] },
    Date.now(),
  );
}

const RESPONDED = {
  taskId: QUESTION.runId,
  messageId: 'm',
  reviewId: QUESTION.id,
  kind: 'human-wait',
  decision: 'approve',
  receipt: 'applied',
};

describe('the reviews page', () => {
  test('lists the Bureau’s reviews and the engine’s in one list, the longest waiting first', async () => {
    const { container, getByRole } = open({
      reviews: [QUESTION, APPROVAL],
      weftReviews: [weftPending()],
    });
    await waitFor(() => expect(rows(container).length).toBe(3));
    expect(container.querySelector('h1')?.textContent).toBe('Reviews');
    expect(rows(container)[0]?.textContent).toContain('Refund order-1001?');
    expect(rows(container)[1]?.textContent).toContain(
      'Which environment should the release go to?',
    );
    expect(rows(container)[2]?.textContent).toContain('Contract approval');
    // One count, on the tab, and no section of its own for the engine's reviews.
    expect(getByRole('tab', { name: 'Waiting (3)' })).not.toBeNull();
    expect(container.textContent).not.toContain('Workflow reviews');
    expect(container.textContent).not.toContain('Engine');
  });

  test('says nothing is waiting with the done kind of empty state', async () => {
    const { findByText, container } = open({});
    await findByText(REVIEWS_COPY.allCaughtUp);
    expect(container.querySelector('[data-kind="done"], .cinder-empty-state')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-busy="true"]')).toBeNull();
  });

  test('opens a review from its row, and keeps it in the address', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL, QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    await openRow(container, 0);
    await findByRole('button', { name: 'Approve' });
    expect(router.search.get('review')).toBe(`bureau:${APPROVAL.id}`);
  });

  test('opens the review the address names', async () => {
    const { findByRole } = open(
      { reviews: [APPROVAL, QUESTION] },
      AUTHORIZATION_SCOPES,
      `/reviews?review=${encodeURIComponent(`bureau:${APPROVAL.id}`)}`,
    );
    await findByRole('button', { name: 'Approve' });
  });

  test('gives each part of the source line a link: the agent, the chat and the run', async () => {
    const { container, findByTestId } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    const source = await findByTestId('review-source');
    expect(source.textContent).toContain('Asked by');
    expect(source.textContent).toContain('waiting since');
    const hrefs = [...source.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/agents/tool-runner', '/chats/session-1', '/runs/run-1']);
  });

  test('asks the merged list for what is waiting, which holds the engine’s reviews too', async () => {
    const { container } = open({ reviews: [APPROVAL], weftReviews: [weftPending()] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    expect(
      stub?.callsTo('bureau.reviews.list').some((call) => call.params['status'] === 'pending'),
    ).toBe(true);
  });
});

describe('deciding a Bureau tool approval', () => {
  test('shows the tool and what it was given before it is decided', async () => {
    const { container, findByRole, findByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByRole('button', { name: 'Approve' });
    await findByText('order-1001');
    expect(container.textContent).toContain('orderId');
    expect(container.textContent).toContain('4200');
  });

  test('approves through bureau.reviews.resolve with the review’s id and round, and the row goes', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toEqual({
      id: APPROVAL.id,
      decision: 'approve',
      round: APPROVAL.round,
    });
    await waitFor(() => expect(rows(container).length).toBe(0));
  });

  test('allows the tool for the rest of the chat by sending remember with the approval', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await fireEvent.click(await findByRole('button', { name: REVIEWS_COPY.allowForChat }));
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toEqual({
      id: APPROVAL.id,
      decision: 'approve',
      round: APPROVAL.round,
      remember: true,
    });
  });

  test('says the approval was not remembered when the Bureau could not store the grant', async () => {
    const { container, findByRole, findByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.reviews.resolve', () => ({
      id: APPROVAL.id,
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'applied',
      remembered: false,
    }));
    await fireEvent.click(await findByRole('button', { name: REVIEWS_COPY.allowForChat }));
    await findByText(REVIEWS_COPY.notRemembered.title);
  });

  test('denies with a note as a rejection carrying the note, and without one as a plain denial', async () => {
    const { container, findByRole, getByLabelText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await fireEvent.input(getByLabelText(REVIEWS_COPY.noteLabel), {
      target: { value: 'Wrong order.' },
    });
    await fireEvent.click(await findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toEqual({
      id: APPROVAL.id,
      decision: 'reject',
      reason: 'Wrong order.',
      round: APPROVAL.round,
    });
  });

  test('sends a plain denial when no note was typed', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await fireEvent.click(await findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toMatchObject({ decision: 'deny' });
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).not.toHaveProperty('reason');
  });

  test('opens the review after the one decided', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL, QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    await openRow(container, 0);
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(rows(container).length).toBe(1));
    await findByRole('textbox', { name: /your answer/i });
    expect(router.search.get('review')).toBe(`bureau:${QUESTION.id}`);
  });

  test('refetches the list the moment a decision is made', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL, QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    await openRow(container, 0);
    const before = stub?.callsTo('bureau.reviews.list').length ?? 0;
    await fireEvent.click(await findByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(stub?.callsTo('bureau.reviews.list').length).toBeGreaterThan(before),
    );
  });

  test('says the decision was not recorded when the Bureau refuses it, and keeps the review', async () => {
    const { container, findByRole, findByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.reviews.resolve', () => {
      throw new Error('The Bureau broke.');
    });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(new RegExp(REVIEWS_COPY.decisionFailed));
    expect(rows(container).length).toBe(1);
  });
});

describe('the keys that act on the open review', () => {
  test('A approves the open approval, and D denies it with the note typed', async () => {
    const { container, getByLabelText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    // With nothing open, the keys act on nothing.
    expect(press('a')).toBe(true);
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);

    await openRow(container, 0);
    await waitFor(() => expect(getByLabelText(REVIEWS_COPY.noteLabel)).not.toBeNull());
    await fireEvent.input(getByLabelText(REVIEWS_COPY.noteLabel), {
      target: { value: 'Not today.' },
    });
    press('d');
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toEqual({
      id: APPROVAL.id,
      decision: 'reject',
      reason: 'Not today.',
      round: APPROVAL.round,
    });
  });

  test('A sends an approval', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByRole('button', { name: 'Approve' });
    press('a');
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toMatchObject({
      id: APPROVAL.id,
      decision: 'approve',
    });
  });

  test('do nothing while a field is being typed in', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByRole('button', { name: 'Approve' });
    expect(press('a', true)).toBe(false);
    expect(press('d', true)).toBe(false);
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
  });

  test('do not act on a question, which is answered rather than approved', async () => {
    const { container, findByRole } = open({ reviews: [QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByRole('textbox', { name: /your answer/i });
    press('a');
    press('d');
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });

  test('are listed in the shortcut map under Reviews, and gone when the page is', async () => {
    const { container, unmount } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    const labels = () =>
      shortcuts
        .groups()
        .find((group) => group.label === REVIEWS_COPY.shortcutGroup)
        ?.shortcuts.map((shortcut) => shortcut.action);
    expect(labels()).toContain(REVIEWS_COPY.approveShortcut);
    expect(labels()).toContain(REVIEWS_COPY.denyShortcut);
    expect(labels()).toContain(REVIEWS_COPY.pickShortcut(9));
    unmount();
    expect(labels()).toBeUndefined();
  });
});

describe('one list failing', () => {
  /** Opens `/reviews` over a Bureau whose list fails from the first request, the frame's probe included. */
  function openFailing(fault: StubFault, world: Partial<BureauWorld>) {
    stub = installBureauWorld(emptyBureauWorld(world));
    stub.on('bureau.reviews.list', () => {
      throw fault;
    });
    router.navigate('/reviews', { replace: true });
    return render(Harness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
  }

  test('says so with a banner and Try again, on a page that is up', async () => {
    const { container, findByText } = openFailing(
      new StubFault('EngineFailure', 500, 'The Bureau broke.'),
      {},
    );
    await findByText('The Bureau broke.');
    expect(container.querySelector('[data-view="reviews"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
    expect(container.textContent).not.toContain(REVIEWS_COPY.allCaughtUp);
  });

  test('still refuses the whole page when the Bureau refuses the caller', async () => {
    const { container, findByRole } = openFailing(new StubFault('Forbidden', 403, 'No.'), {
      weftReviews: [weftPending()],
    });
    await findByRole('heading', { level: 1, name: 'Reviews are locked' });
    expect(container.querySelector('[data-view="reviews"]')?.getAttribute('data-state')).toBe(
      'forbidden',
    );
  });
});

describe('the approval’s details', () => {
  const operation = (extra: Record<string, unknown>) =>
    toolApprovalFixture({
      requestedAt: Date.now() - 120_000,
      approval: {
        ...toolApprovalFixture().approval,
        action: {
          type: 'approval',
          message: 'Run it?',
          risk: 'high',
          operation: { kind: 'command', ...extra },
        },
      },
    });

  test('shows what the approval would run: the command and the files, without a click', async () => {
    const approval = operation({ command: 'bun run deploy', filesTouched: ['dist/app.js'] });
    const { container, findByText } = open({ reviews: [approval] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByText('bun run deploy');
    expect(container.textContent).toContain('dist/app.js');
    expect(container.textContent).toContain(REVIEWS_COPY.operation.command);
  });

  test('keeps the inbox usable when the operation lists one path twice', async () => {
    const approval = operation({
      kind: 'patch',
      command: 'bun run deploy',
      filesTouched: ['dist/app.js', 'dist/app.js'],
    });
    const { container, findByText } = open({ reviews: [approval] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByText('bun run deploy');
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.querySelectorAll('.weft-bureau-review-operation__files li').length).toBe(1);
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

  const decided = toolApprovalFixture({
    id: 'approval:run-a:call-1',
    runId: 'run-a',
    sessionId: 'session-a',
    requestedAt: Date.now() - 200_000,
  });

  for (const others of [0, 1]) {
    test(`is told on the page after the review has left the list (${others} other review)`, async () => {
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
      await openRow(container, 0);
      writeFails(world, decided.id);
      const reads = stub.callsTo('bureau.reviews.list').length;

      await fireEvent.click(await findByRole('button', { name: 'Approve' }));

      // The refetch drops the decided review, and the warning is still on the page.
      await waitFor(() => expect(rows(container).length).toBe(others));
      await findByText(REVIEWS_COPY.outcomeNotWritten.title);
      expect(container.textContent).toContain(REVIEWS_COPY.outcomeNotWritten.message);
      expect(queryByText(REVIEWS_COPY.decisionFailed)).toBeNull();
      expect(stub.callsTo('bureau.reviews.list').length).toBeGreaterThan(reads);
    });
  }

  test('stays until the operator dismisses it', async () => {
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
    await openRow(container, 0);
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
    await openRow(container, 0);
    stub?.on('bureau.reviews.resolve', () => {
      throw new StubFault('Conflict', 409, 'Another resolver won.', {
        reason: 'Another resolver won.',
      });
    });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(new RegExp(REVIEWS_COPY.decisionFailed));
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
    await openRow(container, 0);
    stub?.on('bureau.reviews.resolve', () => {
      throw new Error('The Bureau broke.');
    });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(new RegExp(REVIEWS_COPY.decisionFailed));

    // The other review, opened, carries no trace of the first one's failure.
    await openRow(container, 1);
    await waitFor(() =>
      expect(queryByText(new RegExp(REVIEWS_COPY.decisionFailed))?.outerHTML ?? null).toBeNull(),
    );
  });
});

describe('a decision the Bureau gated again', () => {
  test('says the approval is still waiting and the tool did not run', async () => {
    const { container, findByRole, findByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.reviews.resolve', () => ({
      id: APPROVAL.id,
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'superseded',
    }));
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByText(REVIEWS_COPY.superseded);
    expect(rows(container).length).toBe(1);
  });
});

describe('a decision on a review that changed while it was read (COR-1714)', () => {
  test('sends the round the row showed', async () => {
    const approval = toolApprovalFixture({ round: 2, requestedAt: Date.now() - 120_000 });
    const { container, findByRole } = open({ reviews: [approval] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve').length).toBe(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toEqual({
      id: approval.id,
      decision: 'approve',
      round: 2,
    });
  });

  test('says it changed and was not decided, and reads the review again', async () => {
    const { container, findByRole, findByText, queryByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.reviews.resolve', () => {
      throw new StubFault('Conflict', 409, 'The review moved on.', {
        reason: 'REVIEW_ROUND_CHANGED: now at round 1',
      });
    });
    const reads = stub?.callsTo('bureau.reviews.list').length ?? 0;

    await fireEvent.click(await findByRole('button', { name: 'Approve' }));

    await findByText(new RegExp(REVIEWS_COPY.roundChanged.title));
    expect(container.textContent).toContain(REVIEWS_COPY.roundChanged.message);
    expect(queryByText(new RegExp(REVIEWS_COPY.decisionFailed))).toBeNull();
    expect(container.textContent).not.toContain('REVIEW_ROUND_CHANGED');
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.list').length).toBeGreaterThan(reads));
    expect(rows(container).length).toBe(1);
  });
});

describe('answering a Bureau question', () => {
  test('is a text field when the question declares no schema, sent through bureau.tasks.respond', async () => {
    const { container, findByLabelText, getByRole } = open({ reviews: [QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.tasks.respond', () => RESPONDED);
    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      taskId: QUESTION.runId,
      answer: 'staging',
      signalName: QUESTION.signalName,
    });
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
  });

  test('retries an answer whose response was lost under the same message identifier, and a changed answer under a new one', async () => {
    const { container, findByLabelText, getByRole } = open({ reviews: [QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    let lost = true;
    stub?.on('bureau.tasks.respond', () => {
      // The Bureau applied the answer, but the response never arrived.
      if (lost) throw new Error('The response was lost.');
      return RESPONDED;
    });
    const field = await findByLabelText('Your answer');
    const identifiers = () =>
      stub?.callsTo('bureau.tasks.respond').map((call) => call.params['messageId']);
    const send = async (count: number) => {
      await fireEvent.click(getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(identifiers()?.length).toBe(count));
      await waitFor(() =>
        expect(getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false),
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
    await openRow(container, 0);
    stub?.on('bureau.tasks.respond', () => {
      throw new Error('The Bureau broke.');
    });
    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(getByRole('button', { name: 'Send' }));
    await findByText(/could not be sent/);
    expect(rows(container).length).toBe(1);
  });

  const CHOICES = humanWaitFixture({
    id: 'human-wait:run-3:environment:0',
    runId: 'run-3',
    sessionId: 'session-3',
    requestedAt: Date.now() - 80_000,
    prompt: 'Which environment?',
    inputSchema: { type: 'string', enum: ['staging', 'production'] },
  });

  test('draws a choice question as options, answered by pressing one', async () => {
    const { container, findByRole } = open({ reviews: [CHOICES] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.tasks.respond', () => RESPONDED);
    await fireEvent.click(await findByRole('button', { name: 'production' }));
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      answer: 'production',
    });
  });

  test('picks the numbered choice when a number key is pressed, and says the keys do', async () => {
    const { container, findByText, findByRole } = open({ reviews: [CHOICES] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.tasks.respond', () => RESPONDED);
    await findByRole('button', { name: 'staging' });
    await findByText(REVIEWS_COPY.pickHint);
    expect(press('2', true)).toBe(false);
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
    expect(press('2')).toBe(true);
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      answer: 'production',
    });
  });

  test('does nothing for a number past the last choice, or for a question with no choices', async () => {
    const { container, findByRole } = open({ reviews: [CHOICES] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByRole('button', { name: 'staging' });
    press('9');
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });

  test('sends a yes or no as the JSON the Bureau reads back', async () => {
    const yesNo = humanWaitFixture({
      id: 'human-wait:run-4:ship:0',
      runId: 'run-4',
      sessionId: 'session-4',
      prompt: 'Ship it?',
      inputSchema: { type: 'boolean' },
    });
    const { container, findByRole } = open({ reviews: [yesNo] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    stub?.on('bureau.tasks.respond', () => RESPONDED);
    await fireEvent.click(await findByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({ answer: 'true' });
  });
});

describe('an engine review', () => {
  test('is decided through its own form, and goes from the list', async () => {
    const { container, findByRole, getByLabelText } = open({ weftReviews: [weftPending()] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
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

  test('keeps its own decision form: the reviewer’s name, and no Deny and no reason', async () => {
    const { container, findByRole, getByLabelText } = open({ weftReviews: [weftPending()] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    expect(await findByRole('button', { name: 'Submit decision' })).not.toBeNull();
    expect(getByLabelText(/Reviewer/)).not.toBeNull();
    expect(container.textContent).not.toContain('Reason (required to reject)');
  });

  test('links to the workflow it is a review of, in its source line', async () => {
    const { container, findByTestId } = open({ weftReviews: [weftPending()] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    const source = await findByTestId('review-source');
    expect(source.querySelectorAll('a')[0]?.getAttribute('href')).toBe(
      '/runs/wf_4a9f8c31e7b2d05a6f912c10',
    );
  });

  test('is not decided by the keys, which approve and deny a tool', async () => {
    const { container, findByRole } = open({ weftReviews: [weftPending()] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    await findByRole('button', { name: 'Submit decision' });
    press('a');
    press('d');
    expect(stub?.weftDecisions).toEqual([]);
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
  });
});

describe('the Done tab', () => {
  const resolution = (decision: 'approve' | 'deny', at: number) => ({
    decision,
    decidedBy: 'steve',
    decidedAt: at,
    ...(decision === 'deny' ? { reason: 'Wrong customer.' } : {}),
  });
  const approved = toolApprovalFixture({
    id: 'approval:run-a:call-1',
    runId: 'run-a',
    sessionId: 'session-a',
    status: 'approved',
    resolution: resolution('approve', Date.now() - 60_000),
  });
  const denied = toolApprovalFixture({
    id: 'approval:run-b:call-1',
    runId: 'run-b',
    sessionId: 'session-b',
    status: 'denied',
    resolution: resolution('deny', Date.now() - 30_000),
  });
  const answered = humanWaitFixture({
    id: 'human-wait:run-c:environment:0',
    runId: 'run-c',
    sessionId: 'session-c',
    status: 'approved',
    resolution: { decidedBy: 'steve', decidedAt: Date.now() - 90_000, answerDigest: 'sha256:abc' },
  });
  const decidedEngine: ReviewListEntry = {
    status: 'completed',
    reviewId: 'weft-review-2',
    workflowId: 'wf_decided',
    artifact: {},
    reviewType: 'Contract approval',
    reviewers: ['ops@example.com'],
    allowPartial: false,
    createdAt: Date.now() - 400_000,
    decision: 'needs-changes',
    reviewer: 'ops@example.com',
    feedback: 'Fix clause 4.',
    timestamp: Date.now() - 120_000,
  };

  test('lists what was decided, the latest decision first, and not what is waiting', async () => {
    const { container, getByRole } = open(
      { reviews: [APPROVAL, approved, denied, answered], weftReviews: [decidedEngine] },
      AUTHORIZATION_SCOPES,
      '/reviews?tab=done',
    );
    await waitFor(() => expect(rows(container).length).toBe(4));
    expect(getByRole('tab', { name: 'Done', selected: true })).not.toBeNull();
    const labels = rows(container).map((row) => row.textContent ?? '');
    expect(labels[0]).toContain('Denied');
    expect(labels[1]).toContain('Approved');
    expect(labels[2]).toContain('Answered');
    expect(labels[3]).toContain('Changes requested');
    expect(container.textContent).not.toContain('Refund order-1001? Waiting');
    expect(
      stub?.callsTo('bureau.reviews.list').some((call) => call.params['status'] === 'resolved'),
    ).toBe(true);
  });

  test('is opened from the tab, and the Waiting tab does not list what is decided', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL, approved] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(await findByRole('tab', { name: 'Done' }));
    await waitFor(() => expect(router.search.get('tab')).toBe('done'));
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(rows(container)[0]?.textContent).toContain('Approved');
  });

  test('shows a decided review read only, with who decided it and the reason', async () => {
    const { container, queryByRole, findByTestId } = open(
      { reviews: [denied] },
      AUTHORIZATION_SCOPES,
      '/reviews?tab=done',
    );
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    const resolved = await findByTestId('review-resolution');
    expect(resolved.textContent).toContain('Denied');
    expect(resolved.textContent).toContain('steve');
    expect(resolved.textContent).toContain('Wrong customer.');
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(container.textContent).toContain('Refund');
  });

  test('says an answer was sent without showing it', async () => {
    const { container, findByTestId } = open(
      { reviews: [answered] },
      AUTHORIZATION_SCOPES,
      '/reviews?tab=done',
    );
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    const resolved = await findByTestId('review-resolution');
    expect(resolved.textContent).toContain(REVIEWS_COPY.answerRecorded);
    expect(container.textContent).not.toContain('sha256:abc');
    expect(container.querySelector('input, textarea')).toBeNull();
  });

  test('shows a decided workflow review with the decision and no form', async () => {
    const { container, queryByRole, findByTestId } = open(
      { weftReviews: [decidedEngine] },
      AUTHORIZATION_SCOPES,
      '/reviews?tab=done',
    );
    await waitFor(() => expect(rows(container).length).toBe(1));
    await openRow(container, 0);
    const resolved = await findByTestId('review-resolution');
    expect(resolved.textContent).toContain('Changes requested');
    expect(resolved.textContent).toContain('Fix clause 4.');
    expect(queryByRole('button', { name: 'Submit decision' })).toBeNull();
  });

  test('says nothing was decided with the first-use kind of empty state', async () => {
    const { findByText } = open({ reviews: [APPROVAL] }, AUTHORIZATION_SCOPES, '/reviews?tab=done');
    await findByText(REVIEWS_COPY.nothingDecided);
  });

  test('reads more when asked: a page at a time', async () => {
    const many = Array.from({ length: 27 }, (_, index) =>
      toolApprovalFixture({
        id: `approval:run-${String(index)}:call-1`,
        runId: `run-${String(index)}`,
        sessionId: `session-${String(index)}`,
        status: 'approved',
        resolution: resolution('approve', Date.now() - index * 1_000),
      }),
    );
    const { container, findByRole } = open(
      { reviews: many },
      AUTHORIZATION_SCOPES,
      '/reviews?tab=done',
    );
    await waitFor(() => expect(rows(container).length).toBe(25));
    await fireEvent.click(await findByRole('button', { name: REVIEWS_COPY.loadMore }));
    await waitFor(() => expect(rows(container).length).toBe(27));
    const resolved = stub
      ?.callsTo('bureau.reviews.list')
      .filter((call) => call.params['status'] === 'resolved');
    expect(resolved?.map((call) => call.params['pageToken'])).toEqual([undefined, '25']);
  });

  test('does not register the keys that decide a waiting review', async () => {
    const { container } = open({ reviews: [approved] }, AUTHORIZATION_SCOPES, '/reviews?tab=done');
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(press('a')).toBe(false);
  });
});
