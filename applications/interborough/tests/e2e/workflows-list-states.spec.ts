/** The Workflows list at the sample clock, including captioned states outside the sample world. */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import type { WorkflowFileListing, WorkflowRunCounts } from '../../src/lib/workflow-files.ts';
import { isBureauCall, rewriteBureauAnswer } from './bureau-answer-support.ts';
import { connectProviderWithModels } from './chat-states-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, goOffline, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'workflows-list-states.spec.ts';
const LIST_METHOD = 'bureau.workflows.list';
const row = (page: Page, name: string) => page.locator(`[data-workflow="${name}"]`);
const internal = (page: Page) => page.getByTestId('internal-workflows-action');
const newWorkflow = (page: Page) => page.locator('main a.cinder-page-header__create');
const ask = (page: Page) =>
  page.getByRole('link', { name: 'Ask an agent to write one', exact: true });

async function openWorkflows(page: Page, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/workflows');
  await expect(page.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
}

async function emptyFiles(page: Page): Promise<void> {
  await rewriteBureauAnswer(page, LIST_METHOD, (result) => ({
    ...result,
    workflows: [],
    nextOffset: null,
  }));
}

async function releaseRun(
  page: Page,
  status: 'running' | 'suspended',
  waitingForSignal: string | null,
): Promise<void> {
  await rewriteBureauAnswer(page, LIST_METHOD, (result) => {
    const workflows = result['workflows'] as WorkflowFileListing[];
    return {
      ...result,
      workflows: workflows.map((workflow) => {
        if (workflow.id !== 'release-notes') return workflow;
        const runs: WorkflowRunCounts = {
          total: 2,
          active: 1,
          last24Hours: 1,
          lastRunAt: '2026-11-02T10:45:00-06:00',
          last: { status, failedStep: null },
          current: {
            status,
            step: 2,
            totalSteps: 4,
            waitingForSignal,
          },
        };
        return { ...workflow, runs };
      }),
    };
  });
}

test('/workflows separates today, running and last-run facts for a code workflow (W76)', async ({
  page,
}) => {
  await rewriteBureauAnswer(page, 'weft.workflows.definitions.list', (result) => ({
    ...result,
    definitions: [
      ...(result['definitions'] as readonly unknown[]),
      {
        name: 'captioned-code-workflow',
        origin: 'code',
        state: 'ready',
        lastFailureCategory: null,
        revision: null,
        workflowVersion: null,
        description: null,
        tags: null,
        signals: null,
        updates: null,
        queries: null,
      },
    ],
  }));
  await page.route(isBureauCall, async (route) => {
    const request = route.request().postDataJSON() as {
      method?: string;
      params?: { type?: string; status?: string[]; createdAt?: { gte: number } };
    };
    if (
      request.method !== 'weft.workflows.list' ||
      request.params?.type !== 'captioned-code-workflow'
    ) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: Record<string, unknown> };
    const isRunning = request.params.status?.join(',') === 'running';
    const startsAtMidnight =
      request.params.createdAt?.gte === Date.parse('2026-11-02T00:00:00-06:00');
    await route.fulfill({
      response,
      json: {
        ...answer,
        result: {
          ...answer.result,
          items: [{ createdAt: Date.parse('2026-11-02T10:44:00-06:00') }],
          total: isRunning || startsAtMidnight ? 1 : 2,
        },
      },
    });
  });
  await openWorkflows(page, 1280);
  const code = row(page, 'captioned-code-workflow');
  await expect(code.getByTestId('workflow-run-counts')).toHaveText('1 run today');
  await expect(code.getByText('1 running', { exact: true })).toBeVisible();
  await expect(code.getByTestId('workflow-last-run')).toHaveText('Last 2m ago');
  await captureForDesignReview(page, {
    route: '/workflows',
    state: 'captioned code workflow activity',
    source: SOURCE,
  });
});

