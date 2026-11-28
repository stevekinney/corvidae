/**
 * Chat opens the failure explanation inline (COR-2543). A scripted agent asked to explain a failed
 * run calls `bureau:tasks-explain` on it, and Chat draws the failure explanation panel over that
 * call's result, in the tool-call row, from the answer the Bureau stored: the sentence, the cause,
 * the tries and what to do next.
 *
 * Captured for the design review in `/chats/:chat`'s `failure explanation inline` state. Not run on
 * this host (the browser suites run on GitHub, `main.yml`).
 */
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { EXPLAINER_AGENT_NAME, FAILING_AGENT_NAME } from './failure-explanation-agents.ts';
import { expect, test } from './fixtures.ts';
import { tasksOfSession } from './task-support.ts';

test.describe('/chats/:chat, the failure explanation in Chat', () => {
  const threads: string[] = [];

  test.afterEach(async () => {
    await deleteChats(threads.splice(0));
  });

  test('opens inline over the result of bureau:tasks-explain for a failed run', async ({
    page,
    request,
  }) => {
    const failing = newThreadId('failure-explanation-failed');
    threads.push(failing);
    // A fixed run id: the explained run's id is the chat's title, so a random one changed the
    // design-review capture on every run.
    await runToEnd(request, FAILING_AGENT_NAME, failing, 'Fail on purpose.', {
      runId: 'run-failure-explanation-failed',
    });
    const [failed] = await tasksOfSession(request, failing);
    expect(failed?.status).toBe('failed');

    // The run is the owner's own, so the explainer, running as the same owner, may read it.
    const thread = newThreadId('failure-explanation-chat');
    threads.push(thread);
    await runToEnd(request, EXPLAINER_AGENT_NAME, thread, `Explain run ${failed!.id}`);
    await page.goto(`/chats/${thread}`);

    const frame = page.frameLocator('iframe[title="Failure explanation"]');
    await expect(
      frame.getByRole('heading', { level: 1, name: 'Why this run failed' }),
    ).toBeVisible();
    await expect(frame.locator('[data-explanation="summary"]')).toHaveText(
      /^The (step ".+"|run) failed (because|for) /,
    );
    await expect(frame.locator('[data-explanation="remediation"]')).toContainText(
      'What to do next.',
    );
    await expect(
      page
        .getByRole('region', { name: 'Tool calls' })
        .getByRole('listitem')
        .filter({ has: page.locator('iframe[title="Failure explanation"]') }),
    ).toHaveCount(1);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'failure explanation inline',
      source: 'failure-explanation-chat.spec.ts',
    });
  });
});
