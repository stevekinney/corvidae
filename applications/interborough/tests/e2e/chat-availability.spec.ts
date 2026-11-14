/**
 * An open chat drawn by Chat's availability states on the real host (COR-2285): an existing chat
 * with no message yet is Chat's first-use state with the agent's description and its suggested
 * prompts, which send (row V1), and a chat deleted while its page is open is Chat's deleted state,
 * with All conversations and no composer (row V3). With no model provider (row V4), on the sample
 * world, an empty chat is Chat's Connect a model provider state, and a chat with history stays
 * readable, its approval answerable, with only the composer replaced. Loading, a canceled read and a read that failed
 * are drawn in `chat-page.spec.ts`, so the copies cannot drift. Each state is captured for the
 * design review at a phone's width and a desktop's.
 */
import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
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
      pageErrors,
    }) => {
      // Once the chat is gone, whatever the page reads of it again (its history, its run) answers
      // not found, as many times as the page happens to ask.
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(404, /\/bureau\//),
        reason: 'the test deletes the chat the page has open, so its reads of it answer not found',
      });
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

// The sample world holds no provider key, and Tool runner needs a model (V4).
test.describe('no model provider, on the sample world (V4)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const viewport of VIEWPORTS) {
    test(`an empty chat is Connect a model provider with a primary Connect provider, at ${viewport.width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize(viewport);
      await page.goto('/chats/new?agent=tool-runner');

      const state = page.locator('[data-chat-availability="unconfigured"]');
      await expect(state.getByRole('heading', { level: 2 })).toHaveText('Connect a model provider');
      const connect = state.getByRole('button', { name: 'Connect provider' });
      await expect(connect).toHaveAttribute('data-cinder-variant', 'primary');
      await expect(page.getByRole('textbox', { name: /^Message/ })).toBeHidden();
      await checkA11y(`an empty chat with no provider at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats/new',
        state: 'no model provider, empty',
        source: SOURCE,
      });

      await connect.click();
      await expect(page).toHaveURL(/\/settings\/models$/);
    });

    test(`a chat with history stays readable and answerable, and only the composer asks for a provider, at ${viewport.width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize(viewport);
      await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);

      // The conversation and its waiting approval are there, and nothing stands in their place.
      const approval = page.locator('[data-approval-decision]');
      await expect(approval).toBeVisible();
      for (const name of ['Approve', 'Deny']) {
        await expect(approval.getByRole('button', { name })).toBeEnabled();
      }
      await expect(page.locator('[data-chat-availability]')).toHaveCount(0);
      // The composer is one blocked row with the same words and the primary action.
      const row = page.locator('[data-chat-composer-status="blocked"]');
      await expect(row).toContainText('Connect a model provider');
      await expect(row.getByRole('button', { name: 'Connect provider' })).toHaveAttribute(
        'data-cinder-variant',
        'primary',
      );
      await expect(page.getByRole('textbox', { name: /^Message/ })).toHaveCount(0);
      await checkA11y(`a chat with history and no provider at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: 'no model provider, with history',
        source: SOURCE,
      });
    });
  }
});
