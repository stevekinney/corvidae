import { expect, test } from '@playwright/test';
import {
  APPROVAL_NOTE_TEXT,
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
  readCreatedConversation,
  readPendingApproval,
  uniqueTitle,
} from './server-owned-test-helpers';

test('the detail route offers the recovery question and names its backing store', async ({
  page,
  request,
}) => {
  // A BROWSER test in this file rather than in `server-owned-streaming.e2e.ts`,
  // against that file's stated convention, and deliberately: the two WebKit
  // shards the streaming file sits in are at the 64-context ceiling with no
  // headroom, and nothing about this panel is engine-divergent — it is a fetch
  // and three branches of text. The alternative was rebalancing a shard to add
  // a test that gains nothing from three engines.
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Recovery panel') },
  });
  const conversation = await readCreatedConversation(created);

  await gotoHydrated(page, `/server-owned/${conversation.id}`);

  const status = page.locator('[data-testid="recovery-status"]');
  const durability = page.locator('[data-testid="recovery-durability"]');

  // Mounted and EMPTY before the question is asked. Both halves matter for the
  // same reason the error regions in `error-live-regions.e2e.ts` do: a live
  // region that appears with text already in it is not reliably announced.
  await expect(status).toHaveCount(1);
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toBeEmpty();
  await expect(status).toHaveAttribute('role', 'status');
  await expect(durability).toBeEmpty();

  // The panel is a disclosure, CLOSED by default — expanded it took enough of
  // the fixed-height column to squeeze the transcript to nothing on a short
  // viewport. Its regions are in the DOM either way, which is what the live
  // region rule needs; the control has to be revealed.
  await page.getByText('Durable recovery', { exact: true }).click();

  await page.locator('[data-testid="recovery-check"]').click();

  // The benign branch, which is the honest answer under in-memory storage —
  // and the ANNOUNCEMENT carries the storage, not just the paragraph beside
  // it. A screen reader hearing only "nothing resumable" would not learn that
  // in-memory storage could not have observed a previous run even if one had
  // existed.
  await expect(status).toContainText('The last successful recovery check found nothing resumable');
  await expect(status).toContainText('No run was in flight for this session when that check ran');
  await expect(status).toContainText('Storage is in memory');
  await expect(status).not.toContainText('No run is in flight');
  await expect(durability).toContainText('CHAT_ROOM_SERVER_OWNED_DATABASE');

  // RETAINED SNAPSHOT, not live turn state. Starting a turn parks the run on
  // approval, but the recovery panel is still reporting the earlier check. The
  // sentence must therefore stay point-in-time rather than visibly claiming no
  // run is in flight right now.
  const marker = newFixtureMarker();
  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval', marker));
  await composer.press('Enter');
  await expect(page.locator('[data-testid="approval-question"]')).toContainText('Save this note?');
  await expect(status).toContainText('The last successful recovery check found nothing resumable');
  await expect(status).not.toContainText('No run is in flight');
  await page.locator('[data-testid="approval-deny"]').click();
  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );

  // The orphan branch's list and its once-only note belong to the orphan
  // outcome alone. Asserting their ABSENCE here is what keeps the benign
  // answer from quietly growing a failure list.
  await expect(page.locator('[data-testid="recovery-failures"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="recovery-once"]')).toHaveCount(0);
});

test('answers nothing when no approval is pending, and refuses an answer to a question nobody asked', async ({
  request,
}) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Elicitation idle') },
  });
  const conversation = await readCreatedConversation(created);

  const idle = await request.get(`/api/server-owned/conversations/${conversation.id}/elicitation`);
  expect(idle.status()).toBe(200);
  // 200 with `pending: null`, not a 404: "nothing is being asked" is the
  // ordinary state, and a client polling during a turn would otherwise have to
  // treat the routine answer as an error.
  expect(await idle.json()).toEqual({ pending: null });

  const unsolicited = await request.post(
    `/api/server-owned/conversations/${conversation.id}/elicitation`,
    { data: { approved: true, callId: 'toolu_nothing_pending' } },
  );
  // 409, not a silent 200. The conversation exists; what is absent is a
  // question — so this answer arrived after the run ended or after another
  // client answered first, and a 200 would tell the caller its click landed.
  expect(unsolicited.status()).toBe(409);
  expect(await unsolicited.json()).toEqual({
    error: 'This conversation is not waiting on an approval.',
  });
});

