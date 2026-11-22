/**
 * Screenshot-ready workflow-builder states which the sample-world routes do not hold. These stay
 * separate from the workflow-page states because their captures own PageWorkflowBuilder only.
 * Browser execution belongs to CI and the design-review coordinator.
 */
import type { Locator, Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { SHOWCASE_ORDER_REFUND_FILE } from '../../fixtures/showcase-content.ts';
import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { jsonEditor, jsonEditorSource, replaceJsonEditorText } from './json-editor-support.ts';
import { openJsonTab, openTab } from './workflow-support.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'workflow-builder-states.spec.ts';
const BUILDER = WORKFLOW_COPY.builder;
const WIDTH = 1280;

const morningBriefing = {
  name: 'morning-briefing',
  title: 'Morning briefing',
  description: 'Summarizes yesterday for the team.',
  trigger: {
    kind: 'schedule',
    spec: '0 9 * * 1-5',
    timezone: 'America/Chicago',
    overlap: 'skip',
    catchUp: false,
  },
  steps: [
    {
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'assistant', message: 'Summarize what happened yesterday.' },
    },
    { kind: 'await-signal', signal: 'approve-briefing', review: true },
    {
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'assistant', message: 'Post it.' },
    },
    { kind: 'sleep', duration: '15m' },
  ],
};

const morningBriefingText = `${JSON.stringify(morningBriefing, null, 2)}\n`;
const invalidMorningBriefing = morningBriefingText.replace(
  '    "timezone": "America/Chicago",',
  '    "timezone": "America/Chicago"',
);
// The unsupported kind is on line 21, as in the board’s semantic refusal.
const unknownStepText = `{
  "name": "morning-briefing",
  "title": "Morning briefing",
  "description": "Summarizes yesterday for the team.",
  "trigger": {
    "kind": "schedule",
    "spec": "0 9 * * 1-5",
    "timezone": "America/Chicago",
    "overlap": "skip",
    "catchUp": false
  },
  "steps": [
    {
      "kind": "activity", "handler": "agent", "input": {
        "agent": "assistant", "message": "Summarize what happened yesterday." }
    },
    {
      "kind": "await-signal", "signal": "approve-briefing", "review": true
    },
    {
      "kind": "fan-out",
      "over": "teams"
    }
  ]
}
`;

function tabs(root: Locator): Locator {
  return root.getByRole('tablist', { name: BUILDER.tabsLabel });
}

async function openBuilder(page: Page, path: string): Promise<Locator> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width: WIDTH, height: 900 });
  await page.goto(path);
  const root = page.locator('[data-page="workflow-creator"], [data-page="workflow-editor"]');
  await expect(root.getByTestId('workflow-builder')).toBeVisible();
  return root;
}

async function capture(page: Page, route: string, state: string, tab?: string): Promise<void> {
  await captureForDesignReview(page, {
    route,
    state,
    source: SOURCE,
    ...(tab === undefined ? {} : { tab }),
  });
}

async function refuseValidation(page: Page): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
    };
    if (body.method !== 'bureau.workflows.validate') return route.fallback();
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          status: 'invalid',
          code: 'invalid-document',
          issues: [{ path: 'steps[2].kind', message: 'no step kind "fan-out" is registered' }],
        },
      },
    });
  });
}

async function answerUnwritable(page: Page, method: string, file: string): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
    };
    if (body.method !== method) return route.fallback();
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32022,
          message: `${file} couldn’t be written: permission denied.`,
          data: {
            reason: 'workflow-file-write-denied',
            weftCode: 'Unprocessable',
            httpStatus: 422,
          },
        },
      },
    });
  });
}

