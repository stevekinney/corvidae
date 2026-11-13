/**
 * An open chat drawn by Chat's availability states on the real host (COR-2285): an existing chat
 * with no message yet is Chat's first-use state with the agent's description and its suggested
 * prompts, which send (row V1), and a chat deleted while its page is open is Chat's deleted state,
 * with All conversations and no composer (row V3). Loading, a canceled read and a read that failed
 * are drawn in `chat-page.spec.ts`, so the copies cannot drift. Each state is captured for the
 * design review at a phone's width and a desktop's.
 */
import { newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const SOURCE = 'chat-availability.spec.ts';
const AGENT = 'demo:assistant';
const PROMPT = 'Say hello';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 900 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('an existing chat with no message yet offers the agent’s prompts, and one sends (V1)', async ({
      page,
      request,
      checkA11y,
    }) => {
      const threadId = newThreadId('availability-empty');
      await runToEnd(request, AGENT, threadId, 'Hello');
      // The chat exists, and its history is read back empty: a chat whose messages were all
      // taken back, which this host has no quicker way to make.
      let emptied = true;
      await page.route(`**/bureau/ag-ui/threads/${threadId}/messages`, async (route) => {
        if (!emptied) return route.fallback();
        return route.fulfill({ json: { threadId, messages: [] } });
      });
      await page.goto(`/chats/${threadId}`);
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

      const empty = page.locator('.chat-empty');
      await expect(empty.getByRole('heading', { level: 2, name: 'No messages yet' })).toBeVisible();
      const prompts = empty.getByRole('group', { name: 'Suggested prompts' });
      await expect(prompts.getByRole('button', { name: PROMPT })).toBeVisible();
      await checkA11y(`an empty chat at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: 'empty with suggested prompts',
        source: SOURCE,
      });

      emptied = false;
      await prompts.getByRole('button', { name: PROMPT }).click();
      await expect(
        page.locator('[data-message-role="user"]').filter({ hasText: PROMPT }),
      ).toBeVisible();
      await expect(empty).toHaveCount(0);
    });

    test('a chat deleted while its page is open is the deleted state with All conversations (V3)', async ({
      page,
      request,
      checkA11y,
    }) => {
      const threadId = newThreadId('availability-deleted');
      await runToEnd(request, AGENT, threadId, 'Hello');
      await page.goto(`/chats/${threadId}`);
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();

      // Deleted elsewhere: the Bureau says so to the open page, which reads the chat again.
      await bureauCall(request, 'bureau.contexts.delete', { contextId: threadId });

      const state = page.locator('[data-chat-availability="deleted"]');
      await expect(state.getByRole('heading', { level: 2 })).toHaveText('This chat was deleted');
      await expect(state).toContainText('It no longer exists, so nothing more can be sent here.');
      await expect(page.getByRole('textbox', { name: /^Message/ })).toHaveCount(0);
      const back = state.getByRole('button', { name: 'All conversations' });
      await expect(back).toHaveAttribute('data-cinder-variant', 'primary');
      await checkA11y(`a deleted chat at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: 'deleted while open',
        source: SOURCE,
      });

      await back.click();
      await expect(page).toHaveURL(/\/chats$/);
    });
  });
}
