import { bureau } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
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
    await expect(frame.locator('.revision-row[data-state="changed"]')).toHaveCount(4);
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision proposal',
      source: 'workflow-revision-chat.spec.ts',
    });
    await page.setViewportSize({ width: 375, height: 720 });
    await captureForDesignReview(page, {
      route: `/chats/${thread}`,
      state: 'workflow revision proposal phone',
      source: 'workflow-revision-chat.spec.ts',
    });
    await frame.getByRole('button', { name: 'Apply' }).click();
    await expect(frame.getByRole('status')).toContainText('Applied. New hash:');

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

  test('does not mount invalid or stale proposals', async ({ page, request }) => {
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