test.describe('workflow builder design states for /workflows/new and /workflows/:workflow/edit', () => {
  test('run setup uses form sections for Input and When on /workflows/:workflow/run (S52)', async ({
    page,
  }) => {
    const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: WIDTH, height: 900 });
    await page.goto(`/workflows/${encodeURIComponent(world.workflows.releaseNotes)}/run`);
    const sections = page.locator('.cinder-form-section');
    await expect(
      sections.getByRole('heading', { name: WORKFLOW_COPY.runSetup.inputHeading }),
    ).toBeVisible();
    await expect(
      sections.getByRole('heading', { name: WORKFLOW_COPY.runSetup.whenHeading }),
    ).toBeVisible();
    await capture(page, '/workflows/:workflow/run', 'input and when sections');
  });

  test('an unreadable workflow opens on JSON with Builder unavailable (63g, 66f)', async ({
    page,
  }) => {
    const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
    const route = `/workflows/${encodeURIComponent(world.workflows.orderRefund)}/edit?tab=json`;
    const root = await openBuilder(page, route);
    const editor = await jsonEditor(root, WORKFLOW_COPY.editor.textLabel);

    // The showcase seed's missing comma is intentionally on line 11; do not duplicate it here.
    await expect(page).toHaveURL(
      new RegExp(`/workflows/${world.workflows.orderRefund}/edit\\?tab=json$`),
    );
    await expect.poll(() => jsonEditorSource(editor)).toBe(SHOWCASE_ORDER_REFUND_FILE.text);
    await expect(root.getByRole('button', { name: 'Format', exact: true })).toBeDisabled();
    await expect(root.getByRole('button', { name: 'Invalid JSON' })).toBeVisible();
    await expect(root).toContainText(
      'Missing comma at the end of this line. The parser stopped at line 12.',
    );
    await expect(root.getByTestId('workflow-builder-summary')).toHaveText(BUILDER.json.fixLine(11));
    await expect(tabs(root).getByRole('tab', { name: BUILDER.builderTab })).toBeDisabled();
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(editor).toBeFocused();
    await capture(page, '/workflows/:workflow/edit', 'a file that cannot load', 'json');
  });

  test('new JSON carries every schedule and step field (65d)', async ({ page }) => {
    const root = await openBuilder(page, '/workflows/new');
    await openJsonTab(tabs(root));
    await replaceJsonEditorText(
      await jsonEditor(root, WORKFLOW_COPY.creator.textLabel),
      morningBriefingText,
    );
    await expect(root.locator('.cinder-json-editor__status')).toContainText('Valid JSON');
    await capture(page, '/workflows/new', 'a schedule, every field', 'json');
    await openTab(tabs(root), BUILDER.builderTab);
    await expect(root.getByTestId('schedule-when')).toBeVisible();
    await expect(root.getByRole('textbox', { name: `${BUILDER.titleLabel} Optional` })).toHaveValue(
      'Morning briefing',
    );
    await capture(page, '/workflows/new', 'on a schedule, the When block');
  });

  test('invalid JSON marks the missing comma and disables Builder (65f)', async ({ page }) => {
    const root = await openBuilder(page, '/workflows/new');
    await openJsonTab(tabs(root));
    await replaceJsonEditorText(
      await jsonEditor(root, WORKFLOW_COPY.creator.textLabel),
      invalidMorningBriefing,
    );
    await expect(root.getByRole('button', { name: 'Invalid JSON' })).toBeVisible();
    await expect(root).toContainText('Missing comma at the end of this line.');
    await expect(tabs(root).getByRole('tab', { name: BUILDER.builderTab })).toBeDisabled();
    await expect(root.getByRole('button', { name: 'Format', exact: true })).toBeDisabled();
    await expect(root.getByTestId('workflow-builder-summary')).toHaveText(BUILDER.json.fixLine(8));
    await root.locator('.cinder-json-editor__line--problem').first().scrollIntoViewIfNeeded();
    await capture(page, '/workflows/new', 'invalid JSON', 'json');
  });

  test('valid JSON the Bureau refuses marks its document line (65z)', async ({ page }) => {
    await refuseValidation(page);
    const root = await openBuilder(page, '/workflows/new');
    await openJsonTab(tabs(root));
    const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
    await replaceJsonEditorText(editor, unknownStepText);
    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(tabs(root).getByRole('tab', { name: BUILDER.builderTab })).toBeDisabled();
    await expect(root.getByTestId('workflow-builder-summary')).toHaveText(BUILDER.json.fixLine(21));
    await expect(editor).toBeFocused();
    await capture(page, '/workflows/new', 'valid JSON, not a valid workflow', 'json');
  });

  test('an unsupported step remains readable and is described (66a, 66b)', async ({ page }) => {
    const root = await openBuilder(page, '/workflows/new');
    await openJsonTab(tabs(root));
    await replaceJsonEditorText(
      await jsonEditor(root, WORKFLOW_COPY.creator.textLabel),
      unknownStepText,
    );
    await openTab(tabs(root), BUILDER.builderTab);
    await expect(root.getByTestId('workflow-step-other')).toContainText(BUILDER.otherStepLine);
    await expect(root.getByTestId('workflow-builder-summary')).toContainText(
      BUILDER.readBack.other,
    );
    await capture(page, '/workflows/new', 'a step the builder does not model');
  });

  test('create that the host cannot write stays at the action (65n)', async ({ page }) => {
    await answerUnwritable(
      page,
      'bureau.workflows.create',
      '~/.interborough/workflows/morning-briefing.json',
    );
    const root = await openBuilder(page, '/workflows/new');
    await openJsonTab(tabs(root));
    await replaceJsonEditorText(
      await jsonEditor(root, WORKFLOW_COPY.creator.textLabel),
      morningBriefingText,
    );
    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(root).toContainText(WORKFLOW_COPY.creator.nothingSaved);
    await capture(page, '/workflows/new', 'create failed');
  });

  test('edit has its JSON schedule, schema fields, write failure and dirty discard (65j, 65q, 65s, 65w, 66h)', async ({
    page,
  }) => {
    const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
    await answerUnwritable(page, 'bureau.workflows.update', 'release-notes.json');
    const route = `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}/edit`;
    const root = await openBuilder(page, `${route}?tab=json`);
    await openJsonTab(tabs(root));
    await capture(page, '/workflows/:workflow/edit', 'a file-defined schedule', 'json');
    await openTab(tabs(root), BUILDER.builderTab);
    await expect(root.getByTestId('schedule-when')).toBeVisible();
    await expect(root.locator('#workflow-builder-inputSchema')).toHaveAttribute(
      'data-cinder-variant',
      'fields',
    );
    await capture(page, '/workflows/:workflow/edit', 'schedule and schemas');
    await root
      .getByRole('textbox', { name: `${BUILDER.titleLabel} Optional` })
      .fill('Release notes, weekly');
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(root).toContainText(WORKFLOW_COPY.creator.nothingSaved);
    await capture(page, '/workflows/:workflow/edit', 'save failed');
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.cancelAction }).click();
    await expect(page.getByRole('dialog', { name: BUILDER.discard.title })).toBeVisible();
    await capture(page, '/workflows/:workflow/edit', 'cancel with unsaved changes');
  });
});
