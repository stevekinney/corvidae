/**
 * The open chat's composer drawers on the sample world (COR-2284 C5 and C7, COR-2437): the offline
 * warning drawer above the box while the browser has no connection, which keeps the draft with
 * Send off, and the draft-restored drawer an open chat shows when it puts back what the person
 * typed and did not send, with when it was written and Discard draft. Neither state is one the
 * sample world holds at rest, so each is made in the browser (the context taken offline, a draft
 * typed and the page opened again) and captured for the design review under its own name, at 1280
 * and 375 pixels.
 */
import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, goOffline, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-composer-drawers.spec.ts';
const WIDTHS = [1280, 375] as const;
const CHAT = SAMPLE_WORLD_THREADS.sayHello;

for (const width of WIDTHS) {
  test(`an open chat puts back an unsent draft with the draft-restored drawer, and Discard draft forgets it, at ${width} pixels`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/chats/${CHAT}`);
    const composer = page.getByRole('textbox', { name: /message/i });
    await expect(composer).toBeEditable();
    await composer.fill('Draft the follow-up to the customer about order 4471');

    await page.reload();

    const drawer = page.locator('[data-chat-composer-drawer="draft-restored"]');
    await expect(drawer).toContainText('Restored your unsent draft from');
    await expect(composer).toHaveValue('Draft the follow-up to the customer about order 4471');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'draft restored',
      source: SOURCE,
    });

    await drawer.getByRole('button', { name: 'Discard draft' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(composer).toHaveValue('');
    await page.reload();
    await expect(composer).toBeEditable();
    await expect(page.locator('[data-chat-composer-drawer="draft-restored"]')).toHaveCount(0);
  });

  test(`an open chat keeps the draft under the offline warning drawer with Send off, at ${width} pixels`, async ({
    page,
    context,
    pageErrors,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/chats/${CHAT}`);
    const composer = page.getByRole('textbox', { name: /message/i });
    await expect(composer).toBeEditable();
    await composer.fill('Is the refund for 4471 through?');

    await goOffline(context, pageErrors);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    const drawer = page.locator('[data-chat-composer-drawer="offline"]');
    await expect(drawer).toContainText('Your draft is saved here');
    await expect(composer).toHaveValue('Is the refund for 4471 through?');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'offline drawer',
      source: SOURCE,
    });

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(drawer).toHaveCount(0);
    await expect(composer).toHaveValue('Is the refund for 4471 through?');
    await composer.fill('');
  });
}
