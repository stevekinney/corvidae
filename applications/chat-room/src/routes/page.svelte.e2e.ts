import { expect, test } from '@playwright/test';
import { gotoHydrated } from './page.svelte-test-helpers';

test('sends a message and streams the assistant reply into the conversation log', async ({
  page,
}) => {
  await page.route('**/api/chat', async (route) => {
    const events = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there!' },
    ];
    const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n';

    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body,
    });
  });

  await gotoHydrated(page, '/');

  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeVisible();

  await composer.fill('Hello from Playwright');
  await page.getByRole('button', { name: 'Send message' }).click();

  const log = page.getByRole('log', { name: 'Messages' });
  await expect(log.getByText('Hello from Playwright')).toBeVisible();
  await expect(log.getByText('Hello there!')).toBeVisible();
});

test('stop generating aborts the in-flight request without surfacing an error', async ({
  page,
}) => {
  // A request that is never fulfilled keeps the turn in its streaming state
  // so Stop is clickable; the client-side abort is the only way it ends,
  // and Chromium reports that abort as a failed request.
  let requestAborted = false;
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/chat')) requestAborted = true;
  });
  await page.route('**/api/chat', () => {
    // Intentionally left pending — see above.
  });

  await gotoHydrated(page, '/');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Long question, interrupted');
  await page.getByRole('button', { name: 'Send message' }).click();

  await page.getByRole('button', { name: 'Stop generating' }).click();

  // Streaming state fully unwinds: the composer is sendable again and the error
  // region is EMPTY — a user-initiated stop is not a failure.
  //
  // Empty rather than absent, and that is the point of ROADMAP A11Y-3: the page
  // banner is now permanently mounted with no text, because a live region has to
  // exist before the content arrives or the announcement is not reliably made.
  // Counting alerts would now count that empty region and report a failure the
  // user never saw; asserting its TEXT is what the claim was always about.
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(page.getByTestId('demo-error')).toBeEmpty();
  await expect.poll(() => requestAborted).toBe(true);
});

test('editing a user message rewinds the superseded branch and resends', async ({ page }) => {
  const replies = ['First reply.', 'Second reply.'];
  const requestBodies: string[] = [];
  await page.route('**/api/chat', async (route) => {
    requestBodies.push(route.request().postData() ?? '');
    const text = replies[requestBodies.length - 1] ?? 'Extra reply.';
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: JSON.stringify({ type: 'text', text }) + '\n',
    });
  });

  await gotoHydrated(page, '/');
  const chat = page.locator('#chatroom-demo-chat');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Original question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(chat.getByText('First reply.')).toBeVisible();

  const editButton = chat.getByRole('button', { name: 'Edit message' });
  await editButton.focus();
  await editButton.click();
  const editBox = chat.getByRole('textbox', { name: 'Edit message content' });
  await editBox.fill('Edited question');
  await chat.getByRole('button', { name: 'Save & Resend' }).click();

  await expect(chat.getByText('Second reply.')).toBeVisible();
  // The superseded branch is gone from the transcript…
  await expect(chat.getByText('Original question')).toHaveCount(0);
  await expect(chat.getByText('First reply.')).toHaveCount(0);
  // …and from the payload the model sees: the resent conversation contains
  // the edited content and none of the superseded messages.
  expect(requestBodies).toHaveLength(2);
  expect(requestBodies[1]).toContain('Edited question');
  expect(requestBodies[1]).not.toContain('Original question');
  expect(requestBodies[1]).not.toContain('First reply.');
});

test('retry after a failed send re-runs the assistant turn', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat', async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ status: 500, body: 'Simulated upstream failure' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: JSON.stringify({ type: 'text', text: 'Recovered reply.' }) + '\n',
    });
  });

  await gotoHydrated(page, '/');
  const chat = page.locator('#chatroom-demo-chat');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Please fail once');
  await page.getByRole('button', { name: 'Send message' }).click();

  // Two alerts appear: the page-level error banner and Chat's own
  // "Failed to send" label on the failed user message.
  await expect(
    page.getByRole('alert').filter({ hasText: 'Simulated upstream failure' }),
  ).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Failed to send' })).toBeVisible();

  const retryButton = chat.getByRole('button', { name: 'Retry' });
  await retryButton.focus();
  await retryButton.click();

  await expect(chat.getByText('Recovered reply.')).toBeVisible();
  // Both the error banner and the failed mark clear on success. The banner
  // clears by emptying, not by unmounting — see the note in the stop-generating
  // test above.
  await expect(page.getByTestId('demo-error')).toBeEmpty();
  await expect(page.getByRole('alert').filter({ hasText: 'Failed to send' })).toHaveCount(0);
  expect(calls).toBe(2);
});