test('rejects a malformed approval body at the boundary', async ({ request }) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Elicitation malformed') },
  });
  const conversation = await readCreatedConversation(created);

  // Validated where the contract is owned, before it can propagate into a
  // generic downstream failure — the same rule the turn endpoint follows.
  const wrongType = await request.post(
    `/api/server-owned/conversations/${conversation.id}/elicitation`,
    { data: { approved: 'yes', callId: 'toolu_1' } },
  );
  expect(wrongType.status()).toBe(400);

  // A missing `callId` is rejected too. It is what binds an answer to the
  // question it was shown for, so an answer without one could settle whatever
  // happens to be pending.
  const noCallId = await request.post(
    `/api/server-owned/conversations/${conversation.id}/elicitation`,
    { data: { approved: true } },
  );
  expect(noCallId.status()).toBe(400);

  const notJson = await request.post(
    `/api/server-owned/conversations/${conversation.id}/elicitation`,
    { headers: { 'content-type': 'application/json' }, data: 'not json at all' },
  );
  expect(notJson.status()).toBe(400);

  const missing = await request.post('/api/server-owned/conversations/nope/elicitation', {
    data: { approved: true },
  });
  expect(missing.status()).toBe(404);
});

test('a person approving the note lets the tool run', async ({ request }) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Elicitation approved') },
  });
  const conversation = await readCreatedConversation(created);

  const marker = newFixtureMarker();
  // NOT awaited yet. The run parks inside its step waiting on the question, so
  // awaiting the stream here would deadlock against the answer below — which
  // is the whole difference from the browser-owned route, where the run STOPS
  // and the client starts a second request.
  const turn = request.post(`/api/server-owned/conversations/${conversation.id}/stream`, {
    data: { text: fixtureMarker('approval', marker) },
  });

  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/server-owned/conversations/${conversation.id}/elicitation`,
        );
        return readPendingApproval(response);
      },
      { message: 'the run never asked for approval' },
    )
    .not.toBeNull();
  const asked = await request.get(`/api/server-owned/conversations/${conversation.id}/elicitation`);
  const question = await readPendingApproval(asked);
  expect(question).not.toBeNull();
  if (question === null) throw new Error('Expected approval question to be pending.');
  expect(question.toolName).toBe('remember_note');
  expect(question.message).toBe('Save this note?');
  // The MODEL'S proposed arguments, so the person is approving a specific note
  // rather than a category of action.
  expect(question.arguments['text']).toBe(APPROVAL_NOTE_TEXT);

  const answered = await request.post(
    `/api/server-owned/conversations/${conversation.id}/elicitation`,
    { data: { approved: true, callId: question.callId } },
  );
  expect(answered.status()).toBe(200);

  const turnResponse = await turn;
  const body = await turnResponse.text();
  // The tool RAN, which is the claim: an approval that produced no settled
  // result would mean the hook let the call through and something else dropped
  // it.
  expect(body).toContain('"type":"tool.settled"');
  expect(body).toContain('"outcome":"success"');
  expect(body).toContain(APPROVAL_NOTE_TEXT);
  expect(body).toContain('"type":"run.completed"');
});

test('a person denying the note drops the call without failing the run', async ({ request }) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Elicitation denied') },
  });
  const conversation = await readCreatedConversation(created);

  const marker = newFixtureMarker();
  const turn = request.post(`/api/server-owned/conversations/${conversation.id}/stream`, {
    data: { text: fixtureMarker('approval', marker) },
  });

  await expect
    .poll(async () => {
      const response = await request.get(
        `/api/server-owned/conversations/${conversation.id}/elicitation`,
      );
      return readPendingApproval(response);
    })
    .not.toBeNull();

  const asked = await request.get(`/api/server-owned/conversations/${conversation.id}/elicitation`);
  const pending = await readPendingApproval(asked);
  expect(pending).not.toBeNull();
  if (pending === null) throw new Error('Expected approval question to be pending.');

  await request.post(`/api/server-owned/conversations/${conversation.id}/elicitation`, {
    data: { approved: false, callId: pending.callId },
  });

  const turnResponse = await turn;
  const body = await turnResponse.text();
  // The model PROPOSED the call, and the denial is REPORTED rather than left
  // as an absence. This assertion used to pin `not.toContain('tool.settled')`,
  // which described the defect instead of the contract: Operative seals a
  // filtered call in the conversation but dispatches no event, so the client's
  // pending tool row stayed pending until another turn or a reload cleared it.
  expect(body).toContain('"type":"tool_call"');
  expect(body).toContain('"type":"tool_result"');
  expect(body).toContain('"outcome":"error"');
  expect(body).toContain('did not run');

  // And the run COMPLETED. `ctx.elicit` returns `null` rather than throwing, so
  // a denial is the hook's decision and not a terminal — which is the
  // difference from `ElicitationDeniedError`, the shape a denial takes when a
  // tool throws on one.
  expect(body).toContain('"type":"run.completed"');
  expect(body).not.toContain('"type":"run.error"');

  // The question is gone either way, so the next turn can ask its own.
  const afterwards = await request.get(
    `/api/server-owned/conversations/${conversation.id}/elicitation`,
  );
  expect(await afterwards.json()).toEqual({ pending: null });
});
