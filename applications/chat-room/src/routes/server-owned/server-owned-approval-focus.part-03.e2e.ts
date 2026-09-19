import { expect, test } from '@playwright/test';
import {
  askOnStream,
  assertApprovedPost,
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
  pushFrame,
  resolveOnStream,
  serveStreamFromTest,
  uniqueTitle,
  type Page,
} from './server-owned-approval-focus-test-helpers';

const FIRST = { requestId: 'request-a', callId: 'call-a', message: 'Save this note?' };
const SECOND = {
  requestId: 'request-b',
  callId: 'replacement-call',
  message: 'Save the replacement note?',
};

/** Opens a conversation whose streaming turn this test serves itself. */
async function openStreamedTurn(page: Page, label: string): Promise<void> {
  await serveStreamFromTest(page);
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle(label);
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');
  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');
}

test('allows the replacement approval to submit while the first POST is stalled', async ({
  page,
}) => {
  // The race is unchanged and still reachable: a question is replaced while the
  // answer to the one before it is still in flight, and the stale POST landing
  // afterwards must not touch the replacement's controls. Only the DELIVERY
  // moved — the replacement used to be fabricated as a poll body and is now
  // pushed onto the response as `elicitation.resolved` then
  // `elicitation.requested`, which is how a real gate raises the next question.
  await openStreamedTurn(page, 'Approval replacement while pending');

  const question = page.locator('[data-testid="approval-question"]');
  const approve = page.locator('[data-testid="approval-approve"]');

  let postNumber = 0;
  let releaseA!: () => void;
  let releaseB!: () => void;
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    postNumber += 1;
    assertApprovedPost(route, postNumber === 2 ? SECOND.callId : FIRST.callId);
    await new Promise<void>((resolve) => {
      if (postNumber === 1) releaseA = resolve;
      else releaseB = resolve;
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await askOnStream(page, FIRST);
  await expect(approve).toBeVisible();
  await approve.focus();
  await approve.press('Enter');
  await expect.poll(() => postNumber).toBe(1);

  await resolveOnStream(page, FIRST);
  await askOnStream(page, SECOND);
  await expect(question).toContainText('replacement note');
  await expect(approve).toBeEnabled();

  await approve.press('Enter');
  await expect.poll(() => postNumber).toBe(2);

  // The FIRST answer lands now, for a question nobody is looking at. It must
  // not re-enable, clear, or otherwise touch the replacement's controls, which
  // are mid-decision of their own.
  releaseA();
  await expect(approve).toHaveAttribute('aria-disabled', 'true');

  releaseB();
  await expect(approve).toHaveCount(0);

  await pushFrame(page, { type: 'run.aborted' });
});

test('clears a decision error when a remote answer removes its question', async ({ page }) => {
  // Also unchanged in substance. A second client answers while this one is
  // showing a failed decision, and the banner must go with the question it
  // described rather than outliving it. The removal reaches this client as
  // `elicitation.resolved` instead of as an emptied poll body.
  await openStreamedTurn(page, 'Approval remote error cleanup');

  const approve = page.locator('[data-testid="approval-approve"]');
  const failure = page.locator('[data-testid="server-owned-turn-failure"]');

  let releasePost!: () => void;
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    assertApprovedPost(route, FIRST.callId);
    await new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'approval service unavailable' }),
    });
  });

  await askOnStream(page, FIRST);
  await expect(approve).toBeVisible();
  await approve.click();
  await expect.poll(() => releasePost !== undefined).toBe(true);
  releasePost();
  await expect(failure).toContainText('approval service unavailable');

  await resolveOnStream(page, FIRST);
  await expect(approve).toHaveCount(0);
  await expect(failure).toBeEmpty();

  await pushFrame(page, { type: 'run.aborted' });
});

test('a failed read never replaces an actionable decision failure', async ({ page }) => {
  // THE INVARIANT SURVIVED ITS DRIVER. This used to be called "poll recovery",
  // and it cycled a failing and then succeeding 250ms read past a decision
  // failure to prove neither replaced nor cleared it. There is no cycle any
  // more, but both reads still exist and both can still land while a decision
  // failure is on screen: the one that hydrates a question's proposed
  // arguments, and the one a 409 triggers to re-read the current question.
  //
  // A failed read is secondary context — it means the arguments did not
  // arrive, never that the decision failed — so it must not take the banner
  // from an error the person can actually act on. And a later SUCCESSFUL read
  // must not clear that banner either, because it does not own it.
  await openStreamedTurn(page, 'Approval read error ownership');

  const approve = page.locator('[data-testid="approval-approve"]');
  const failure = page.locator('[data-testid="server-owned-turn-failure"]');

  let reads = 0;
  let readsSettled = 0;
  let releaseHydratingRead!: () => void;
  let posts = 0;
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() === 'GET') {
      reads += 1;
      if (reads === 1) {
        // Held open until a decision failure exists, so the two are on screen
        // at the same moment rather than in sequence.
        await new Promise<void>((resolve) => {
          releaseHydratingRead = resolve;
        });
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'read service unavailable' }),
        });
        readsSettled += 1;
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pending: {
            toolName: 'remember_note',
            callId: FIRST.callId,
            message: FIRST.message,
            arguments: { text: 'a note' },
          },
        }),
      });
      readsSettled += 1;
      return;
    }
    posts += 1;
    assertApprovedPost(route, FIRST.callId);
    if (posts === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'approval service unavailable' }),
      });
      return;
    }
    if (posts === 2) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'that approval has moved on' }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await askOnStream(page, FIRST);
  await expect(approve).toBeVisible();
  await expect.poll(() => reads).toBe(1);

  await approve.click();
  await expect(failure).toContainText('approval service unavailable');

  // The held read fails now. The actionable banner stays.
  releaseHydratingRead();
  await expect.poll(() => readsSettled).toBe(1);
  await expect(failure).toContainText('approval service unavailable');
  await expect(approve).toBeVisible();

  // A 409 triggers a re-read that SUCCEEDS. It does not own the banner either.
  await approve.click();
  await expect.poll(() => readsSettled).toBeGreaterThanOrEqual(2);
  await expect(failure).toContainText('approval service unavailable');

  // Only the answer actually succeeding clears it.
  await approve.click();
  await expect(failure).toBeEmpty();
  await expect(approve).toHaveCount(0);

  await pushFrame(page, { type: 'run.aborted' });
});
