/**
 * COR-1494: the schedules area, as an operator uses it. Each schedule says what it starts and links
 * to it: the seeded "Daily summary" is an agent run and links to its agent, and a workflow's is its
 * trigger and links to the workflow. The seeded schedule is paused and resumed from the list, its
 * cadence is edited in the drawer an agent run has, which holds the cadence, the description, and the
 * overlap policy, and the next fire time changes. A workflow file's schedule is paused and resumed
 * too, and is edited in the workflow. A schedule is made for an agent from the create drawer.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';

import { SCHEDULE_COPY } from '../../src/app/copy.ts';
import { E2E_BASE_URL, E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;
const SEEDED_DESCRIPTION = 'Daily summary';
const SEEDED_CRON = '0 9 * * *';

/** The seeded schedule's id: the Bureau mints it, and the row says only its description. */
async function seededScheduleId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/v1/schedules');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { items: Array<{ id: string; description?: string }> };
  const found = body.items.find((item) => item.description === SEEDED_DESCRIPTION);
  expect(found, 'the seeded schedule').toBeDefined();
  return found?.id ?? '';
}

async function nextFireAt(request: APIRequestContext, id: string): Promise<number | null> {
  const response = await request.get(`/v1/schedules/${encodeURIComponent(id)}`);
  return ((await response.json()) as { nextFireAt: number | null }).nextFireAt;
}

/** Puts the seeded schedule back as the seed made it, so a reused server starts the next run the same. */
async function restoreSeeded(request: APIRequestContext, id: string): Promise<void> {
  const read = await request.post('/bureau/jsonrpc', {
    data: { jsonrpc: '2.0', id: 1, method: 'bureau.schedules.get', params: { scheduleId: id } },
  });
  const current = ((await read.json()) as { result: { status: string } }).result;
  if (current.status === 'paused') {
    await request.post('/bureau/jsonrpc', {
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'bureau.schedules.resume',
        params: { scheduleId: id },
      },
    });
  }
  await request.post('/bureau/jsonrpc', {
    data: {
      jsonrpc: '2.0',
      id: 3,
      method: 'bureau.schedules.update',
      params: { scheduleId: id, spec: SEEDED_CRON },
    },
  });
}

const row = (page: Page, id: string) => page.locator(`tr[data-schedule="${id}"]`);

// The schedules the Bureau holds are listed by a console that runs on the Bureau's own engine, so the
// specs about them open the second host (`e2e-constants.ts`). The main host's console is the
// fixtures' engine, which is where the code-defined schedules are.
test.use({ baseURL: E2E_BUREAU_URL });

test.describe('what each schedule starts', () => {
  for (const width of WIDTHS) {
    test(`labels the seeded agent run and links it to its agent, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      const id = await seededScheduleId(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/schedules');

      await expect(row(page, id)).toHaveAttribute('data-kind', 'agent-run');
      await expect(row(page, id)).toContainText(SEEDED_DESCRIPTION);
      await expect(row(page, id)).toContainText(SCHEDULE_COPY.kind['agent-run']);
      const link = row(page, id).getByRole('link', { name: 'assistant' });
      await expect(link).toHaveAttribute('href', '/agents/assistant');
      await checkA11y(`schedules — the list at ${width}px`);

      await link.click();
      await expect(page).toHaveURL(/\/agents\/assistant$/);
    });

    test(`links the same agent from the schedule's own page, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      const id = await seededScheduleId(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/schedules/${id}`);

      const target = page.getByTestId('schedule-target');
      await expect(target).toContainText(SCHEDULE_COPY.kind['agent-run']);
      await expect(target.getByRole('link', { name: 'assistant' })).toHaveAttribute(
        'href',
        '/agents/assistant',
      );
      await checkA11y(`schedule detail — an agent run at ${width}px`);
    });
  }

  test('labels a workflow file’s schedule, linked to its workflow', async ({ page }) => {
    await page.goto('/schedules');

    const file = page.locator('tr[data-kind="workflow-file"]').first();
    await expect(file).toContainText(SCHEDULE_COPY.kind['workflow-file']);
    await expect(file.getByRole('link', { name: 'e2e-digest', exact: true })).toHaveAttribute(
      'href',
      '/workflows/e2e-digest',
    );
  });

  test.describe('a code-defined schedule, on the host whose console is the fixtures’ engine', () => {
    test.use({ baseURL: E2E_BASE_URL });

    test('is labelled and linked to its workflow', async ({ page }) => {
      await page.goto('/schedules');

      const code = page.locator('tr[data-kind="code"]').first();
      await expect(code).toContainText(SCHEDULE_COPY.kind.code);
      await expect(code.locator('a[href^="/workflows/"]')).toHaveCount(1);
    });
  });
});

