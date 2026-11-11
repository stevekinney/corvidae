/**
 * The records pages (COR-1843): Runs, Workflows, Internal workflows, Agents and Goals. Each has a
 * heading and one toolbar (the count, the filters, the primary action); Runs, Workflows, Internal
 * workflows and Goals list their records in a table, Agents in compact rows; and every status on
 * them is one of seven words drawn as a StatusDot of that word's tone. A filter that matches
 * nothing says which filter and offers Clear filters. An agent with a chat that waits on the person
 * says Needs you, and its chat count opens the agent's page.
 */
import type { Page } from '@playwright/test';

import { TASK_COPY, WORKFLOW_COPY } from '../../src/app/copy.ts';
import { STATUS_WORDS } from '../../src/lib/status.ts';
import { STARTED_BY_KINDS, STARTED_BY_LABELS } from '../../src/routes/workflows/runs/started-by.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { TWO_QUESTIONS_AGENT_NAME } from './question-agents.ts';

/** The agreed tone of each records-page status word (Cinder's StatusDot word-to-tone table). */
const AGREED_TONES = {
  Running: 'info',
  'Waiting on you': 'warning',
  Done: 'success',
  Failed: 'danger',
  Canceled: 'neutral',
  Scheduled: 'pending',
  Paused: 'neutral',
} as const;

const WAITING_THREAD = newThreadId('records-waiting');

test.afterAll(async () => {
  await deleteChats([WAITING_THREAD]);
});

/** The words of every status dot on the page, as the dots say them. */
async function statusWords(page: Page): Promise<string[]> {
  return page
    .locator('main [data-cinder-status][aria-label], main [data-status-word]')
    .evaluateAll((dots) =>
      dots.map(
        (dot) => dot.getAttribute('data-status-word') ?? dot.getAttribute('aria-label') ?? '',
      ),
    );
}

