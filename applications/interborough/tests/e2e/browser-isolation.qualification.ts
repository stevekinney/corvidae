import { browserQualification } from '../../scripts/environment-configuration.ts';
import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { E2E_BARRIER_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { createWorkflowFile, listWorkflowRuns, workflowRunStatus } from './workflow-support.ts';

test('a browser stays on its own seeded host until released', async ({ page, request }) => {
  await page.goto('/goals');
  await expect(page.locator('[data-goal="seeded-goal"]')).toBeVisible();
  const { revision, run: marker } = browserQualification();
  if (!revision) throw new Error('COR_2653_REVISION must name the expected build.');
  await expect(page.locator('.weft-shell-sidebar__commit')).toContainText(revision);
  if (!marker || !/^[a-zA-Z0-9-]+$/.test(marker)) throw new Error('A run identity is required.');
  const workflow = `qualification-${marker.toLowerCase()}`;
  const begin = `begin-${workflow}`;
  const finish = `finish-${workflow}`;
  await createWorkflowFile(request, workflow, {
    trigger: { kind: 'signal', name: begin },
    steps: [{ kind: 'await-signal', signal: finish }],
  });
  await page.goto(`/workflows/${workflow}`);
  const detail = page.locator('[data-page="workflow-detail"]');
  const signal = async (name: string, started: number, reached: number) => {
    await detail.getByRole('button', { name: WORKFLOW_COPY.page.menu.label }).click();
    await page.getByRole('menuitem', { name: WORKFLOW_COPY.page.menu.sendSignal }).click();
    const dialog = page.getByRole('dialog', { name: WORKFLOW_COPY.signal.heading });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: WORKFLOW_COPY.signal.nameLabel }).fill(name);
    const send = async () => {
      await dialog.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }).click();
      await expect(
        dialog.getByRole('status', { name: WORKFLOW_COPY.signal.resultLabel }),
      ).toContainText(WORKFLOW_COPY.signal.result(started, reached));
    };
    if (started === 0) await expect(send).toPass();
    else await send();
    await dialog.getByRole('button', { name: WORKFLOW_COPY.page.menu.closeSignal }).click();
  };
  await signal(begin, 1, 0);
  let instance = '';
  await expect
    .poll(async () => {
      const runs = await listWorkflowRuns(request, workflow);
      instance = runs.find((run) => run.status === 'running')?.id ?? '';
      return instance;
    })
    .not.toBe('');
  await test.info().attach('seeded-host', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  const ready = await request.post(`${E2E_BARRIER_URL}/qualification/ready`);
  expect(ready.ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(`${E2E_BARRIER_URL}/qualification`);
      const status = await response.json();
      return status.released;
    })
    .toBe(true);
  await signal(finish, 0, 1);
  await expect.poll(() => workflowRunStatus(request, instance)).toBe('completed');
  await test.info().attach('after-peer-stop', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