test.describe('the seeded agent run', () => {
  test('is paused and resumed from the list', async ({ page, request }) => {
    const id = await seededScheduleId(request);
    try {
      await page.goto('/schedules');
      await expect(row(page, id)).toHaveAttribute('data-status', 'active');

      await page.getByRole('button', { name: `Actions for ${id}` }).click();
      await page.getByRole('menuitem', { name: /Pause/ }).click();
      await expect(row(page, id)).toHaveAttribute('data-status', 'paused');

      await page.getByRole('button', { name: `Actions for ${id}` }).click();
      await page.getByRole('menuitem', { name: /Resume/ }).click();
      await expect(row(page, id)).toHaveAttribute('data-status', 'active');
    } finally {
      await restoreSeeded(request, id);
    }
  });

  test('has its cadence edited in a drawer of the cadence, the description, and the overlap policy, and the next fire time changes', async ({
    page,
    request,
    checkA11y,
  }) => {
    const id = await seededScheduleId(request);
    try {
      const before = await nextFireAt(request, id);
      await page.goto(`/schedules/${id}`);
      // The next fire time the page shows, which is the definition after its term.
      const nextFire = page
        .locator('dt', { hasText: 'Next fire' })
        .locator('xpath=following-sibling::dd[1]');
      const shownBefore = await nextFire.innerText();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Edit schedule' });
      await expect(drawer).toBeVisible();

      // What an agent run is edited with, and nothing the engine's own schedule adds.
      await expect(drawer.getByLabel('Description')).toHaveValue(SEEDED_DESCRIPTION);
      const overlap = drawer.getByRole('group', {
        name: 'If a run is still going when the next fire is due',
      });
      await expect(overlap.getByRole('radio')).toHaveCount(2);
      await expect(drawer.getByLabel('Jitter')).toHaveCount(0);
      await expect(drawer.getByRole('switch', { name: 'Backfill missed occurrences' })).toHaveCount(
        0,
      );
      await checkA11y('schedules — editing an agent run');

      // From a cron cadence to an interval of two weeks, whose first fire is two weeks away.
      await drawer.getByRole('tab', { name: 'Interval' }).click();
      await drawer.getByRole('spinbutton', { name: 'Every' }).fill('2');
      await drawer.getByLabel('Unit').selectOption('weeks');
      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(drawer).not.toBeVisible();

      await expect.poll(async () => nextFireAt(request, id), { timeout: 15_000 }).not.toBe(before);
      await expect(page.getByText('Every 2 weeks').first()).toBeVisible();
      // A daily schedule fires within a day, and this one in two weeks, so the page says so.
      await expect(nextFire).not.toHaveText(shownBefore);
      await checkA11y('schedule detail — the edited cadence');
    } finally {
      await restoreSeeded(request, id);
    }
  });
});

test.describe('a workflow file’s schedule', () => {
  test('is paused and resumed from the list, through its file, and is edited in the workflow', async ({
    page,
  }) => {
    await page.goto('/schedules');
    const file = page.locator('tr[data-kind="workflow-file"]').filter({ hasText: 'e2e-digest' });
    await expect(file).toHaveAttribute('data-status', 'active');

    await file.getByRole('button', { name: /^Actions for / }).click();
    // It has no Edit or Cancel of its own, because its cadence is the trigger in its file.
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /Cancel/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: /Pause/ }).click();
    await expect(file).toHaveAttribute('data-status', 'paused');

    await file.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: /Resume/ }).click();
    await expect(file).toHaveAttribute('data-status', 'active');

    await file.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: SCHEDULE_COPY.editWorkflowAction }).click();
    await expect(page).toHaveURL(/\/workflows\/e2e-digest\/edit$/);
  });
});