for (const width of [1280, 768, 375]) {
  test(`/workflows retains the sample list and its facts offline at ${width}px (11a, 11b, 60e, 60f, 60h, 61g)`, async ({
    page,
    context,
    pageErrors,
  }) => {
    await openWorkflows(page, width);
    const notes = row(page, 'release-notes');
    const refund = row(page, 'order-refund');
    const triage = row(page, 'triage-inbox');
    await expect(notes.getByTestId('workflow-identifier')).toHaveText('release-notes');
    await expect(notes.getByTestId('workflow-last-run')).toHaveText('Oct 30');
    await expect(notes).toContainText('last run failed at step 2');
    await expect(notes.getByTestId('workflow-run-counts')).toHaveText('1 run');
    const bounds = await notes.boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual(Math.min(width, 960));
    // This sample file declares no title, so its identifier is the name of the link.
    await expect(refund.getByRole('link', { name: 'order-refund', exact: true })).toBeVisible();
    await expect(refund).toHaveAttribute('data-status', "Can't load");
    await expect(refund.getByTestId('workflow-problem')).toHaveText(
      'order-refund.json, line 12: expected a comma.',
    );
    await expect(triage).toHaveAttribute('data-status', 'Paused');
    await expect(triage.getByTestId('workflow-last-run')).toHaveText('Oct 24');
    await expect(triage.getByTestId('workflow-run-counts')).toHaveText('2 runs');
    await expect(triage).toContainText('last run done');
    await captureForDesignReview(page, {
      route: '/workflows',
      state: 'workflow facts',
      source: SOURCE,
    });

    await goOffline(context, pageErrors);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(page.getByRole('region', { name: 'Connection problem' })).toContainText(
        'You’re offline.',
      );
      await expect(newWorkflow(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(notes.getByRole('link')).toHaveAttribute('href', '/workflows/release-notes');
      await expect(refund).toHaveAttribute('data-status', "Can't load");
      await expect(triage).toHaveAttribute('data-status', 'Paused');
      await captureForDesignReview(page, {
        route: '/workflows',
        state: 'offline with old data',
        source: SOURCE,
      });
    } finally {
      await context.setOffline(false);
    }
  });

  for (const [status, signal, words] of [
    ['running', null, 'Running, step 2 of 4'],
    ['suspended', null, 'Waiting on you'],
    ['suspended', 'release-ready', 'Waiting'],
  ] as const) {
    test(`/workflows: ${words} at ${width}px (61j, 61k, W76)`, async ({ page }) => {
      await releaseRun(page, status, signal);
      await openWorkflows(page, width);
      const notes = row(page, 'release-notes');
      await expect(notes.getByText(words, { exact: true })).toBeVisible();
      await expect(notes).not.toHaveAttribute('data-status', /.+/);
      await expect(notes.getByTestId('workflow-last-run')).toHaveText('Started 10:45 AM');
      await expect(notes.getByTestId('workflow-run-counts')).toHaveText('2 runs');
      await captureForDesignReview(page, { route: '/workflows', state: words, source: SOURCE });
    });
  }

  for (const connected of [false, true]) {
    test(`/workflows first use with ${connected ? 'a provider and /chats/new' : 'no provider'} at ${width}px (12i, 12j, 60v)`, async ({
      page,
    }) => {
      await emptyFiles(page);
      if (connected) {
        await connectProviderWithModels(page);
      } else {
        await rewriteBureauAnswer(page, 'weft.workflows.definitions.list', () => ({
          definitions: [],
        }));
      }
      await openWorkflows(page, width);
      await expect(page.getByRole('heading', { name: 'No workflows yet' })).toBeVisible();
      await expect(page.getByTestId('workflows-file-location')).toBeVisible();
      if (!connected) {
        await expect(internal(page)).toHaveCount(0);
        await expect(ask(page)).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('link', { name: 'Connect a provider' })).toHaveAttribute(
          'href',
          '/settings/models',
        );
      } else {
        await expect(internal(page)).toBeVisible();
        await expect(ask(page)).toBeEnabled();
      }
      await captureForDesignReview(page, {
        route: '/workflows',
        state: connected ? 'first use with a provider' : 'first use without a provider',
        source: SOURCE,
      });
      if (connected) {
        await ask(page).click();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          'What should Workflow author do?',
        );
        await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
          'Help me build a workflow that ',
        );
        await captureForDesignReview(page, {
          route: '/chats/new',
          state: 'workflow author from the Workflows list',
          source: SOURCE,
        });
      }
    });
  }

  test(`/workflows keeps the list skeleton and no internal workflows action while loading at ${width}px (61c)`, async ({
    page,
  }) => {
    const answer = Promise.withResolvers<void>();
    await page.route('**/jsonrpc', async (route) => {
      if (route.request().postDataJSON()?.method === LIST_METHOD) await answer.promise;
      await route.fallback();
    });
    try {
      await openWorkflows(page, width);
      await expect(page.getByRole('status').getByText('Loading workflows')).toBeAttached();
      await expect(internal(page)).toHaveCount(0);
      await expect(row(page, 'release-notes')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/workflows',
        state: 'list loading',
        source: SOURCE,
      });
    } finally {
      answer.resolve();
    }
    await expect(internal(page)).toBeVisible();
  });
}

test('/workflows keeps each wrapped first-use touch target reachable at 320px', async ({
  page,
}) => {
  await emptyFiles(page);
  await connectProviderWithModels(page);
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  try {
    await openWorkflows(page, 320);
    const empty = page.getByTestId('workflows-empty');
    await expect(empty.getByRole('link', { name: 'New workflow' })).toBeVisible();
    await expect(ask(page)).toBeEnabled();
    await expect(empty.getByRole('button', { name: 'Where workflow files live' })).toBeVisible();
    const targets = empty.locator('.cinder-empty-state-action > a, .cinder-collapsible__trigger');
    await expect(targets).toHaveCount(4);
    const contacts = await targets.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        // Sample just inside the 44px target, where hit testing is defined on both edges.
        return [-21.5, 21.5].map((offset) =>
          element.contains(document.elementFromPoint(x, y + offset)),
        );
      }),
    );
    expect(contacts.flat()).not.toContain(false);
  } finally {
    await touch.detach();
  }
});
