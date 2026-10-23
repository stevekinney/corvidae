/**
 * `/reviews`: the Bureau's pending reviews as a to-do list, each its own sentence with its decision
 * inline, and the engine's pending reviews in their own section, over a Bureau that answers from a
 * table (`bureau-world.test-support.ts`).
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
  return container.querySelector('.ib-reviews__count')?.getAttribute('aria-label') ?? undefined;
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.ib-review')];
}

describe('the reviews page', () => {
  test('lists the Bureau’s reviews as sentences, and the engine’s in their own section, with one count', async () => {
    const { container, getByRole } = open({
      reviews: [APPROVAL, QUESTION],
      weftReviews: [weftPending()],
    });
    await waitFor(() => expect(rows(container).length).toBe(2));
    expect(container.querySelector('h1')?.textContent).toBe('Reviews');
    expect(countOf(container)).toBe('3 waiting on you');
    // The longest-waiting first, and each item is the question itself.
    expect(rows(container)[0]?.textContent).toContain('Refund order-1001?');
    expect(rows(container)[1]?.textContent).toContain('asks:');
    expect(getByRole('heading', { level: 2, name: REVIEWS_COPY.engineHeading })).not.toBeNull();
    expect(container.querySelector('.ib-reviews__engine')?.textContent).toContain(
      'Contract approval',
    );
  });

  test('has no state tabs, no Live toggle, and no Archive', async () => {
    const { container, queryByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    for (const name of ['Archive', 'Decided', 'Timed out']) {
      expect(queryByRole('radio', { name })).toBeNull();
    }
    expect(container.textContent).not.toContain('Live');
    expect(container.textContent).not.toContain('Archive');
    expect(container.querySelector('.ib-reviews__engine')).toBeNull();
  });

  test('shows no string twice, and no raw policy string', async () => {
    const { container } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    const reason = APPROVAL.approval.reason ?? '';
    if (reason !== '') expect(container.textContent?.split(reason).length).toBe(1);
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
    await waitFor(() => expect(rows(withScope.container).length).toBe(2));
    await waitFor(() => expect(withScope.container.textContent).toContain('Contract approval'));
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

  test('denies with a note as a rejection carrying the note, and without one as a plain denial', async () => {
    const { container, findByRole, getByLabelText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.input(getByLabelText(REVIEWS_COPY.noteLabel), {
      target: { value: 'Wrong order.' },
    });
    await fireEvent.click(await findByRole('button', { name: 'Deny' }));
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
    await findByText(new RegExp(REVIEWS_COPY.decisionFailed));
    expect(rows(container).length).toBe(1);
  });
});

describe('one source failing', () => {
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

  test('leaves the other’s reviews on the page, with the failing source’s own banner', async () => {
    const { container, findByText, getAllByText } = openFailing(
      new StubFault('EngineFailure', 500, 'The Bureau broke.'),
      { weftReviews: [weftPending()] },
    );
    await findByText('The Bureau broke.');
    await waitFor(() => expect(getAllByText('Contract approval').length).toBeGreaterThan(0));
    expect(container.querySelector('.ib-reviews__engine')).not.toBeNull();
    // The page itself is up: the frame did not turn the Bureau's failure into an error for it.
    expect(container.querySelector('[data-view="reviews"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
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
  test('shows what the approval would run: the command, the patch, and the files', async () => {
    const approval = toolApprovalFixture({
      requestedAt: Date.now() - 120_000,
      approval: {
        ...toolApprovalFixture().approval,
        action: {
          type: 'approval',
          message: 'Run it?',
          risk: 'high',
          operation: { kind: 'command', command: 'bun run deploy', filesTouched: ['dist/app.js'] },
        },
      },
    });
    const { container, findByRole, findByText } = open({ reviews: [approval] });
    await fireEvent.click(await findByRole('button', { name: REVIEWS_COPY.details }));
    await findByText('bun run deploy');
    expect(container.textContent).toContain('dist/app.js');
    expect(container.textContent).toContain(REVIEWS_COPY.operation.command);
  });

  test('keeps the inbox usable when the operation lists one path twice', async () => {
    const approval = toolApprovalFixture({
      requestedAt: Date.now() - 120_000,
      approval: {
        ...toolApprovalFixture().approval,
        action: {
          type: 'approval',
          message: 'Run it?',
          risk: 'high',
          operation: {
            kind: 'patch',
            command: 'bun run deploy',
            filesTouched: ['dist/app.js', 'dist/app.js'],
          },
        },
      },
    });
    const { container, findByRole, findByText } = open({ reviews: [approval] });
    await fireEvent.click(await findByRole('button', { name: REVIEWS_COPY.details }));
    await findByText('bun run deploy');
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.textContent).toContain('dist/app.js');
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
      const { container, findAllByRole, findByText, queryByText } = render(Harness, {
        props: {
          client: new HttpClient({ baseUrl: 'http://localhost/api' }),
          scopes: AUTHORIZATION_SCOPES,
        },
      } as never);
      await waitFor(() => expect(rows(container).length).toBe(1 + others));
      writeFails(world, decided.id);
      const reads = stub.callsTo('bureau.reviews.list').length;

      const approves = await findAllByRole('button', { name: 'Approve' });
      await fireEvent.click(approves[0]!);

      // The refetch drops the decided review, and the warning is still on the page.
      await waitFor(() => expect(rows(container).length).toBe(others));
      await findByText(REVIEWS_COPY.outcomeNotWritten.title);
      expect(container.textContent).toContain(REVIEWS_COPY.outcomeNotWritten.message);
      expect(queryByText(REVIEWS_COPY.decisionFailed)).toBeNull();
      expect(stub.callsTo('bureau.reviews.list').length).toBeGreaterThan(reads);
      // The other review, if any, has not taken the alert into its own item.
      expect(container.querySelectorAll('.ib-review [role="alert"]').length).toBe(0);
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
    const { container, findAllByRole, findByText } = open({ reviews: [first, second] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    stub?.on('bureau.reviews.resolve', () => {
      throw new Error('The Bureau broke.');
    });
    const approves = await findAllByRole('button', { name: 'Approve' });
    await fireEvent.click(approves[0]!);
    await findByText(new RegExp(REVIEWS_COPY.decisionFailed));

    expect(rows(container)[0]?.textContent).toContain(REVIEWS_COPY.decisionFailed);
    expect(rows(container)[1]?.textContent).not.toContain(REVIEWS_COPY.decisionFailed);
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
    await findByText(new RegExp(REVIEWS_COPY.answerFailed));
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
    await waitFor(() => expect(container.querySelector('.ib-reviews__engine')).not.toBeNull());
    await fireEvent.click(await findByRole('radio', { name: 'Approve' }));
    await fireEvent.input(getByLabelText(/Reviewer/), { target: { value: 'ops@example.com' } });
    await fireEvent.click(await findByRole('button', { name: 'Submit decision' }));
    await waitFor(() => expect(stub?.weftDecisions.length).toBe(1));
    expect(stub?.weftDecisions[0]).toMatchObject({
      reviewId: 'weft-review-1',
      body: { decision: 'approved', reviewer: 'ops@example.com' },
    });
    await waitFor(() => expect(container.querySelectorAll('.ib-reviews__engine').length).toBe(0));
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
  });

  test('keeps its own decision form, with the reviewer’s name and the sections', async () => {
    const { container, findByRole, getByLabelText } = open({
      weftReviews: [weftPending()],
    });
    await waitFor(() => expect(container.querySelector('.ib-reviews__engine')).not.toBeNull());
    expect(await findByRole('button', { name: 'Submit decision' })).not.toBeNull();
    expect(getByLabelText(/Reviewer/)).not.toBeNull();
    // It is not the Bureau's form: there is no Deny, and no reason to give.
    expect(container.textContent).not.toContain('Reason (required to reject)');
  });

  test('links to the run it is a review of', async () => {
    const { container } = open({ weftReviews: [weftPending()] });
    await waitFor(() => expect(container.querySelector('.ib-reviews__engine')).not.toBeNull());
    expect(container.querySelector('.weft-review-detail a')?.getAttribute('href')).toBe(
      '/runs/wf_4a9f8c31e7b2d05a6f912c10',
    );
  });

  test('leaves out a decided review, because the page lists only what waits on someone', async () => {
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
    const { container } = open({ reviews: [APPROVAL], weftReviews: [decided] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(container.querySelector('.ib-reviews__engine')).toBeNull();
    expect(container.textContent).not.toContain('wf_decid');
  });
});