test.describe('creating a schedule', () => {
  test('starts an agent from the create drawer, and opens the new schedule', async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.goto('/schedules?create=1');
    const drawer = page.getByRole('dialog', { name: 'Create schedule' });
    await expect(drawer).toBeVisible();

    await drawer.getByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }).click();
    await drawer
      .getByRole('combobox', { name: SCHEDULE_COPY.form.agentLabel })
      .selectOption('assistant');
    await drawer
      .getByLabel(SCHEDULE_COPY.form.inputLabel)
      .fill('Summarize what happened this week.');
    await drawer.getByLabel(SCHEDULE_COPY.form.descriptionLabel).fill('Weekly summary');
    await checkA11y('schedules — creating an agent run');
    await drawer.getByRole('button', { name: 'Create schedule' }).click();
    await expect(drawer).not.toBeVisible();

    await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
    await expect(page.getByTestId('schedule-target')).toContainText(
      SCHEDULE_COPY.kind['agent-run'],
    );
    await expect(
      page.getByTestId('schedule-target').getByRole('link', { name: 'assistant' }),
    ).toBeVisible();
    // It is a Bureau schedule, owned by the caller, so the Bureau lists it with its agent.
    const response = await request.post('/bureau/jsonrpc', {
      data: { jsonrpc: '2.0', id: 1, method: 'bureau.schedules.list', params: { limit: 100 } },
    });
    const listed = (await response.json()) as {
      result: { schedules: Array<{ description: string | null; agentName: string | null }> };
    };
    expect(
      listed.result.schedules.some(
        (schedule) =>
          schedule.description === 'Weekly summary' && schedule.agentName === 'assistant',
      ),
    ).toBe(true);
  });

  /** The workflow types the create drawer offers. */
  async function offeredTypes(page: Page): Promise<string[]> {
    await page.goto('/schedules?create=1');
    const drawer = page.getByRole('dialog', { name: 'Create schedule' });
    const type = drawer.getByRole('combobox', { name: 'Workflow type' });
    await expect(type).toBeVisible();
    return type
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  }

  test('offers none of the types the Bureau owns, so there is no workflow type to pick on its own engine', async ({
    page,
    request,
  }) => {
    // The engine's registry holds every type the Bureau's run engine registers, and the file's type.
    const registry = await request.post('/jsonrpc', {
      data: { jsonrpc: '2.0', id: 1, method: 'weft.system.registry', params: {} },
    });
    const held = Object.keys(
      ((await registry.json()) as { result: { activeRevisions: Record<string, unknown> } }).result
        .activeRevisions,
    );
    for (const reserved of RUN_ENGINE_WORKFLOW_TYPES) expect(held, reserved).toContain(reserved);
    expect(held).toContain('e2e-digest');

    await page.goto('/schedules?create=1');
    const drawer = page.getByRole('dialog', { name: 'Create schedule' });
    // Nothing is left to pick, so the type is typed, and every type the Bureau owns is refused.
    const type = drawer.getByRole('textbox', { name: 'Workflow type' });
    await expect(type).toBeVisible();
    await expect(drawer.getByRole('combobox', { name: 'Workflow type' })).toHaveCount(0);
    for (const reserved of [...RUN_ENGINE_WORKFLOW_TYPES, 'e2e-digest']) {
      await type.fill(reserved);
      await expect(
        drawer.getByRole('button', { name: 'Create schedule' }),
        reserved,
      ).toBeDisabled();
    }
  });

  test.describe('on the host whose console is the fixtures’ engine', () => {
    test.use({ baseURL: E2E_BASE_URL });

    test('offers the code-defined workflow types, and not an agent-authored one', async ({
      page,
    }) => {
      await expect
        .poll(async () => {
          const offered = await offeredTypes(page);
          return offered.length;
        })
        .toBeGreaterThan(1);
      const options = await offeredTypes(page);
      expect(options).toContain('order-processing');
      expect(options).not.toContain('e2e-digest');
      expect(options).not.toContain('e2e-approval');
    });
  });
});
