/**
 * The approval flow under Operative's own loop.
 *
 * The machinery these specs exercise — the signed `SignedPendingToolApproval`,
 * the host-owned toolbox, `/api/chat/resume`, the client's reconciliation —
 * already existed. What did not exist was proof that the run *parks* rather
 * than loops: that after a step produces an approval-gated tool call, the
 * response ends there with no further generate call, and control genuinely
 * returns to the client.
 *
 * The fixture's request counter is what makes that assertable. Rendering
 * cannot distinguish "parked" from "took another turn and happened to say
 * nothing"; a provider-call count can.
 *
 * Every count here is read only after the response has closed. An extra
 * generate call from a regressed stop condition would happen INSIDE that same
 * response, so sampling while the stream is still open could see a transient
 * 1 and pass on a run that was still going.
 */

import { expect, test, type Page } from '@playwright/test';

import { fixtureRequestCount, newFixtureMarker } from '../../fixture-probe';
import { gotoHydrated } from '../../page.svelte-test-helpers';
import {
  APPROVAL_FOLLOW_UP_TEXT,
  APPROVAL_NOTE_TEXT,
  fixtureMarker,
} from '../../streaming-fixture';

function postedApproval(value: unknown): {
  approval: { approvalToken: string; toolName: string };
  resolution: Record<string, unknown>;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected approval payload to be an object.');
  }
  const approval = Reflect.get(value, 'approval');
  if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) {
    throw new Error('Expected approval payload to include an approval object.');
  }
  const approvalToken = Reflect.get(approval, 'approvalToken');
  const toolName = Reflect.get(approval, 'toolName');
  if (typeof approvalToken !== 'string' || typeof toolName !== 'string') {
    throw new Error('Expected approval token and tool name to be strings.');
  }
  const resolution = Reflect.get(value, 'resolution');
  if (typeof resolution !== 'object' || resolution === null || Array.isArray(resolution)) {
    throw new Error('Expected approval payload to include a resolution object.');
  }
  return { approval: { approvalToken, toolName }, resolution: { ...resolution } };
}

/**
 * Whether this engine puts buttons in the tab order.
 *
 * On macOS, WebKit excludes buttons and links from Tab unless the OS-level
 * "Full Keyboard Access" setting is on — observed here as a Tab walk that
 * advances to the messages log (`tabindex="0"`) and then refuses to move on to
 * any button. A Tab assertion there measures the machine's settings, not the
 * page's markup. The config already carries the same shape of carve-out for
 * clipboard permissions.
 */
function tabOrderIncludesButtons(projectName: string): boolean {
  return !projectName.startsWith('webkit');
}

/**
 * Puts keyboard focus on one of the tool call's decision controls, and says
 * whether it got there through the tab order.
 *
 * Reachability is the claim `locator.press()` cannot make: Playwright focuses
 * the matched element before dispatching the key, so a control carrying
 * `tabindex="-1"` would still pass. Starting from the approval form's reason textbox makes this
 * a real statement about the tab order through Cinder's editable controls
 * before the decision buttons.
 */
