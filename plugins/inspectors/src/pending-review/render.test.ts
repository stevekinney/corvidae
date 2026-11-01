import { describe, expect, it } from 'bun:test';

import { viewReview } from './model.ts';
import { renderReviews, type ReviewHandlers, type RowState } from './render.ts';

const review = {
  id: 'r<1>',
  runId: 'run-1',
  kind: 'tool-approval' as const,
  status: 'pending',
  agentName: '<b>worker</b>',
  requestedAt: 0,
  approval: { toolName: 'shell' },
};

function handlers(calls: string[]): ReviewHandlers {
  return {
    onDecide: (id, decision) => calls.push(`${decision}:${id}`),
    onOpenReject: (id) => calls.push(`open:${id}`),
    onCancelReject: (id) => calls.push(`cancel:${id}`),
    onDraft: (id, text) => calls.push(`draft:${id}:${text}`),
    onReject: (id) => calls.push(`reject:${id}`),
  };
}

describe('the pending-review page', () => {
  it('renders text as text, one labelled section per review, and a live region', () => {
    const root = document.createElement('div');
    document.body.append(root);
    renderReviews(root, [viewReview(review, 0)], new Map(), handlers([]), null, null);
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('h2')?.textContent).toContain('<b>worker</b>');
    expect(root.querySelector('section')?.getAttribute('aria-labelledby')).toBe('review-r<1>');
    expect(root.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toContain('worker');
    root.remove();
  });

  it('says so when nothing is waiting', () => {
    const root = document.createElement('div');
    renderReviews(root, [], new Map(), handlers([]), null, null);
    expect(root.textContent).toContain('Nothing is waiting for a decision.');
  });

  it('calls the handler once per click and disables every decision while one is in flight', () => {
    const calls: string[] = [];
    const root = document.createElement('div');
    renderReviews(root, [viewReview(review, 0)], new Map(), handlers(calls), null, null);
    const [approve] = [...root.querySelectorAll('button')];
    approve!.click();
    expect(calls).toEqual(['approve:r<1>']);
    const busy = new Map<string, RowState>([
      ['r<1>', { busy: true, outcome: null, rejecting: false, draft: '' }],
    ]);
    renderReviews(root, [viewReview(review, 0)], busy, handlers(calls), null, null);
    expect([...root.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  });

  it('offers no decision for an expired review', () => {
    const expired = {
      ...review,
      approval: {
        toolName: 'shell',
        action: { type: 'approval', expiresAt: '2026-01-01T00:00:00Z' },
      },
    };
    const root = document.createElement('div');
    renderReviews(
      root,
      [viewReview(expired, Date.parse('2026-01-02T00:00:00Z'))],
      new Map(),
      handlers([]),
      null,
      null,
    );
    expect(root.textContent).toContain('Expired');
    expect([...root.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  });

  it('requires a non-blank reason to send a rejection and keeps the draft across a redraw', () => {
    const calls: string[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    const open = (draft: string) =>
      new Map<string, RowState>([['r<1>', { busy: false, outcome: null, rejecting: true, draft }]]);
    renderReviews(root, [viewReview(review, 0)], open('  '), handlers(calls), null, null);
    const send = () =>
      [...root.querySelectorAll('button')].find(
        (button) => button.textContent === 'Send rejection',
      )!;
    expect(send().disabled).toBe(true);
    renderReviews(root, [viewReview(review, 0)], open('too risky'), handlers(calls), null, null);
    expect(send().disabled).toBe(false);
    expect(root.querySelector('textarea')?.value).toBe('too risky');
    expect(root.querySelector('label')?.getAttribute('for')).toBe('reason-r<1>');
    root.querySelector('textarea')!.focus();
    renderReviews(root, [viewReview(review, 0)], open('too risky'), handlers(calls), null, null);
    expect(document.activeElement).toBe(root.querySelector('textarea'));
    send().click();
    expect(calls).toEqual(['reject:r<1>']);
    root.remove();
  });
});
