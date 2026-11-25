/// <reference lib="dom" />
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import { viewReview, type ReviewView } from './model.ts';
import ReviewList from './review-list.svelte';
import { createReviewsView, type ReviewsView } from './view.svelte.ts';

const review = {
  source: 'bureau' as const,
  id: 'r<1>',
  runId: 'run-1',
  sessionId: 'session-1',
  kind: 'tool-approval' as const,
  status: 'pending' as const,
  agentName: '<b>worker</b>',
  requestedAt: 0,
  ageMilliseconds: 0,
  round: 0,
  approval: {
    callId: 'call-1',
    toolName: 'shell',
    arguments: {},
    action: { type: 'input' as const },
  },
};

function open(views: ReviewView[] = [{ ...viewReview(review, 0), actionableReview: review }]) {
  const calls: string[] = [];
  const view: ReviewsView = createReviewsView();
  view.views = views;
  const handlers = {
    onOpenReject: (id: string) => calls.push(`open:${id}`),
    onCancelReject: (id: string) => calls.push(`cancel:${id}`),
    onDraft: (id: string, text: string) => calls.push(`draft:${id}:${text}`),
  };
  const actionsFor = () => ({
    disabled: false,
    canRemember: false,
    approve: () => calls.push(`approve:${review.id}`),
    deny: () => calls.push(`deny:${review.id}`),
    reject: () => calls.push(`reject:${review.id}`),
    remember() {},
    async reconcile() {},
  });
  return { view, calls, ...render(ReviewList, { props: { view, handlers, actionsFor } }) };
}

describe('the pending-review page, drawn with Cinder (COR-2218)', () => {
  it('renders text as text, one labelled section per review, and a live region', () => {
    const { container } = open();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toContain('<b>worker</b>');
    const section = container.querySelector('section');
    expect(container.querySelector(`#${section?.getAttribute('aria-labelledby')}`)?.tagName).toBe(
      'H2',
    );
    expect(container.querySelector('h1')?.textContent).toContain('Pending reviews (1)');
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toContain(
      'worker',
    );
  });

  it('is built from Cinder components, so it takes the host theme through the kit', () => {
    const { container } = open();
    expect(container.querySelector('.cinder-section')).not.toBeNull();
    expect(container.querySelectorAll('button.cinder-button')).toHaveLength(3);
  });

  it('says so when nothing is waiting', () => {
    const { container } = open([]);
    expect(container.textContent).toContain('Nothing is waiting for a decision.');
  });

  it('calls the shared approval action', async () => {
    const { calls, getByRole } = open();
    (getByRole('button', { name: 'Approve' }) as HTMLButtonElement).click();
    expect(calls).toEqual(['approve:r<1>']);
  });

  it('offers no decision for an expired review', () => {
    const expired = {
      ...review,
      approval: {
        toolName: 'shell',
        action: { type: 'approval', expiresAt: '2026-01-01T00:00:00Z' },
      },
    };
    const { container } = open([viewReview(expired, Date.parse('2026-01-02T00:00:00Z'))]);
    expect(container.textContent).toContain('Expired');
    expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  });

  it('keeps an uncorrelated snapshot without a round read-only', () => {
    const { round: _round, ...snapshot } = review;
    const { container } = open([viewReview(snapshot, 0)]);
    expect(container.querySelector('h2')?.textContent).toContain('worker');
    expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  });

  it('shows what happened to a review under it, and in the live region', async () => {
    const { view, container } = open();
    view.rows.set('r<1>', {
      outcome: 'Approved.',
      rejecting: false,
      draft: '',
    });
    view.announcement = 'Approved.';
    await tick();
    expect(container.querySelector('.panel-outcome')?.textContent).toBe('Approved.');
    expect(container.querySelector('#reviews-status')?.textContent?.trim()).toBe('Approved.');
  });

  it('requires a non-blank reason to send a rejection and keeps the draft and focus across a redraw', async () => {
    const { view, calls, container, getByLabelText, getByRole } = open();
    const rejecting = (draft: string) =>
      view.rows.set('r<1>', { outcome: null, rejecting: true, draft });
    rejecting('  ');
    await tick();
    const send = () => getByRole('button', { name: 'Send rejection' }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);

    rejecting('too risky');
    await tick();
    expect(send().disabled).toBe(false);
    const reason = getByLabelText('Feedback for the agent') as HTMLTextAreaElement;
    expect(reason.value).toBe('too risky');
    expect(container.querySelector('label')?.getAttribute('for')).toBe(reason.id);

    // A poll redraws the list: the reason box is the same element, with its text and the focus.
    reason.focus();
    reason.setSelectionRange(2, 5);
    view.views = [{ ...viewReview(review, 1), actionableReview: review }];
    view.announcement = '1 new review.';
    await tick();
    expect(getByLabelText('Feedback for the agent')).toBe(reason);
    expect(document.activeElement).toBe(reason);
    expect([reason.selectionStart, reason.selectionEnd]).toEqual([2, 5]);

    send().click();
    expect(calls).toEqual(['reject:r<1>']);
  });

  it('reports what is typed into the reason box', async () => {
    const { view, calls, getByLabelText } = open();
    view.rows.set('r<1>', { outcome: null, rejecting: true, draft: '' });
    await tick();
    await fireEvent.input(getByLabelText('Feedback for the agent'), { target: { value: 'no' } });
    expect(calls).toEqual(['draft:r<1>:no']);
  });
});
