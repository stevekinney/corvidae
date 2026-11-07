import { bureau } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { createWorkflowFile, readWorkflow, removeWorkflow } from './workflow-support.ts';

const WORKFLOW_ID = 'cor-2034-chat-workflow';

function proposedTextOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (typeof Reflect.get(value, 'proposedText') === 'string')
    return Reflect.get(value, 'proposedText');
  for (const child of Object.values(value)) {
    const found = proposedTextOf(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

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
    const created = await createWorkflowFile(request, WORKFLOW_ID, {
      description: 'Owner note: Platform Operations',
    });
    const thread = newThreadId('workflow-revision-apply');
    threads.push(thread);
    await runToEnd(request, 'workflow-revision', thread, `Propose a revision for ${WORKFLOW_ID}`);
    await page.goto(`/chats/${thread}`);

    const frame = page.frameLocator('iframe[title="Review workflow revision"]');
    await expect(frame.getByRole('heading', { name: 'Review workflow revision' })).toBeVisible();
    const messagesResponse = await request.get(
      `/bureau/ag-ui/threads/${encodeURIComponent(thread)}/messages`,
    );
    const messages = (await messagesResponse.json()) as { messages: unknown[] };
    const proposalText = proposedTextOf(messages);
    expect(proposalText).toContain('"agent": "workflow-revision"');
    expect(
      messages.messages.some((message) => {
        if (typeof message !== 'object' || message === null) return false;
        const calls = Reflect.get(message, 'toolCalls');
        return (
          Array.isArray(calls) &&
          calls.some((call) => {
            if (typeof call !== 'object' || call === null) return false;
            const functionValue = Reflect.get(call, 'function');
            if (typeof functionValue !== 'object' || functionValue === null) return false;
            const argumentsValue = Reflect.get(functionValue, 'arguments');
            return (
              Reflect.get(functionValue, 'name') === 'bureau__workflows-propose-update' &&
              typeof argumentsValue === 'string' &&
              !Object.hasOwn(JSON.parse(argumentsValue) as object, 'agent')
            );
          })
        );
      }),
    ).toBe(true);
    await expect(
      page
        .locator('.cinder-tool-call-rail__item')
        .filter({ has: page.locator('iframe[title="Review workflow revision"]') }),
    ).toHaveCount(1);
    await expect(
      frame.locator(
        '.revision-row[data-state="changed"], .revision-row[data-state="added"], .revision-row[data-state="removed"]',
      ),
    ).toHaveCount(4);
    await expect(
      frame.locator('.revision-value--proposed pre').filter({ hasText: 'workflow-revision' }),
    ).toBeVisible();
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
    await frame.locator('.revision-comparison').focus();
    await expect(frame.locator('.revision-comparison')).toBeFocused();
    const ringWidth = await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--cinder-ring-width').trim(),
      );
    const frameRing = await frame.locator('.revision-comparison').evaluate((element) => {
      const style = getComputedStyle(element);
      return { outline: style.outlineWidth, shadow: style.boxShadow };
    });
    expect(ringWidth).toBe('2px');
    expect(frameRing.outline).toBe(ringWidth);
    expect(frameRing.shadow).toMatch(/0px 0px 0px 2px/);
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision proposal',
      source: 'workflow-revision-chat.spec.ts',
    });
    const longValuesThread = newThreadId('workflow-revision-long-values');
    threads.push(longValuesThread);
    await runToEnd(
      request,
      'workflow-revision',
      longValuesThread,
      `long-values proposal for ${WORKFLOW_ID}`,
    );
    await page.setViewportSize({ width: 390, height: 1600 });
    await page.goto(`/chats/${longValuesThread}`);
    const longValuesFrame = page.frameLocator('iframe[title="Review workflow revision"]');
    await expect(longValuesFrame.getByRole('button', { name: 'Apply' })).toBeVisible();
    await captureForDesignReview(page, {
      route: `/chats/${longValuesThread}`,
      state: 'workflow revision long values',
      source: 'workflow-revision-chat.spec.ts',
    });
    await longValuesFrame.locator('.revision-comparison').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await captureForDesignReview(page, {
      route: `/chats/${longValuesThread}`,
      state: 'workflow revision long values scrolled',
      source: 'workflow-revision-chat.spec.ts',
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/chats/${thread}`);
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
    expect(updated.text).toBe(proposalText);
  });

  test('preserves a concurrent writer and shows conflict on Apply', async ({ page, request }) => {
    const created = await createWorkflowFile(request, WORKFLOW_ID, {
      description: 'Owner note: Platform Operations',
    });
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
    await createWorkflowFile(request, WORKFLOW_ID, {
      agent: 'workflow-revision',
      description: 'Owner note: Platform Operations',
    });
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
    let updateCalls = 0;
    const applyHeld = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    await page.route(
      '**/host/plugins/inspectors/apps/workflow-revision-review/tool-calls',
      async (route) => {
        const body = route.request().postDataJSON() as { name?: string };
        if (body.name === 'bureau.workflows.update') {
          updateCalls += 1;
          await applyHeld;
        }
        await route.continue();
      },
    );
    await applyingFrame.getByRole('button', { name: 'Apply' }).evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(applyingFrame.getByRole('status')).toContainText('Applying the approved revision');
    await expect(applyingFrame.getByRole('button', { name: 'Applying…' })).toBeDisabled();
    await captureForDesignReview(page, {
      route: `/chats/${applyingThread}`,
      state: 'workflow revision applying',
      source: 'workflow-revision-chat.spec.ts',
    });
    releaseApply();
    await expect(applyingFrame.getByRole('status')).toContainText('Applied. New hash:');
    expect(updateCalls).toBe(1);
    await page.unroute('**/host/plugins/inspectors/apps/workflow-revision-review/tool-calls');
  });

  test('captures applying, denied, offline, and unknown outcomes', async ({
    page,
    request,
    pageErrors,
  }) => {
    for (const outcome of ['denied', 'offline', 'unknown'] as const) {
      await createWorkflowFile(request, WORKFLOW_ID, {
        description: 'Owner note: Platform Operations',
      });
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
      if (outcome === 'offline') {
        await frame.getByRole('button', { name: 'Check current hash' }).click();
        await expect(frame.getByRole('status')).toContainText('base hash is current');
        await expect(frame.getByRole('button', { name: 'Retry Apply' })).toBeEnabled();
        await captureForDesignReview(page, {
          route: `/chats/${thread}`,
          state: 'workflow revision retryable',
          source: 'workflow-revision-chat.spec.ts',
        });
        await frame.getByRole('button', { name: 'Retry Apply' }).click();
        await expect(frame.getByRole('status')).toContainText('Applied. New hash:');
      } else if (outcome === 'denied') {
        await expect(frame.getByRole('button', { name: 'Check current hash' })).toHaveCount(0);
      }
      await removeWorkflow(request, WORKFLOW_ID);
    }
  });

  test('does not mount invalid or stale proposals', async ({ page, request, pageErrors }) => {
    const created = await createWorkflowFile(request, WORKFLOW_ID, {
      description: 'Owner note: Platform Operations',
    });
    const invalidThread = newThreadId('workflow-revision-invalid');
    threads.push(invalidThread);
    await runToEnd(
      request,
      'workflow-revision',
      invalidThread,
      `invalid proposal for ${WORKFLOW_ID}`,
    );
    await page.goto(`/chats/${invalidThread}`);
    const invalidTool = page
      .locator('.cinder-tool-call-rail__item')
      .filter({ has: page.locator('[data-cinder-tool-call-row="cor-2034-workflow-proposal"]') });
    await expect(invalidTool).toBeVisible();
    await invalidTool.getByRole('button', { name: /Bureau workflows propose update/ }).click();
    await expect(invalidTool.locator('.ib-tool__details')).toContainText('expectedHash');
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
    let resourceAttempts = 0;
    await page.route('**/host/plugins/inspectors/apps/workflow-revision-review', (route) => {
      resourceAttempts += 1;
      return resourceAttempts === 1
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'fixture resource failure' }),
          })
        : route.continue();
    });
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
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('iframe[title="Review workflow revision"]')).toBeVisible();
    expect(resourceAttempts).toBe(2);
    await captureForDesignReview(page, {
      route: `/chats/${failureThread}`,
      state: 'workflow revision resource retry',
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
    // The rail lists the call without a panel, says it conflicted, and names the tool on hover.
    const staleRow = page.locator('[data-cinder-tool-call-row="cor-2034-workflow-proposal"]');
    await expect(staleRow).toContainText('status conflict');
    await staleRow.hover();
    await expect(page.getByText('bureau__workflows-propose-update', { exact: true })).toBeVisible();
  });

  test('counts a single real proposal change', async ({ page, request }) => {
    await createWorkflowFile(request, WORKFLOW_ID, {
      agent: 'workflow-revision',
      description: 'Owner note: Platform Operations',
    });
    const thread = newThreadId('workflow-revision-single-change');
    threads.push(thread);
    await runToEnd(
      request,
      'workflow-revision',
      thread,
      `single-change proposal for ${WORKFLOW_ID}`,
    );
    await page.goto(`/chats/${thread}`);
    const frame = page.frameLocator('iframe[title="Review workflow revision"]');
    await expect(frame.getByRole('status')).toContainText(
      'Review 1 visible change before applying.',
    );
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision one change',
      source: 'workflow-revision-chat.spec.ts',
    });
  });
});
