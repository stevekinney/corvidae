import { withWorker } from '@lostgradient/workerd-testing';
import { expect, test } from 'bun:test';

const entry = new URL('./human-input-schema.workerd-fixture.ts', import.meta.url).pathname;

test('validates accepting and refusing human-input answers under workerd', async () => {
  await withWorker({ entry }, async ({ dispatchFetch }) => {
    expect(await (await dispatchFetch('https://operative.test/accept')).json()).toEqual({
      accepted: true,
      errors: 0,
    });
    expect(await (await dispatchFetch('https://operative.test/refuse')).json()).toEqual({
      accepted: false,
      errors: 1,
    });
  });
});
