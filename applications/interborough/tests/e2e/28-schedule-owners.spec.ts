/**
 * COR-1494 and COR-1654: the schedules area, as an operator uses it. A schedule is named by what it
 * does and never by its identifier: the seeded one is "Daily summary", runs `assistant` every day at
 * 09:00, and sends its text. A row of the list says the kind first and is one link to the schedule,
 * whose own page links to what it starts: an agent run to its agent, and a workflow's trigger to the
 * workflow. The seeded schedule is paused and resumed from its page, its cadence is
 * edited on the page an agent run has, which holds the cadence, the description, and whether to
 * skip a fire while a run is going, and the next fire time changes. A workflow file's schedule is
 * paused and resumed too, and is edited in the workflow. A schedule is made on its own page, from a
 * searchable picker of workflows whose built-in choice is a chat with an agent.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';

import { SCHEDULE_COPY } from '../../src/app/copy.ts';
import { E2E_BASE_URL, E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;
const SEEDED_DESCRIPTION = 'Daily summary';
const SEEDED_CRON = '0 9 * * *';
const SEEDED_INPUT = 'Summarize what happened yesterday.';

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

const row = (page: Page, id: string) => page.locator(`li[data-schedule="${id}"]`);

/** The switch on a schedule's page, which pauses and resumes it. */
const activeSwitch = (page: Page): Locator => page.getByRole('switch', { name: /^Active/ });

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
      // What it is called, the kind first, and how often in words; never the identifier.
      await expect(row(page, id)).toContainText(SEEDED_DESCRIPTION);
      await expect(row(page, id)).toContainText('Workflow · Chat with an agent');
      await expect(row(page, id)).toContainText(/every day at/i);
      await expect(row(page, id)).not.toContainText(id);
      const link = row(page, id).getByRole('link', { name: SEEDED_DESCRIPTION });
      await expect(link).toHaveAttribute('href', `/schedules/${id}`);
      await checkA11y(`schedules — the list at ${width}px`);

      await link.click();
      await expect(page).toHaveURL(new RegExp(`/schedules/${id}$`));
    });

    test(`links the same agent from the schedule's own page, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      const id = await seededScheduleId(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/schedules/${id}`);

      // The heading is the name and the sentence says what it runs and when.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEEDED_DESCRIPTION);
      await expect(page.getByTestId('schedule-status-line')).toContainText(
        /^Runs Chat with an agent with Assistant every day at .*9:00 AM UTC/,
      );
      await expect(page.getByTestId('schedule-input')).toContainText(SEEDED_INPUT);
      const sentence = page.getByTestId('schedule-status-line');
      await expect(sentence.getByRole('link', { name: 'Assistant' })).toHaveAttribute(
        'href',
        '/agents/demo%3Aassistant',
      );
      // The details beside the runs hold the schedule's own fields.
      const details = page.getByTestId('schedule-details');
      await expect(details.getByText('If a run is still going', { exact: true })).toBeVisible();
      await expect(details.getByTestId('schedule-revision')).toHaveText('Latest');
      await expect(details.getByTestId('schedule-catch-up')).toBeVisible();
      await checkA11y(`schedule detail — an agent run at ${width}px`);
    });
  }

  test('labels a workflow file’s schedule by kind, and its page links to its workflow', async ({
    page,
  }) => {
    await page.goto('/schedules');

    const file = page.locator('li[data-kind="workflow-file"]').first();
    await expect(file).toContainText('Workflow · ');
    await file.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
    await expect(page.locator('a[href="/workflows/e2e-digest"]').first()).toBeVisible();
  });

  test.describe('a code-defined schedule, on the host whose console is the fixtures’ engine', () => {
    test.use({ baseURL: E2E_BASE_URL });

    test('is a row that says the kind first and links to the schedule', async ({ page }) => {
      await page.goto('/schedules');

      const code = page.locator('li[data-kind="code"]').first();
      await expect(code).toContainText('Workflow · ');
      await expect(code.getByRole('link').first()).toHaveAttribute('href', /^\/schedules\//);
    });
  });
});

