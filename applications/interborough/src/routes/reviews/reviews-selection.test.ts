/**
 * `/reviews` as an inbox of two panes: the oldest waiting review opens on arrival where the panes
 * sit side by side (and nowhere else), a decision opens the next one and announces itself, Enter
 * takes focus into the open review without deciding it, the segments carry the counts, and the
 * states keep the header. The Bureau answers from a table (`bureau-world.test-support.ts`).
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { REVIEWS_COPY } from '../../app/copy.ts';
import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import Harness from './reviews-shell.test-harness.svelte';

let stub: BureauWorldStub | undefined;
let restoreMeasure: (() => void) | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  restoreMeasure?.();
  restoreMeasure = undefined;
  stub?.restore();
  stub = undefined;
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

function open(world: Partial<BureauWorld> = {}, address = '/reviews') {
  stub = installBureauWorld(emptyBureauWorld(world));
  router.navigate(address, { replace: true });
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

// The approval has waited longer than the question, so it is the oldest and is listed first.
const APPROVAL = toolApprovalFixture({ requestedAt: Date.now() - 120_000 });
const QUESTION = humanWaitFixture({ sessionId: 'session-2', requestedAt: Date.now() - 90_000 });
const APPROVAL_KEY = `bureau:${APPROVAL.id}`;
const QUESTION_KEY = `bureau:${QUESTION.id}`;

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-review-row]')];
}

/** The key of the row that holds focus, or `null` when focus is on no row. */
function focusedRowKey(): string | null {
  return (
    document.activeElement?.closest('[data-review-row]')?.getAttribute('data-review-row') ?? null
  );
}