test.describe('the records pages', () => {
  test('Runs is a table with a column for each filter, a StatusDot per row, and Start run', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/runs');

    await expect(page.locator('[data-view="runs"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    const headings = page.getByRole('columnheader');
    await expect(headings).toHaveText(['Agent', 'Started by', 'Status', 'When', 'Took']);
    const rows = page.locator('tr[data-run]');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    await expect(page.getByTestId('records-count')).toHaveText(
      `${count} ${count === 1 ? 'run' : 'runs'}`,
    );
    await expect(rows.first().locator('[data-cinder-status]')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Start run' })).toHaveAttribute(
      'href',
      '/runs/new',
    );
    await checkA11y('records — runs');
  });

  test('Runs filters by Started by, and offers every kind of origin the Bureau records', async ({
    page,
  }) => {
    await page.goto('/runs');
    await expect(page.locator('[data-view="runs"]')).toHaveAttribute('data-state', 'ready');
    // The filter is a Cinder select in the filter bar: its options are in the open list, and they
    // are the origins a run can be filtered by (an agent's tool call is read from the run itself).
    const startedBy = page.getByRole('combobox', { name: TASK_COPY.startedByLabel });
    await startedBy.click();
    await expect(page.getByRole('option')).toHaveText([
      TASK_COPY.anyOrigin,
      ...STARTED_BY_KINDS.map((kind) => STARTED_BY_LABELS[kind]),
    ]);

    await page.getByRole('option', { name: STARTED_BY_LABELS.schedule, exact: true }).click();
    await expect(page).toHaveURL(/startedBy=schedule/);
    for (const row of await page.locator('tr[data-run] .ib-run-origin').all()) {
      await expect(row).toHaveAttribute('data-origin', 'schedule');
    }
  });

  test('Runs says which filter matched nothing and clears it', async ({ page }) => {
    await page.goto('/runs?agent=no-such-agent');

    const empty = page.locator('[data-cinder-kind="filtered"]');
    await expect(empty).toBeVisible();
    await empty.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await expect(page.locator('tr[data-run]').first()).toBeVisible();
  });

  test('Workflows is a list of status-first rows under segments, with a secondary New workflow in its header', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/workflows');

    await expect(page.locator('[data-view="workflows"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
    await expect(page.getByText(WORKFLOW_COPY.list.subtitle)).toBeVisible();
    await expect(page.locator('li[data-workflow]').first()).toBeVisible();
    await expect(page.getByRole('columnheader')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /^All\s*,\s*\d+$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: WORKFLOW_COPY.newAction })).toHaveAttribute(
      'href',
      '/workflows/new',
    );
    await checkA11y('records — workflows');
  });

  test.describe('on the host whose console is the Bureau’s own engine', () => {
    test.use({ baseURL: E2E_BUREAU_URL });

    test('Internal workflows is a table of the types the Bureau runs itself, each with a line on what it does, reached from the card under the list', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/workflows');
      await page.getByTestId('internal-workflows-card').click();

      await expect(page).toHaveURL(/\/internal-workflows$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Internal workflows' }),
      ).toBeVisible();
      await expect(page.getByRole('columnheader')).toHaveText([
        WORKFLOW_COPY.internal.columns.workflow,
        WORKFLOW_COPY.internal.columns.description,
        WORKFLOW_COPY.internal.columns.runs,
        WORKFLOW_COPY.internal.columns.lastRun,
      ]);
      const rows = page.locator('tr[data-workflow][data-engine]');
      await expect(rows.first()).toBeVisible();
      for (const description of await rows.getByTestId('workflow-description').allTextContents()) {
        expect(description.trim().length).toBeGreaterThan(0);
      }
      await checkA11y('records — internal workflows');
    });
  });

  test('Agents is a list of compact rows with Memory and New chat as buttons, and no tool count', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/agents');

    await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
    const row = page.locator('[data-agent="demo:assistant"]');
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: /^Memory of/ })).toBeVisible();
    await expect(row.getByRole('link', { name: /^New chat with/ })).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/\d+ tools?/);
    await expect(page.getByRole('radio', { name: /^All/ })).toBeVisible();
    await checkA11y('records — agents');
  });

  test('Agents says Waiting on you for an agent with a chat that waits on the person, and its chat count opens the agent', async ({
    page,
    request,
  }) => {
    await runToEnd(request, TWO_QUESTIONS_AGENT_NAME, WAITING_THREAD, 'Ship it');

    await page.goto('/agents');

    const row = page.locator(`[data-agent="${TWO_QUESTIONS_AGENT_NAME}"]`);
    await expect(row.getByTestId('agent-needs-you')).toHaveText('Waiting on you');
    await expect(
      page.locator('[data-agent="demo:assistant"]').getByTestId('agent-needs-you'),
    ).toHaveCount(0);
    await row.getByTestId('agent-chat-count').click();
    await expect(page).toHaveURL(new RegExp(`/agents/${TWO_QUESTIONS_AGENT_NAME}$`));
  });

  test('Goals is a table with a StatusDot per row', async ({ page, checkA11y }) => {
    await page.goto('/goals');

    await expect(page.locator('[data-view="goals"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('columnheader').first()).toHaveText('Goal');
    const seeded = page.locator('tr[data-goal="seeded-goal"]');
    await expect(seeded.locator('[data-cinder-status="success"]')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'New goal' })).toHaveAttribute(
      'href',
      '/goals/new',
    );
    await checkA11y('records — goals');
  });

  test('every status on the records pages is one of the seven words, in that word’s tone', async ({
    page,
  }) => {
    for (const path of ['/runs', '/workflows', '/goals', '/goals/seeded-goal']) {
      await page.goto(path);
      await expect(page.locator('[data-view]').first()).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('main [data-cinder-status]').first()).toBeVisible();
      const words = await statusWords(page);
      expect(words.length, path).toBeGreaterThan(0);
      for (const word of words) expect(STATUS_WORDS as readonly string[], path).toContain(word);
      const tones = await page
        .locator('main [data-cinder-status][data-status-word]')
        .evaluateAll((dots) =>
          dots.map((dot) => [
            dot.getAttribute('data-status-word') ?? '',
            dot.getAttribute('data-cinder-status') ?? '',
          ]),
        );
      for (const [word, tone] of tones) {
        expect(tone, `${path}: ${word}`).toBe(AGREED_TONES[word as keyof typeof AGREED_TONES]);
      }
    }
  });
});