test.describe('the seeded agent run', () => {
  test('is paused and resumed from its own page, and the list follows', async ({
    page,
    request,
  }) => {
    const id = await seededScheduleId(request);
    try {
      await page.goto(`/schedules/${id}`);
      await expect(activeSwitch(page)).toHaveAttribute('aria-checked', 'true');

      await activeSwitch(page).click();
      await expect(activeSwitch(page)).toHaveAttribute('aria-checked', 'false');
      await page.goto('/schedules');
      await expect(row(page, id)).toHaveAttribute('data-status', 'paused');

      await page.goto(`/schedules/${id}`);
      await activeSwitch(page).click();
      await expect(activeSwitch(page)).toHaveAttribute('aria-checked', 'true');
      await page.goto('/schedules');
      await expect(row(page, id)).toHaveAttribute('data-status', 'active');
    } finally {
      await restoreSeeded(request, id);
    }
  });

  test('has its cadence edited on the edit page, which holds the cadence, the description and the overlap policy, and the next fire time changes', async ({
    page,
    request,
    checkA11y,
  }) => {
    const id = await seededScheduleId(request);
    try {
      const before = await nextFireAt(request, id);
      await page.goto(`/schedules/${id}`);
      // The next fire time the page shows, in the sentence under the heading.
      const nextFire = page.getByTestId('schedule-status-line');
      await expect(nextFire).toContainText('every day at');
      const shownBefore = await nextFire.innerText();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/schedules/${id}/edit$`));
      const editor = page.locator('[data-page="schedule-edit"]');
      await expect(
        editor.getByRole('heading', { level: 1, name: `Edit ${SEEDED_DESCRIPTION}` }),
      ).toBeVisible();

      // The form that makes a schedule, opened on this one: the workflow and what the chat sends
      // are shown and fixed, and the name, the cadence and the policies are edited.
      await expect(editor.getByLabel(/^Name/)).toHaveValue(SEEDED_DESCRIPTION);
      await expect(editor.getByLabel('If a run is still going')).toHaveValue('skip');
      await expect(editor.getByRole('combobox', { name: /^Workflow/ })).toBeDisabled();
      await expect(editor.getByLabel(/^Message/)).toBeDisabled();
      await checkA11y('schedules — editing an agent run');

      // From a cron cadence to an interval of two hours, whose first fire is two hours away.
      await editor.getByLabel('Repeats', { exact: true }).selectOption('interval');
      await editor.getByRole('spinbutton', { name: 'Every' }).fill('2');
      await editor.getByLabel('Unit').selectOption('hours');
      await editor.getByRole('button', { name: 'Save changes' }).click();
      await expect(page).toHaveURL(new RegExp(`/schedules/${id}$`));

      await expect.poll(async () => nextFireAt(request, id)).not.toBe(before);
      await expect(nextFire).toContainText('every 2 hours');
      // The sentence names the new cadence in place of the daily one, so the page says so.
      await expect(nextFire).not.toHaveText(shownBefore);
      await checkA11y('schedule detail — the edited cadence');
    } finally {
      await restoreSeeded(request, id);
    }
  });
});

test.describe('a workflow file’s schedule', () => {
  test('is paused and resumed from its page, through its file, and is edited in the workflow', async ({
    page,
  }) => {
    await page.goto('/schedules');
    const file = page.locator('li[data-kind="workflow-file"]').filter({ hasText: 'e2e-digest' });
    await expect(file).toHaveAttribute('data-status', 'active');
    await file.getByRole('link').first().click();

    await activeSwitch(page).click();
    await expect(activeSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await activeSwitch(page).click();
    await expect(activeSwitch(page)).toHaveAttribute('aria-checked', 'true');

    // Its cadence is the trigger in its file, so Edit is a link into the workflow's editor and not
    // the form that edits a schedule.
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(/\/workflows\/e2e-digest\/edit$/);
  });
});

test.describe('creating a schedule', () => {
  const CREATE = SCHEDULE_COPY.create;

  /** Opens the workflow picker and chooses the option with that text, as a person does. */
  async function chooseWorkflow(page: Page, option: string): Promise<void> {
    await page.getByRole('combobox', { name: /^Workflow/ }).click();
    await page
      .getByRole('option', { name: new RegExp(option) })
      .first()
      .click();
  }

  test('starts an agent from the new schedule page, and opens the new schedule', async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.goto('/schedules/new');
    await expect(page.getByRole('heading', { level: 1, name: CREATE.title })).toBeVisible();

    // The built-in choice is a chat with an agent; nothing asks for an agent until it is chosen.
    await expect(page.getByLabel(new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`))).toHaveCount(0);
    await chooseWorkflow(page, CREATE.chat.label);
    await page
      .getByRole('combobox', { name: new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`) })
      .selectOption('demo:assistant');
    await page
      .getByLabel(new RegExp(`^${CREATE.messageLabel}`))
      .fill('Summarize what happened this week.');
    await page.getByLabel(new RegExp(`^${CREATE.nameLabel}`)).fill('Weekly summary');
    await checkA11y('schedules — creating an agent run');
    await page.getByRole('button', { name: CREATE.submit }).click();

    await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Weekly summary');
    await expect(page.getByTestId('schedule-input')).toContainText(
      'Summarize what happened this week.',
    );
    await expect(
      page.getByTestId('schedule-status-line').getByRole('link', { name: 'Assistant' }),
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
          schedule.description === 'Weekly summary' && schedule.agentName === 'demo:assistant',
      ),
    ).toBe(true);
  });

  /** The options the picker lists, with whether each can be chosen. */
  async function offered(page: Page): Promise<Array<{ text: string; disabled: boolean }>> {
    await page.goto('/schedules/new');
    const picker = page.getByRole('combobox', { name: /^Workflow/ });
    // The field does not open while the workflow list loads.
    await expect(picker).not.toHaveAttribute('aria-busy', 'true');
    await picker.click();
    const listbox = page.getByRole('listbox');
    await expect(listbox.getByRole('option').first()).toBeVisible();
    return listbox.getByRole('option').evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent ?? '',
        disabled: node.getAttribute('aria-disabled') === 'true',
      })),
    );
  }

  test('offers none of the types the Bureau owns, so there is no workflow of its own engine to pick', async ({
    page,
    request,
  }) => {
    // The engine's registry holds every type the Bureau's run engine registers. The picker leaves
    // them out, and lists a workflow file that loads like any other workflow.
    const registry = await request.post('/jsonrpc', {
      data: { jsonrpc: '2.0', id: 1, method: 'weft.system.registry', params: {} },
    });
    const body = (await registry.json()) as {
      result: { activeRevisions: Record<string, unknown> };
    };
    const held = Object.keys(body.result.activeRevisions);
    for (const reserved of RUN_ENGINE_WORKFLOW_TYPES) expect(held, reserved).toContain(reserved);

    const options = await offered(page);
    expect(options[0]?.text).toContain(CREATE.chat.label);
    // A type is named in words in the picker ("Agent Run"), so compare with the separators gone.
    const plain = (text: string): string => text.replace(/[^a-z0-9]/gi, '').toLowerCase();
    for (const reserved of RUN_ENGINE_WORKFLOW_TYPES) {
      expect(
        options.some((option) => plain(option.text).includes(plain(reserved))),
        reserved,
      ).toBe(false);
    }
    // A workflow file that loads is chosen like any other workflow.
    const file = options.find((option) => option.text.includes('E2e digest'));
    expect(file?.disabled).toBe(false);
  });

  test.describe('on the host whose console is the fixtures’ engine', () => {
    test.use({ baseURL: E2E_BASE_URL });

    test('offers the code-defined workflow types and an agent-authored one that loads', async ({
      page,
    }) => {
      // The picker fills in as the engine's registry arrives, and each read is a fresh page load, so
      // wait on the state this case is about instead of reading a second time after a first.
      await expect
        .poll(async () => {
          const options = await offered(page);
          return {
            orderProcessingDisabled: options.find((option) =>
              option.text.includes('Order processing'),
            )?.disabled,
            digestDisabled: options.find((option) => option.text.includes('E2e digest'))?.disabled,
          };
        })
        .toEqual({ orderProcessingDisabled: false, digestDisabled: false });
    });
  });
});
