import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';

/**
 * COR-2725, RunStates R6: the outcome of a turn that ends on its steps (no assistant message) is
 * drawn on Chat's anchor, and the anchor takes the whole transcript column, as a reply-carried
 * outcome does, so Try again, Retry, Continue and Discard share the column's inline-end edge with
 * the steps and the alerts above them. The fixture is `fixtures/chat.svelte` behind
 * `?turnOutcome=<kind>`.
 *
 * Run: `bun --cwd components/chat run test:browser -- --grep "turn outcome anchor"`
 */
async function open(page: Page, kind: string): Promise<void> {
  const url = new URL(
    fixtureRoute('chat'),
    environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
  );
  url.searchParams.set('turnOutcome', kind);
  await page.goto(url.href);
}

for (const width of [1280, 768, 375, 320]) {
  test.describe(`turn outcome anchor at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const kind of ['stopped', 'failed', 'empty', 'reconnecting'] as const) {
      test(`the ${kind} outcome takes the transcript column to its inline-end edge`, async ({
        page,
      }) => {
        await open(page, kind);
        const chat = page.getByTestId('chat-turn-outcome-anchor');
        // A refused Retry now is what keeps a reconnecting anchor on screen: it says so, once.
        if (kind === 'reconnecting') {
          await chat.getByRole('button', { name: 'Retry now' }).click();
          await expect(chat.locator('.chat-turn-command-failure')).toHaveCount(1);
        }
        const anchor = chat.locator('.chat-message-wrapper[data-turn-anchor]');
        await expect(anchor).toBeVisible();
        if (kind !== 'reconnecting') {
          await expect(chat.locator(`.chat-turn-outcome[data-kind="${kind}"]`)).toHaveCount(1);
        }

        const edges = await anchor.evaluate((element) => {
          const column = element.parentElement!;
          const style = getComputedStyle(column);
          const columnRight =
            column.getBoundingClientRect().right -
            Number.parseFloat(style.paddingInlineEnd || '0') -
            Number.parseFloat(style.borderInlineEndWidth || '0');
          const columnLeft =
            column.getBoundingClientRect().left +
            Number.parseFloat(style.paddingInlineStart || '0') +
            Number.parseFloat(style.borderInlineStartWidth || '0');
          const box = element.getBoundingClientRect();
          return { right: box.right, left: box.left, columnRight, columnLeft };
        });
        expect(Math.abs(edges.right - edges.columnRight)).toBeLessThanOrEqual(1);
        expect(Math.abs(edges.left - edges.columnLeft)).toBeLessThanOrEqual(1);
      });
    }
  });
}
