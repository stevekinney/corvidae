import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect, test } from 'bun:test';
import { startSignedInRefundFixture } from './signed-in-refund.test-support.ts';

test('starts a signed-in reviewer and a separately requested refund', async () => {
  const fixture = await startSignedInRefundFixture();
  try {
    const cookie = await fixture.signIn();
    const id = await fixture.requestRefund();
    const response = await fixture.send('/host/plugins/inspectors/apps/pending-review/tool-calls', {
      method: 'POST',
      headers: { cookie, origin: 'https://settings.example', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bureau.reviews.get', arguments: { id } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      structuredContent: { id },
      _meta: { 'interborough.reviewEligibility': [{ id, round: 0 }] },
    });
    const session = await fixture.send('/auth/session', { headers: { cookie } });
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const decision = await fixture.send('/host/plugins/inspectors/apps/pending-review/tool-calls', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://settings.example',
        'x-csrf-token': csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bureau.reviews.resolve',
        arguments: { id, round: 0, decision: 'approve' },
      }),
    });
    expect(await decision.json()).toMatchObject({ structuredContent: { receipt: 'superseded' } });
    const replacement = await fixture.send(
      '/host/plugins/inspectors/apps/pending-review/tool-calls',
      {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://settings.example',
          'x-csrf-token': csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'bureau.reviews.resolve',
          arguments: { id, round: 1, decision: 'approve' },
        }),
      },
    );
    expect(await replacement.json()).toMatchObject({ structuredContent: { receipt: 'applied' } });
    await waitUntil(async () => (await fixture.refundStatus()) === 'provider-pending');
    const readEffect = async () => {
      const answer = await fixture.send('/host/plugins/inspectors/apps/pending-review/tool-calls', {
        method: 'POST',
        headers: { cookie, origin: 'https://settings.example', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'bureau.reviews.get', arguments: { id } }),
      });
      return answer.json();
    };
    expect(await readEffect()).toMatchObject({
      structuredContent: { status: 'approved', effect: { status: 'provider-pending' } },
    });
    await fixture.settleRefund();
    expect(await fixture.refundStatus()).toBe('succeeded');
    expect(await readEffect()).toMatchObject({
      structuredContent: { status: 'approved', effect: { status: 'succeeded' } },
    });
  } finally {
    await fixture.close();
  }
});