describe('arriving at the inbox', () => {
  test('opens the oldest waiting review beside the list and writes it to the address', async () => {
    measuredAt(1200);
    const { container, findByRole } = open({ reviews: [QUESTION, APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    await findByRole('button', { name: 'Approve' });
    expect(router.search.get('review')).toBe(APPROVAL_KEY);
    expect(container.textContent).not.toContain(REVIEWS_COPY.noReviewSelected);
  });

  test('opens nothing when the panes show one at a time: the list is where a phone starts', async () => {
    measuredAt(400);
    const { container, queryByRole } = open({ reviews: [QUESTION, APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(router.search.get('review')).toBeNull();
  });

  test('keeps the review the address names, and does not open the oldest over it', async () => {
    measuredAt(1200);
    const { container, findByLabelText } = open(
      { reviews: [QUESTION, APPROVAL] },
      `/reviews?review=${encodeURIComponent(QUESTION_KEY)}`,
    );
    await waitFor(() => expect(rows(container).length).toBe(2));
    await findByLabelText('Your answer');
    expect(router.search.get('review')).toBe(QUESTION_KEY);
  });

  test('opens nothing in Done, which is read and not answered', async () => {
    measuredAt(1200);
    const approved = toolApprovalFixture({
      id: 'approval:run-a:call-1',
      runId: 'run-a',
      sessionId: 'session-a',
      status: 'approved',
      resolution: { decision: 'approve', decidedBy: 'tester', decidedAt: Date.now() - 60_000 },
    });
    const { container } = open({ reviews: [approved] }, '/reviews?tab=done');
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(router.search.get('review')).toBeNull();
  });
});

describe('the segments', () => {
  test('count what waits and what was decided, and follow a decision', async () => {
    const decided = toolApprovalFixture({
      id: 'approval:run-a:call-1',
      runId: 'run-a',
      sessionId: 'session-a',
      status: 'approved',
      resolution: { decision: 'approve', decidedBy: 'steve', decidedAt: Date.now() - 60_000 },
    });
    const { container, findByRole } = open({ reviews: [APPROVAL, QUESTION, decided] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    await findByRole('radio', { name: /^Waiting\s*,\s*2$/ });
    await findByRole('radio', { name: /^Done\s*,\s*1$/ });

    await fireEvent.click(rows(container)[0]!.querySelector('.cinder-selectable-row__primary')!);
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await findByRole('radio', { name: /^Waiting\s*,\s*1$/ });
    await findByRole('radio', { name: /^Done\s*,\s*2$/ });
  });
});

describe('deciding a review', () => {
  test('opens the next oldest, announces the decision, and puts focus on that row', async () => {
    measuredAt(1200);
    const { container, findByLabelText, findByRole, findByTestId } = open({
      reviews: [APPROVAL, QUESTION],
    });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(router.search.get('review')).toBe(QUESTION_KEY));
    await findByLabelText('Your answer');
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(rows(container)[0]?.getAttribute('data-review-row')).toBe(QUESTION_KEY);
    const announcement = await findByTestId('reviews-announcement');
    expect(announcement.getAttribute('aria-live')).toBe('polite');
    expect(announcement.textContent?.trim()).toBe(
      REVIEWS_COPY.announce(REVIEWS_COPY.announced.approved, 'Refund order-1001?'),
    );
    await waitFor(() => expect(focusedRowKey()).toBe(QUESTION_KEY));
  });

  test('keeps the announcement after the last review is decided and the list gives way to the empty state', async () => {
    measuredAt(1200);
    const { findByRole, findByTestId, findByText } = open({ reviews: [APPROVAL] });
    await fireEvent.click(await findByRole('button', { name: 'Deny' }));
    await findByText(REVIEWS_COPY.allCaughtUp);
    const announcement = await findByTestId('reviews-announcement');
    expect(announcement.textContent?.trim()).toBe(
      REVIEWS_COPY.announce(REVIEWS_COPY.announced.denied, 'Refund order-1001?'),
    );
  });

  test('is not announced as a review that is no longer waiting', async () => {
    measuredAt(1200);
    const { container, findByRole, queryByTestId } = open({ reviews: [APPROVAL, QUESTION] });
    await fireEvent.click(await findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(router.search.get('review')).toBe(QUESTION_KEY));
    expect(queryByTestId('review-gone')).toBeNull();
    expect(container.textContent).not.toContain(REVIEWS_COPY.noLongerWaiting.message);
  });
});

describe('Enter on a row', () => {
  test('takes focus into the note field of an approval and decides nothing', async () => {
    const { container, findByLabelText } = open({ reviews: [APPROVAL, QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(2));
    const primary = rows(container)[0]!.querySelector<HTMLElement>(
      '.cinder-selectable-row__primary',
    )!;
    // The keydown's default is cancelled, so the keypress that follows it in a browser reaches
    // nothing: it would otherwise press whatever holds focus by then.
    const notCancelled = await fireEvent.keyDown(primary, { key: 'Enter' });
    expect(notCancelled).toBe(false);
    const note = await findByLabelText(REVIEWS_COPY.noteLabel);
    await waitFor(() => expect(document.activeElement === note).toBe(true));
    expect(stub?.callsTo('bureau.reviews.resolve')).toEqual([]);
  });

  test('takes focus into the first choice of a question, and answers nothing', async () => {
    const choices = humanWaitFixture({
      id: 'human-wait:run-3:environment:0',
      runId: 'run-3',
      sessionId: 'session-3',
      requestedAt: Date.now() - 80_000,
      prompt: 'Which environment?',
      inputSchema: { type: 'string', enum: ['staging', 'production'] },
    });
    const { container, findByRole } = open({ reviews: [choices] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    const primary = rows(container)[0]!.querySelector<HTMLElement>(
      '.cinder-selectable-row__primary',
    )!;
    const notCancelled = await fireEvent.keyDown(primary, { key: 'Enter' });
    expect(notCancelled).toBe(false);
    const staging = await findByRole('button', { name: 'staging' });
    await waitFor(() => expect(document.activeElement === staging).toBe(true));
    expect(stub?.callsTo('bureau.tasks.respond')).toEqual([]);
  });
});

describe('an approval', () => {
  test('says what it wants to run and how risky that is, and offers the note as Add a note', async () => {
    const { container, findByTestId, getByLabelText, getByText } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(rows(container)[0]!.querySelector('.cinder-selectable-row__primary')!);
    const wants = await findByTestId('review-wants');
    expect(wants.textContent).toContain(REVIEWS_COPY.wantsToRun);
    expect(wants.textContent).toContain('Issue refund');
    expect(wants.querySelector('code')?.textContent).toBe('issue-refund');
    expect(wants.textContent).toContain(REVIEWS_COPY.risk.high);
    expect(
      getByText(REVIEWS_COPY.toolApproval, { selector: '.ib-review-pane__eyebrow' }),
    ).not.toBeNull();
    expect(getByLabelText(REVIEWS_COPY.noteLabel).getAttribute('placeholder')).toBe(
      REVIEWS_COPY.notePlaceholder,
    );
  });

  test('offers Allow for the rest of the chat', async () => {
    const { container, findByRole } = open({ reviews: [APPROVAL] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(rows(container)[0]!.querySelector('.cinder-selectable-row__primary')!);
    expect(await findByRole('button', { name: REVIEWS_COPY.allowForChat })).not.toBeNull();
  });

  test('does not offer it for a tool that asks every time, which allowing would not change', async () => {
    const always = toolApprovalFixture({
      requestedAt: Date.now() - 120_000,
      approval: {
        ...APPROVAL.approval,
        reason: 'Tool "issue-refund" (dangerous tier) requires approval (mode: always).',
      },
    });
    const { container, findByRole, queryByRole } = open({ reviews: [always] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(rows(container)[0]!.querySelector('.cinder-selectable-row__primary')!);
    await findByRole('button', { name: 'Approve' });
    expect(queryByRole('button', { name: REVIEWS_COPY.allowForChat })).toBeNull();
  });
});

describe('a question', () => {
  test('is introduced as a question from an agent', async () => {
    const { container, findByText } = open({ reviews: [QUESTION] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    await fireEvent.click(rows(container)[0]!.querySelector('.cinder-selectable-row__primary')!);
    await findByText(REVIEWS_COPY.questionEyebrow);
  });
});

describe('Done', () => {
  const approvedByYou = toolApprovalFixture({
    id: 'approval:run-a:call-1',
    runId: 'run-a',
    sessionId: 'session-a',
    status: 'approved',
    resolution: { decision: 'approve', decidedBy: 'tester', decidedAt: Date.now() - 60_000 },
  });
  const deniedByYou = toolApprovalFixture({
    id: 'approval:run-b:call-1',
    runId: 'run-b',
    sessionId: 'session-b',
    status: 'denied',
    resolution: { decision: 'deny', decidedBy: 'tester', decidedAt: Date.now() - 120_000 },
  });

  test('lists what was decided under its day, with the word and a dot, and "by you" for the caller', async () => {
    const { container } = open({ reviews: [approvedByYou, deniedByYou] }, '/reviews?tab=done');
    await waitFor(() => expect(rows(container).length).toBe(2));
    expect(container.textContent).toContain(REVIEWS_COPY.day.today);
    const [first, second] = rows(container);
    expect(first?.textContent).toContain('Approved by you');
    expect(second?.textContent).toContain('Denied by you');
    // Only an approval is a success: a decision is not a failure.
    expect(first?.querySelector('[data-cinder-status="success"]')).not.toBeNull();
    expect(second?.querySelector('[data-cinder-status="neutral"]')).not.toBeNull();
    expect(second?.querySelector('[data-cinder-status="success"]')).toBeNull();
  });
});

describe('nothing waiting', () => {
  test('keeps the header and the segments over a green empty state that covers questions', async () => {
    const decided = toolApprovalFixture({
      id: 'approval:run-a:call-1',
      status: 'approved',
      resolution: { decision: 'approve', decidedBy: 'tester', decidedAt: Date.now() - 60_000 },
    });
    const { container, findByRole, findByText, getByText } = open({ reviews: [decided] });
    await findByText(REVIEWS_COPY.allCaughtUp);
    expect(REVIEWS_COPY.allCaughtUp).toBe('Nothing waiting on you');
    expect(getByText(REVIEWS_COPY.nothingWaiting)).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('Reviews');
    expect(container.textContent).toContain(REVIEWS_COPY.description);
    expect(await findByRole('radio', { name: /^Waiting\s*,\s*0$/, checked: true })).not.toBeNull();
    expect(await findByRole('radio', { name: /^Done\s*,\s*1$/ })).not.toBeNull();
  });
});
