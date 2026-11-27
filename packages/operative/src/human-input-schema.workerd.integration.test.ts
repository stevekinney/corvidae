import { withWorker } from '@lostgradient/workerd-testing';
import { expect, test } from 'bun:test';

const entry = new URL('./human-input-schema.workerd-fixture.test-support.ts', import.meta.url)
  .pathname;

test('validates accepting and refusing human-input answers under workerd', async () => {
  await withWorker({ entry }, async ({ dispatchFetch }) => {
    const acceptedResponse = await dispatchFetch('https://operative.test/accept');
    expect(await acceptedResponse.json()).toEqual({
      accepted: true,
      errors: 0,
    });
    const refusedResponse = await dispatchFetch('https://operative.test/refuse');
    expect(await refusedResponse.json()).toEqual({
      accepted: false,
      errors: 1,
    });
  });
});
