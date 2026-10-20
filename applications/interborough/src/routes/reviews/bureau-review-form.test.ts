/**
 * The decision form for a Bureau review (`bureau-review-form.svelte`), shaped for
 * `bureau.reviews.resolve`'s `{ id, decision, reason }`: approve, deny, or reject, with a reason a
 * rejection cannot be sent without.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import type { ReviewDecision } from '../../lib/bureau-reviews.ts';
import BureauReviewForm from './bureau-review-form.svelte';

afterEach(cleanup);

function mount(overrides: { submitting?: boolean } = {}) {
  const sent: Array<{ decision: ReviewDecision; reason?: string }> = [];
  const view = render(BureauReviewForm, {
    props: {
      reviewId: 'approval:run-1:call-1',
      submitting: overrides.submitting ?? false,
      onResolve: (decision: ReviewDecision, reason: string | undefined) =>
        void sent.push({ decision, ...(reason === undefined ? {} : { reason }) }),
    },
  });
  return { ...view, sent };
}

describe('the Bureau review form', () => {
  test('approves and denies without a reason', async () => {
    const { getByRole, sent } = mount();
    await fireEvent.click(getByRole('button', { name: 'Approve' }));
    await fireEvent.click(getByRole('button', { name: 'Deny' }));
    expect(sent).toEqual([{ decision: 'approve' }, { decision: 'deny' }]);
  });

  test('sends the reason with an approval or a denial when there is one', async () => {
    const { getByRole, getByLabelText, sent } = mount();
    await fireEvent.input(getByLabelText(/Reason/), { target: { value: 'Checked the order.' } });
    await fireEvent.click(getByRole('button', { name: 'Deny' }));
    expect(sent).toEqual([{ decision: 'deny', reason: 'Checked the order.' }]);
  });

  test('cannot reject without a reason, and a blank one is none', async () => {
    const { getByRole, getByLabelText, sent } = mount();
    const reject = getByRole('button', { name: 'Reject' });
    expect(reject.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(reject);
    expect(sent).toEqual([]);

    await fireEvent.input(getByLabelText(/Reason/), { target: { value: '   ' } });
    expect(getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(true);
  });

  test('rejects with the reason once there is one, trimmed', async () => {
    const { getByRole, getByLabelText, sent } = mount();
    await fireEvent.input(getByLabelText(/Reason/), { target: { value: '  Wrong customer.  ' } });
    const reject = getByRole('button', { name: 'Reject' });
    expect(reject.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(reject);
    expect(sent).toEqual([{ decision: 'reject', reason: 'Wrong customer.' }]);
  });

  test('holds every decision while one is being sent', async () => {
    const { getByRole, getByLabelText } = mount({ submitting: true });
    await fireEvent.input(getByLabelText(/Reason/), { target: { value: 'Because.' } });
    for (const name of ['Approve', 'Deny', 'Reject']) {
      expect(getByRole('button', { name }).hasAttribute('disabled'), name).toBe(true);
    }
  });
});
