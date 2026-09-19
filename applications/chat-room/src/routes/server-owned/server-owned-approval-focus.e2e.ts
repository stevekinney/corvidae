import { expect, test } from '@playwright/test';
import {
  askOnStream,
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
  pushFrame,
  resolveOnStream,
  serveStreamFromTest,
  uniqueTitle,
} from './server-owned-approval-focus-test-helpers';

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

test('answering keeps focus inside the chat', async ({ page }) => {
  // Every path that clears the question removes the focused subtree, and a
  // browser then drops focus to `<body>` — outside the chat's tab context, at
  // the moment the turn resumes. Asserted on the RESULT rather than on the
  // handler, because three separate paths clear `pending` and only one of
  // them used to hand focus off.
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Approval focus');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  const marker = newFixtureMarker();
  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval', marker));
  await composer.press('Enter');

  const approve = page.locator('[data-testid="approval-approve"]');
  await expect(approve).toBeVisible();

  // FOCUSED BY KEYBOARD, not clicked — a click leaves focus wherever the
  // browser decides, which would let this pass without the handoff.
  await approve.focus();
  await expect(approve).toBeFocused();
  await approve.press('Enter');

  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );

  // NOT `<body>`. The visible transcript is where the consequence of the
  // decision is announced, so it is where focus belongs. It must remain a
  // real, visible focus target after the approval subtree is removed.
  const landed = page.getByRole('log', { name: 'Messages' });
  await expect(landed).toBeFocused();
  await expect(landed).toBeVisible();
  const landedGeometry = await landed.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: rectangle.width,
      height: rectangle.height,
      focusIndicator:
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none',
    };
  });
  expect(landedGeometry.width).toBeGreaterThan(1);
  expect(landedGeometry.height).toBeGreaterThan(1);
  expect(landedGeometry.focusIndicator).toBe(true);
});

test('a remote answer hands focus back when the stream removes the controls', async ({
  page,
  request,
}) => {
  // UNCHANGED BY THE POLL'S REMOVAL, and that is the finding worth recording.
  // A second client answers the question over the real endpoint; this client
  // used to notice on its next 250ms read and now is told, because settling
  // the question makes the run write `elicitation.resolved`. The race is the
  // same, the delivery is not, and the assertion did not have to move.
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Remote approval focus');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval', newFixtureMarker()));
  await composer.press('Enter');
  const approve = page.locator('[data-testid="approval-approve"]');
  await expect(approve).toBeVisible();
  await approve.focus();

  // The detail page does not expose its id as an attribute; derive it from the
  // current URL so the second client answers the exact question being polled.
  const conversationId = new URL(page.url()).pathname.split('/').at(-1);
  if (conversationId === undefined) throw new Error('conversation id missing from detail URL');
  const pending = await request.get(
    `/api/server-owned/conversations/${conversationId}/elicitation`,
  );
  const body = objectRecord(await pending.json(), 'pending approval response');
  const pendingApproval = objectRecord(body['pending'], 'pending approval');
  const callId = pendingApproval['callId'];
  if (typeof callId !== 'string') throw new Error('Expected pending approval callId.');
  await request.post(`/api/server-owned/conversations/${conversationId}/elicitation`, {
    data: { approved: false, callId },
  });

  await expect(approve).toHaveCount(0);
  const landed = page.getByRole('log', { name: 'Messages' });
  await expect(landed).toBeFocused();
  await expect(landed).toBeVisible();
  const landedGeometry = await landed.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: rectangle.width,
      height: rectangle.height,
      focusIndicator:
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none',
    };
  });
  expect(landedGeometry.width).toBeGreaterThan(1);
  expect(landedGeometry.height).toBeGreaterThan(1);
  expect(landedGeometry.focusIndicator).toBe(true);
});

test('a remote replacement hands focus back when the pending call changes', async ({ page }) => {
  // A REPLACEMENT IS STILL REACHABLE, so this still has to be pinned. The gate
  // asks about each gated call in turn: one question resolves and the next
  // registers under a new id, and a person whose focus is on Approve must be
  // moved to the new question rather than left pressing a control that now
  // means something else.
  //
  // What changed is how the replacement is DELIVERED. It used to be fabricated
  // as a `GET …/elicitation` body, because that poll was how the component
  // discovered anything; now a question arrives as `elicitation.requested` and
  // leaves as `elicitation.resolved`, so the replacement is pushed onto the
  // response body instead. The local fixture emits exactly one gated call, so
  // the test serves the turn itself — see `serveStreamFromTest`.
  await serveStreamFromTest(page);
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Replacement approval focus');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');
  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');

  const first = { requestId: 'request-a', callId: 'remote-call-a', message: 'Save this note?' };
  await askOnStream(page, first);

  const approve = page.locator('[data-testid="approval-approve"]');
  await expect(approve).toBeVisible();
  await approve.focus();

  // The run moves on: the first question settles and the second registers.
  await resolveOnStream(page, first);
  await askOnStream(page, {
    requestId: 'request-b',
    callId: 'remote-call-b',
    message: 'Save the replacement note?',
  });

  await expect(page.locator('[data-testid="approval-question"]')).toContainText(
    'Save the replacement note?',
  );
  await expect(page.locator('[data-testid="approval-question"]')).toBeFocused();

  await pushFrame(page, { type: 'run.aborted' });
});