async function focusDecisionControl(
  page: Page,
  projectName: string,
  name: 'Approve' | 'Deny' | 'Dismiss',
): Promise<void> {
  const chat = page.locator('#chatroom-demo-chat');
  const card = chat.getByRole('article', { name: 'Approval required for remember_note' });
  const target = card.getByRole('button', { name });

  await expect(target).toBeVisible();

  if (!tabOrderIncludesButtons(projectName)) {
    // Activation still runs from a real key event below; only the walk is
    // skipped, and only where it would assert the wrong thing.
    await target.focus();
    return;
  }

  await card.getByRole('textbox', { name: 'Reason' }).focus();
  for (let press = 0; press < 8; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  const focused = await page.evaluate(() =>
    document.activeElement === null
      ? 'nothing'
      : `${document.activeElement.tagName}[${document.activeElement.ariaLabel ?? document.activeElement.textContent?.trim() ?? ''}]`,
  );
  throw new Error(`Tab never reached ${name} from the approval form; focus rested on ${focused}`);
}

/**
 * Drives a turn to a settled park: the approval prompt on screen AND the
 * response closed.
 *
 * Both halves matter. The prompt alone says the descriptor rendered; the
 * closed response is what makes a provider count meaningful.
 */
async function parkOnApproval(page: Page): Promise<string> {
  const marker = newFixtureMarker();

  await gotoHydrated(page, '/');
  await page
    .getByRole('textbox', { name: 'Message' })
    .fill(`Remember something ${fixtureMarker('approval', marker)}`);
  await page.getByRole('button', { name: 'Send message' }).click();

  const chat = page.locator('#chatroom-demo-chat');
  await expect(chat.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Approve with edits' })).toHaveCount(0);
  // The cancel affordance only disappears once the response has closed, so
  // this is the settle signal — not a duration.
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);

  return marker;
}

test('parks after the approval-gated step, taking no further generate call', async ({ page }) => {
  const marker = await parkOnApproval(page);

  // One provider call for the whole turn, read after the response closed.
  // Without a stop condition covering a step that produced a tool call,
  // Operative would resolve the tool and take a second generate call to
  // narrate the result inside this same response — a billed turn the client
  // never asked for, and the shape that collides with the session
  // controller's own continuation loop.
  //
  // Which predicate fires is deliberately not claimed here. `chat-agent.ts`
  // documents that `stopAfterAnyToolCall` already covers every approval-gated
  // call, making `stopWhen.pendingApproval()` redundant on this path; a spec
  // cannot distinguish them without removing one. What is asserted is the
  // contract they exist to produce.
  expect(await fixtureRequestCount(marker)).toBe(1);
  await expect(page.getByTestId('demo-error')).toBeEmpty();
});

test('surfaces the pending approval descriptor as tool activity', async ({ page }) => {
  const marker = await parkOnApproval(page);
  const chat = page.locator('#chatroom-demo-chat');

  // `Action required` is the descriptor reaching the client, not a spinner
  // that happens to look similar: the Cinder timeline reports that state
  // because a `pendingApproval` rode the tool result over the wire.
  const toolActivity = chat.getByRole('region', { name: 'Called 1 tool' });
  await expect(toolActivity).toContainText('remember_note: Action required');
  await expect(toolActivity).toContainText('remember_note Waiting approval');

  // The tool's own name rides into both the activity card and approval card, so
  // this fails if the prompt renders from a generic placeholder rather than
  // from what the run actually parked on.
  await expect(
    chat.getByRole('article', { name: 'Approval required for remember_note' }),
  ).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Deny' })).toBeVisible();

  expect(await fixtureRequestCount(marker)).toBe(1);
});

test('approving resumes through the host-owned toolbox and the result rejoins the run', async ({
  page,
}) => {
  const marker = await parkOnApproval(page);
  const chat = page.locator('#chatroom-demo-chat');

  await page.getByLabel('Reason').fill('ship it');
  await page.getByLabel("Don't ask again for operations like this").check();
  const resumed = page.waitForResponse('**/api/chat/resume');
  await chat.getByRole('button', { name: 'Approve' }).click();
  const response = await resumed;

  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    outcome: 'success',
    content: { saved: true, text: APPROVAL_NOTE_TEXT },
  });

  // The token was minted by the streaming route and verified by the resume
  // route. `approvalSecret` is a per-process `crypto.randomUUID()` held by the
  // module in `$lib/toolbox`, so a resume route that built its own toolbox
  // would hold a different secret and reject this signature outright. A 200
  // with the tool's real output is that shared instance, observed at runtime;
  // `toolbox-ownership.test.ts` pins the structural half.
  const posted = postedApproval(JSON.parse(response.request().postData() ?? '{}'));
  expect(posted.approval.toolName).toBe('remember_note');
  expect(posted.approval.approvalToken).toMatch(/^[0-9a-f]{64}$/);
  expect(posted.resolution).toEqual({ decision: 'approve', reason: 'ship it', remember: true });

  // The resolved result is visible to the model on the next turn: the
  // follow-up text only exists on the fixture's second attempt.
  await expect(page.getByRole('log', { name: 'Messages' })).toContainText(APPROVAL_FOLLOW_UP_TEXT);
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  await expect(page.getByTestId('demo-error')).toBeEmpty();

  // Exactly one further generate call — the continuation, and nothing else.
  // That call happens because the client resumed, not because the run kept
  // going on its own.
  expect(await fixtureRequestCount(marker)).toBe(2);
});

