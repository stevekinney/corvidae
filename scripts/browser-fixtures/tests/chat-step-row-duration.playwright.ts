/**
 * The Chat step row's time takes the end of its line, measured in Chromium. The row's toggle is
 * Cinder's DisclosureTrigger (board row X3, COR-2440), whose label grows to fill the row, so the
 * summary's `margin-inline-start: auto` on the duration reaches the row's content edge.
 */
import { loadManifest, type Viewport } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const phone = { name: 'mobile', width: 375, height: 900 } as const satisfies Viewport;
const desktop = { name: 'desktop', width: 1280, height: 900 } as const satisfies Viewport;

const chatEntry = loadManifest().find((candidate) => candidate.slug === 'chat');
if (chatEntry === undefined) throw new Error('Cached testing manifest does not include "chat".');
const entry = chatEntry;
// Chat's route without a fixture name is not its assertion page: name it, as the screenshot sweep
// does, so the step row under the approval chat is the one measured.
const assertionFixture = entry.fixtures?.find((fixture) => fixture.name === 'assertion');
if (assertionFixture === undefined) throw new Error('Chat must expose its assertion fixture.');
const fixtureName = assertionFixture.name;
const fixtureContentHash = assertionFixture.fixtureContentHash;

test.describe('Chat step row', () => {
  for (const viewport of [phone, desktop]) {
    test(`the duration ends on the row's content edge at ${viewport.width}px`, async ({
      componentPage,
    }) => {
      const page = await componentPage.open({
        entry,
        theme: 'light',
        viewport,
        fixtureName,
        fixtureContentHash,
      });
      const toggle = page.locator('#fixture-tool-approval-chat .chat-tool-call-toggle').first();
      await expect(toggle.locator('.chat-tool-call-summary-duration')).toBeVisible();
      const read = await toggle.evaluate((element) => {
        const duration = element.querySelector('.chat-tool-call-summary-duration');
        const count = element.querySelector('.chat-tool-call-summary-count');
        if (duration == null || count == null) return null;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          contentRight:
            box.right -
            Number.parseFloat(style.borderRightWidth) -
            Number.parseFloat(style.paddingRight),
          durationRight: duration.getBoundingClientRect().right,
          countRight: count.getBoundingClientRect().right,
        };
      });
      expect(read).not.toBeNull();
      expect(Math.abs(read!.contentRight - read!.durationRight)).toBeLessThanOrEqual(2);
      // The count stays at the start, so the time is apart from it rather than beside it.
      expect(read!.durationRight - read!.countRight).toBeGreaterThan(100);
    });
  }
});