// ROADMAP HS-2, first half: the signature check on `/api/chat/resume`.
//
// This one needs no fixture and no API key, because armorer's verification is
// stateless — an HMAC over the descriptor the client submits, with no
// server-side pending-approval store to prime. So `/api/chat` can be mocked in
// the usual way while `/api/chat/resume` runs for real, which is the narrowest
// arrangement that still puts the real route, the real zod schema, and the real
// `toolbox.resumeApproval` on the path.
//
// What it pins that `/exercises/tool-approval` cannot: that exercise performs no
// network I/O at all and seeds approvals with no `pendingApproval` and no token,
// so it proves Chat's affordances and nothing about the round trip.
//
// The `pendingApproval` below is a forgery, but a faithful one — field for field
// the shape armorer really mints for `remember_note` (`reason` and `metadata`
// included, and a well-formed 64-character hex token), so a rejection here is
// the signature failing rather than the schema or the token's format.
test('a forged approvalToken is rejected by the real resume route', async ({ page }) => {
  const callId = 'call-forged-token';
  const approvalMessage = 'Save this note?';

  await page.route('**/api/chat', async (route) => {
    // Both lines matter: Chat renders the approval prompt on the tool-CALL
    // row with the result folded in, so a result on its own would never
    // surface an Approve button.
    const events = [
      { type: 'tool_call', id: callId, name: 'remember_note', arguments: { text: 'A note' } },
      {
        type: 'tool_result',
        callId,
        outcome: 'action_required',
        content: approvalMessage,
        action: { type: 'approval', message: approvalMessage },
        pendingApproval: {
          callId,
          toolName: 'remember_note',
          arguments: { text: 'A note' },
          action: { type: 'approval', message: approvalMessage },
          reason: approvalMessage,
          metadata: {},
          approvalToken: 'a'.repeat(64),
        },
      },
    ];

    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    });
  });

  await gotoHydrated(page, '/');
  const chat = page.locator('#chatroom-demo-chat');
  await page.getByRole('textbox', { name: 'Message' }).fill('Remember something for me');
  await page.getByRole('button', { name: 'Send message' }).click();

  const approve = chat.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeVisible();

  const resumed = page.waitForResponse('**/api/chat/resume');
  await approve.click();
  const response = await resumed;

  // The request shape is the client's, not the fixture's: `+page.svelte` builds
  // the `{ approval, decision }` envelope and decides what goes in it.
  const posted = JSON.parse(response.request().postData() ?? '{}');
  expect(posted.decision).toBe('approve');
  expect(posted.approval.callId).toBe(callId);
  expect(posted.approval.toolName).toBe('remember_note');
  expect(posted.approval.arguments).toEqual({ text: 'A note' });
  expect(posted.approval.action).toEqual({ type: 'approval', message: approvalMessage });
  expect(posted.approval.approvalToken).toBe('a'.repeat(64));

  // 500, not 400, is the load-bearing distinction. A 400 would mean the route's
  // zod schema rejected the envelope before verification ever ran, which is
  // what a client sending the wrong shape (a missing `approvalToken`, a bare
  // descriptor with no `decision`) produces. Reaching a 500 means the shape was
  // accepted and `toolbox.resumeApproval` threw on the signature.
  //
  // That the failure is a raw 500 rather than a 4xx is a gap in
  // `src/routes/api/chat/resume/+server.ts`, which does not catch armorer's
  // throw. Asserted as-is rather than papered over: tightening it is a change
  // to that route, and this assertion is what would catch the change.
  expect(response.status()).toBe(500);
  expect(await response.text()).not.toContain('Invalid request body');

  // The client surfaces the failure and leaves the transcript alone —
  // `replaceToolResult` never runs, so the result is still `action_required`.
  //
  // Chat's own prompt, by contrast, flips to "Approved": `approveToolCall`
  // resolves normally after setting `error`, so Chat's optimistic commit is
  // never rolled back. Consumer-side behavior, not a Chat defect — Chat rolls
  // back on a REJECTED adapter call, and this adapter does not reject.
  await expect(page.getByTestId('demo-error')).not.toBeEmpty();
  await expect(chat.locator('.tool-call-group')).toHaveAttribute('data-status', 'action-required');
});
