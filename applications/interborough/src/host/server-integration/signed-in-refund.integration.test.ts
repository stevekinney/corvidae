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
  } finally {
    await fixture.close();
  }
});
