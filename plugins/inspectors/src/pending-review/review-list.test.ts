/// <reference lib="dom" />
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import { viewReview } from './model.ts';
import ReviewList from './review-list.svelte';
import { createReviewsView, type ReviewsView } from './view.svelte.ts';

const review = {
  id: 'r<1>',
  runId: 'run-1',
  kind: 'tool-approval' as const,
  status: 'pending',
  agentName: '<b>worker</b>',
  requestedAt: 0,
  approval: { toolName: 'shell' },
};

function open(views = [viewReview(review, 0)]) {
  const calls: string[] = [];
  const view: ReviewsView = createReviewsView();
  view.views = views;
  const handlers = {
    onDecide: (id: string, decision: 'approve' | 'deny') => calls.push(`${decision}:${id}`),
    onOpenReject: (id: string) => calls.push(`open:${id}`),
    onCancelReject: (id: string) => calls.push(`cancel:${id}`),
    onDraft: (id: string, text: string) => calls.push(`draft:${id}:${text}`),
    onReject: (id: string) => calls.push(`reject:${id}`),
  };
  return { view, calls, ...render(ReviewList, { props: { view, handlers } }) };
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

  it('calls the handler once per click and disables every decision while one is in flight', async () => {
    const { view, calls, getByRole } = open();
    (getByRole('button', { name: 'Approve' }) as HTMLButtonElement).click();
    expect(calls).toEqual(['approve:r<1>']);
    view.rows.set('r<1>', { busy: true, outcome: null, rejecting: false, draft: '' });
    await tick();
    for (const name of ['Approve', 'Deny', 'Reject with feedback']) {
      expect((getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
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

  it('shows what happened to a review under it, and in the live region', async () => {
    const { view, container } = open();
    view.rows.set('r<1>', {
      busy: false,
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
      view.rows.set('r<1>', { busy: false, outcome: null, rejecting: true, draft });
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
    view.views = [viewReview(review, 1)];
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
    view.rows.set('r<1>', { busy: false, outcome: null, rejecting: true, draft: '' });
    await tick();
    await fireEvent.input(getByLabelText('Feedback for the agent'), { target: { value: 'no' } });
    expect(calls).toEqual(['draft:r<1>:no']);
  });
});
