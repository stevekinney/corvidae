import { bureau } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { createWorkflowFile, readWorkflow, removeWorkflow } from './workflow-support.ts';

const WORKFLOW_ID = 'cor-2034-chat-workflow';

test.describe('workflow revision review in Chat', () => {
  const threads: string[] = [];

  test.afterEach(async ({ request }) => {
    await deleteChats(threads.splice(0));
    await removeWorkflow(request, WORKFLOW_ID);
  });

  test('shows the scripted proposal inline and applies it with a fresh hash', async ({
    page,
    request,
  }) => {
    const created = await createWorkflowFile(request, WORKFLOW_ID);
    const thread = newThreadId('workflow-revision-apply');
    threads.push(thread);
    await runToEnd(request, 'workflow-revision', thread, `Propose a revision for ${WORKFLOW_ID}`);
    await page.goto(`/chats/${thread}`);

    const frame = page.frameLocator('iframe[title="Review workflow revision"]');
    await expect(frame.getByRole('heading', { name: 'Review workflow revision' })).toBeVisible();
    await expect(
      page
        .locator('.ib-tool')
        .filter({ has: page.locator('iframe[title="Review workflow revision"]') }),
    ).toHaveCount(1);
    await expect(
      frame.locator(
        '.revision-row[data-state="changed"], .revision-row[data-state="added"], .revision-row[data-state="removed"]',
      ),
    ).toHaveCount(4);
    const hostText = await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--cinder-text-default').trim(),
      );
    const hostMuted = await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--cinder-text-muted').trim(),
      );
    const framePrimary = await frame
      .locator('.revision-comparison')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--color-text-primary').trim(),
      );
    const frameText = await frame
      .locator('.revision-status')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--color-text-tertiary').trim(),
      );
    expect(hostText).not.toBe('');
    expect(framePrimary).toBe(hostText);
    expect(frameText).toBe(hostMuted);
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision proposal',
      source: 'workflow-revision-chat.spec.ts',
    });
    await page.setViewportSize({ width: 375, height: 720 });
    await expect(frame.getByRole('heading', { name: 'Review workflow revision' })).toBeVisible();
    await frame.getByRole('button', { name: 'Apply' }).scrollIntoViewIfNeeded();
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision proposal phone',
      source: 'workflow-revision-chat.spec.ts',
    });
    await frame.getByRole('button', { name: 'Apply' }).click();
    await expect(frame.getByRole('status')).toContainText('Applied. New hash:');
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision applied',
      source: 'workflow-revision-chat.spec.ts',
    });

    const updated = await readWorkflow(request, WORKFLOW_ID);
    expect(updated.hash).not.toBe(created.hash);
    expect(updated.text).toContain('approved');
  });

  test('preserves a concurrent writer and shows conflict on Apply', async ({ page, request }) => {
    const created = await createWorkflowFile(request, WORKFLOW_ID);
    const thread = newThreadId('workflow-revision-conflict');
    threads.push(thread);
    await runToEnd(request, 'workflow-revision', thread, `Propose a revision for ${WORKFLOW_ID}`);
    await page.goto(`/chats/${thread}`);

    let writerApplied = false;
    await page.route(
      '**/host/plugins/inspectors/apps/workflow-revision-review/tool-calls',
      async (route) => {
        const body = route.request().postDataJSON() as { name?: string };
        if (body.name === 'bureau.workflows.update' && !writerApplied) {
          writerApplied = true;
          const current = await readWorkflow(request, WORKFLOW_ID);
          await bureau(request, 'bureau.workflows.update', {
            id: WORKFLOW_ID,
            expectedHash: current.hash,
            definition: {
              trigger: { kind: 'signal', name: 'other-writer' },
              steps: [
                {
                  kind: 'activity',
                  handler: 'agent',
                  input: { agent: 'demo:assistant', message: 'Keep writer content.' },
                },
              ],
            },
          });
        }
        await route.continue();
      },
    );
    const frame = page.frameLocator('iframe[title="Review workflow revision"]');
    await frame.getByRole('button', { name: 'Apply' }).click();
    await expect(frame.getByRole('status')).toContainText('file changed since the proposal');
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision conflict',
      source: 'workflow-revision-chat.spec.ts',
    });
    const afterConflict = await readWorkflow(request, WORKFLOW_ID);
    expect(afterConflict.text).toContain('other-writer');
    expect(afterConflict.hash).not.toBe(created.hash);
  });

  test('captures no-change and applying lifecycle states', async ({ page, request }) => {
    await createWorkflowFile(request, WORKFLOW_ID);
    const thread = newThreadId('workflow-revision-no-change');
    threads.push(thread);
    await runToEnd(request, 'workflow-revision', thread, `no-change proposal for ${WORKFLOW_ID}`);
    await page.goto(`/chats/${thread}`);
    const frame = page.frameLocator('iframe[title="Review workflow revision"]');
    await expect(frame.getByRole('status')).toContainText('No changes in this proposal.');
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision no changes',
      source: 'workflow-revision-chat.spec.ts',
    });

    const applyingThread = newThreadId('workflow-revision-applying');
    threads.push(applyingThread);
    await runToEnd(
      request,
      'workflow-revision',
      applyingThread,
      `Propose a revision for ${WORKFLOW_ID}`,
    );
    await page.goto(`/chats/${applyingThread}`);
    const applyingFrame = page.frameLocator('iframe[title="Review workflow revision"]');
    await expect(applyingFrame.getByRole('button', { name: 'Apply' })).toBeEnabled();
    let releaseApply!: () => void;
    const applyHeld = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    await page.route(
      '**/host/plugins/inspectors/apps/workflow-revision-review/tool-calls',
      async (route) => {
        const body = route.request().postDataJSON() as { name?: string };
        if (body.name === 'bureau.workflows.update') {
          await applyHeld;
        }
        await route.continue();
      },
    );
    await applyingFrame.getByRole('button', { name: 'Apply' }).click();
    await expect(applyingFrame.getByRole('status')).toContainText('Applying the approved revision');
    await captureForDesignReview(page, {
      route: `/chats/${applyingThread}`,
      state: 'workflow revision applying',
      source: 'workflow-revision-chat.spec.ts',
    });
    releaseApply();
    await expect(applyingFrame.getByRole('status')).toContainText('Applied. New hash:');
    await page.unroute('**/host/plugins/inspectors/apps/workflow-revision-review/tool-calls');
  });

  test('captures applying, denied, offline, and unknown outcomes', async ({
    page,
    request,
    pageErrors,
  }) => {
    for (const outcome of ['denied', 'offline', 'unknown'] as const) {
      await createWorkflowFile(request, WORKFLOW_ID);
      const thread = newThreadId(`workflow-revision-${outcome}`);
      threads.push(thread);
      await runToEnd(request, 'workflow-revision', thread, `Propose a revision for ${WORKFLOW_ID}`);
      await page.goto(`/chats/${thread}`);
      const frame = page.frameLocator('iframe[title="Review workflow revision"]');
      await expect(frame.getByRole('button', { name: 'Apply' })).toBeEnabled();
      await page.route(
        '**/host/plugins/inspectors/apps/workflow-revision-review/tool-calls',
        async (route) => {
          const body = route.request().postDataJSON() as { name?: string };
          if (body.name !== 'bureau.workflows.update') return route.continue();
          if (outcome === 'offline') {
            pageErrors.expectEvery({
              pattern: /workflow-revision-review\/tool-calls/,
              reason: 'the test aborts the update request to simulate an offline host',
            });
            return route.abort();
          }
          if (outcome === 'denied') {
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                content: [{ type: 'text', text: 'Forbidden: access denied.' }],
                isError: true,
              }),
            });
          }
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ content: [{ type: 'text', text: 'Accepted.' }] }),
          });
        },
      );
      await frame.getByRole('button', { name: 'Apply' }).click();
      const expected =
        outcome === 'denied'
          ? 'You do not have access'
          : outcome === 'offline'
            ? 'Could not confirm'
            : 'unknown result';
      await expect(frame.getByRole('status')).toContainText(expected);
      await captureForDesignReview(page, {
        route: `/chats/${thread}`,
        state: `workflow revision ${outcome}`,
        source: 'workflow-revision-chat.spec.ts',
      });
      await page.unroute('**/host/plugins/inspectors/apps/workflow-revision-review/tool-calls');
      await removeWorkflow(request, WORKFLOW_ID);
    }
  });

  test('does not mount invalid or stale proposals', async ({ page, request, pageErrors }) => {
    const created = await createWorkflowFile(request, WORKFLOW_ID);
    const invalidThread = newThreadId('workflow-revision-invalid');
    threads.push(invalidThread);
    await runToEnd(
      request,
      'workflow-revision',
      invalidThread,
      `invalid proposal for ${WORKFLOW_ID}`,
    );
    await page.goto(`/chats/${invalidThread}`);
    await expect(page.locator('iframe[title="Review workflow revision"]')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: `/chats/${invalidThread}`,
      state: 'workflow revision inspectors disabled',
      source: 'workflow-revision-chat.spec.ts',
    });

    const failureThread = newThreadId('workflow-revision-resource-failure');
    threads.push(failureThread);
    await runToEnd(
      request,
      'workflow-revision',
      failureThread,
      `Propose a revision for ${WORKFLOW_ID}`,
    );
    await page.route('**/host/plugins/inspectors/apps/workflow-revision-review', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture resource failure' }),
      }),
    );
    pageErrors.expect({
      pattern: loggedFailedResponse(500, /workflow-revision-review/),
      reason: 'the test returns a failed inspector resource to capture the error state',
    });
    await page.goto(`/chats/${failureThread}`);
    await expect(page.locator('.mcp-app[data-state="error"]')).toBeVisible();
    await captureForDesignReview(page, {
      route: `/chats/${failureThread}`,
      state: 'workflow revision resource failure',
      source: 'workflow-revision-chat.spec.ts',
    });
    await page.unroute('**/host/plugins/inspectors/apps/workflow-revision-review');

    const loadingThread = newThreadId('workflow-revision-resource-loading');
    threads.push(loadingThread);
    await runToEnd(
      request,
      'workflow-revision',
      loadingThread,
      `Propose a revision for ${WORKFLOW_ID}`,
    );
    let releaseResource!: () => void;
    const resourceHeld = new Promise<void>((resolve) => {
      releaseResource = resolve;
    });
    await page.route('**/host/plugins/inspectors/apps/workflow-revision-review', async (route) => {
      await resourceHeld;
      await route.continue();
    });
    await page.goto(`/chats/${loadingThread}`);
    await expect(page.locator('.mcp-app[data-state="loading"]')).toBeVisible();
    await captureForDesignReview(page, {
      route: `/chats/${loadingThread}`,
      state: 'workflow revision resource loading',
      source: 'workflow-revision-chat.spec.ts',
    });
    releaseResource();
    await expect(page.locator('iframe[title="Review workflow revision"]')).toBeVisible();
    await page.unroute('**/host/plugins/inspectors/apps/workflow-revision-review');

    const changed = await readWorkflow(request, WORKFLOW_ID);
    await bureau(request, 'bureau.workflows.update', {
      id: WORKFLOW_ID,
      expectedHash: changed.hash,
      definition: {
        trigger: { kind: 'signal', name: 'stale-writer' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: { agent: 'demo:assistant', message: 'Change first.' },
          },
        ],
      },
    });
    const staleThread = newThreadId('workflow-revision-stale');
    threads.push(staleThread);
    await runToEnd(
      request,
      'workflow-revision',
      staleThread,
      `stale:${created.hash} proposal for ${WORKFLOW_ID}`,
    );
    await page.goto(`/chats/${staleThread}`);
    await expect(page.locator('iframe[title="Review workflow revision"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show tool calls' }).click();
    await expect(page.getByText('bureau__workflows-propose-update', { exact: true })).toBeVisible();
  });
});
