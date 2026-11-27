import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * COR-2725, RunStates R6: the outcome of a turn that ends on its steps (no assistant message) is
 * drawn on Chat's anchor, and the anchor is as wide as a reply-carried outcome of the same state
 * (the two Chats of `fixtures/chat.svelte` behind `?turnOutcome=<kind>`: one whose run only called
 * tools, one whose assistant message carries the outcome). The row, and the outcome box inside it,
 * share the reply's inline-start and inline-end edges, and never run past the transcript column.
 *
 * Run: `bun run --cwd components/chat test:browser --grep "turn outcome anchor"`
 */
async function open(page: Page, kind: string): Promise<void> {
  const url = new URL(
    fixtureRoute('chat'),
    environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
  );
  url.searchParams.set('turnOutcome', kind);
  await page.goto(url.href);
}

interface Edges {
  readonly left: number;
  readonly right: number;
  readonly columnLeft: number;
  readonly columnRight: number;
}

/** One evaluation reads both rows and the content box of the column each stands in. */
async function edgesOf(anchor: Locator, reply: Locator): Promise<{ anchor: Edges; reply: Edges }> {
  const anchorHandle = await anchor.elementHandle();
  const replyHandle = await reply.elementHandle();
  if (anchorHandle === null || replyHandle === null) throw new Error('A row is not on the page.');
  return anchor.page().evaluate(
    ([anchorElement, replyElement]) => {
      const read = (element: Element): Edges => {
        const column = element.parentElement!;
        const style = getComputedStyle(column);
        const box = element.getBoundingClientRect();
        const columnBox = column.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          columnLeft:
            columnBox.left +
            Number.parseFloat(style.paddingInlineStart || '0') +
            Number.parseFloat(style.borderInlineStartWidth || '0'),
          columnRight:
            columnBox.right -
            Number.parseFloat(style.paddingInlineEnd || '0') -
            Number.parseFloat(style.borderInlineEndWidth || '0'),
        };
      };
      return { anchor: read(anchorElement!), reply: read(replyElement!) };
    },
    [anchorHandle, replyHandle],
  );
}

for (const width of [1280, 768, 375, 320]) {
  test.describe(`turn outcome anchor at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const kind of ['stopped', 'failed', 'empty', 'reconnecting'] as const) {
      test(`the ${kind} outcome is as wide as a reply-carried one`, async ({ page }) => {
        await open(page, kind);
        const steps = page.getByTestId('chat-turn-outcome-anchor');
        const reply = page.getByTestId('chat-turn-outcome-reply');
        // A refused Retry now is what keeps a reconnecting anchor on screen: it says so, once.
        if (kind === 'reconnecting') {
          await steps.getByRole('button', { name: 'Retry now' }).click();
          await expect(steps.locator('.chat-turn-command-failure')).toHaveCount(1);
        }
        const anchorRow = steps.locator('.chat-message-wrapper[data-turn-anchor]');
        await expect(anchorRow).toBeVisible();
        const replyRow =
          kind === 'reconnecting'
            ? reply.locator('.chat-message-wrapper[data-role="assistant"]')
            : reply.locator('.chat-message-wrapper:has(.chat-turn-outcome)');
        await expect(replyRow).toBeVisible();

        const rows = await edgesOf(anchorRow, replyRow);
        expect(Math.abs(rows.anchor.right - rows.reply.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(rows.anchor.left - rows.reply.left)).toBeLessThanOrEqual(1);
        expect(rows.anchor.right).toBeLessThanOrEqual(rows.anchor.columnRight + 1);
        expect(rows.anchor.left).toBeGreaterThanOrEqual(rows.anchor.columnLeft - 1);

        if (kind !== 'reconnecting') {
          // The visible outcome box (the pill row, the alert, the dashed row) is the same width too.
          const anchorBox = steps.locator(`.chat-turn-outcome[data-kind="${kind}"]`);
          const replyBox = reply.locator(`.chat-turn-outcome[data-kind="${kind}"]`);
          const boxes = await edgesOf(anchorBox, replyBox);
          expect(Math.abs(boxes.anchor.right - boxes.reply.right)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxes.anchor.left - boxes.reply.left)).toBeLessThanOrEqual(1);
        }
      });
    }
  });
}