test('approves from the keyboard alone', async ({ page }, testInfo) => {
  const marker = await parkOnApproval(page);

  // Reached through the tab order, then activated by a real key event. Both
  // halves matter: `.click()` would pass on a control no keyboard can reach,
  // and `locator.press()` alone would pass on one carrying `tabindex="-1"`.
  await focusDecisionControl(page, testInfo.project.name, 'Approve');

  const resumed = page.waitForResponse('**/api/chat/resume');
  await page.keyboard.press('Enter');
  const resumedResponse = await resumed;
  expect(resumedResponse.status()).toBe(200);

  await expect(page.getByRole('log', { name: 'Messages' })).toContainText(APPROVAL_FOLLOW_UP_TEXT);
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  expect(await fixtureRequestCount(marker)).toBe(2);
});

test('denying resumes through the host-owned toolbox without executing the tool', async ({
  page,
}, testInfo) => {
  const marker = await parkOnApproval(page);
  const chat = page.locator('#chatroom-demo-chat');

  await page.getByLabel('Reason').fill('policy says no');
  await page.getByLabel("Don't ask again for operations like this").check();
  await focusDecisionControl(page, testInfo.project.name, 'Deny');

  const resumed = page.waitForResponse('**/api/chat/resume');
  await page.keyboard.press('Enter');
  const response = await resumed;

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    outcome: 'error',
    content: 'The user denied this request.',
    error: { code: 'denied', category: 'permission' },
  });

  const posted = postedApproval(JSON.parse(response.request().postData() ?? '{}'));
  expect(posted.approval.toolName).toBe('remember_note');
  expect(posted.approval.approvalToken).toMatch(/^[0-9a-f]{64}$/);
  expect(posted.resolution).toEqual({
    decision: 'deny',
    reason: 'policy says no',
    remember: true,
  });

  await expect(chat.locator('.tool-call-group')).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Deny' })).toHaveCount(0);
  const settled = chat.getByRole('region', { name: 'Called 1 tool' });
  await expect(settled).toContainText('remember_note');
  await expect(settled).toContainText('Failed');
  await expect(page.getByTestId('demo-error')).toBeEmpty();

  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  expect(await fixtureRequestCount(marker)).toBe(2);
});

// The real `remember_note` producer does not set `editableArgs`, so the
// application browser correctly has no approve-with-edits affordance. The
// shared Cinder browser fixture and session/endpoint tests cover that full
// payload shape without fabricating producer metadata here.
test('dismissing resumes through the host-owned toolbox without executing the tool', async ({
  page,
}) => {
  const marker = await parkOnApproval(page);
  const chat = page.locator('#chatroom-demo-chat');

  await page.getByLabel('Reason').fill('not now');
  const resumed = page.waitForResponse('**/api/chat/resume');
  await chat.getByRole('button', { name: 'Dismiss' }).click();
  const response = await resumed;

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    outcome: 'error',
    content: 'The user cancelled this request.',
    error: { code: 'CANCELLED', category: 'cancelled' },
  });

  const posted = postedApproval(JSON.parse(response.request().postData() ?? '{}'));
  expect(posted.approval.toolName).toBe('remember_note');
  expect(posted.approval.approvalToken).toMatch(/^[0-9a-f]{64}$/);
  expect(posted.resolution).toEqual({ decision: 'cancel', reason: 'not now', remember: false });

  await expect(chat.locator('.tool-call-group')).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Deny' })).toHaveCount(0);
  const settled = chat.getByRole('region', { name: 'Called 1 tool' });
  await expect(settled).toContainText('remember_note');
  await expect(settled).toContainText('Failed');
  await expect(page.getByTestId('demo-error')).toBeEmpty();

  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  expect(await fixtureRequestCount(marker)).toBe(2);
});
