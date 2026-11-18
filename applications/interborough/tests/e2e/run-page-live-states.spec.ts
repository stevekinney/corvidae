/**
 * The run page (`/runs/:run`) in the captioned states the sample world does not hold (COR-2424,
 * design rows 54l, 54f, 56g and 06b), captured for the design review on a desktop and a phone. Each
 * state is the sample world's own run with the host's answers rewritten by route stubbing, the way
 * `runs-states.spec.ts` builds its `row states` variant: the failed Release notes run answers as a
 * run you started by hand on the current version, still going at step 2 of 4 (54l, 54p), and as one
 * parked on the signal `notes-approved` (56g), the finished chat run answers as a run that is still
 * at its first call, with its message bar docked (06b), and
 * the finished chat run itself holds Run again because no provider is connected (54f).
 *
 * Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW_MILLISECONDS, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'run-page-live-states.spec.ts';
const WIDTHS = [1280, 375] as const;

type JsonRecord = Record<string, unknown>;

/** Answers the Bureau operation `method` with its own answer rewritten by `rewrite`; others pass through. */
async function rewriteOperation(
  page: Page,
  method: string,
  rewrite: (result: JsonRecord) => JsonRecord,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    await route.fulfill({
      response,
      json: { ...answer, result: rewrite(answer.result ?? {}) },
    });
  });
}

/** A further rewrite of the engine's state and of the Bureau's record of an instance. */
interface InstanceRewrite {
  readonly engine?: (state: JsonRecord) => JsonRecord;
  readonly record?: (record: JsonRecord) => JsonRecord;
}

/**
 * Makes the sample world's failed Release notes run answer as a run still going: the engine says
 * `running` since `startedMilliseconds` before the sample clock, the Bureau's record agrees, and the
 * history ends without its terminal event.
 */
async function answerAsRunningInstance(
  page: Page,
  runId: string,
  startedMilliseconds: number,
  waitingForSignals: readonly string[],
  also: InstanceRewrite = {},
): Promise<void> {
  const startedAt = SAMPLE_NOW_MILLISECONDS - startedMilliseconds;
  // One handler for each answer: a second handler's `route.fetch()` would go to the network and
  // undo the first's rewrite, so a further rewrite (`also`) is applied inside these.
  await page.route(new RegExp(`/workflows/${runId}(\\?.*)?$`), async (route: Route) => {
    const response = await route.fetch();
    const state = (await response.json()) as JsonRecord;
    delete state['error'];
    delete state['errorStack'];
    delete state['failureCategory'];
    delete state['result'];
    const running = {
      ...state,
      status: 'running',
      createdAt: startedAt,
      updatedAt: SAMPLE_NOW_MILLISECONDS - 1000,
      ...(waitingForSignals.length === 0 ? {} : { waitingForSignals }),
    };
    await route.fulfill({ response, json: also.engine?.(running) ?? running });
  });
  await rewriteOperation(page, 'bureau.workflows.runs.get', (record) => {
    const running = {
      ...record,
      status: 'running',
      error: null,
      finishReason: null,
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(SAMPLE_NOW_MILLISECONDS - 1000).toISOString(),
    };
    return also.record?.(running) ?? running;
  });
  await rewriteOperation(page, 'bureau.workflows.runs.history', (history) => ({
    ...history,
    events: ((history['events'] as JsonRecord[] | undefined) ?? []).filter(
      (event) => event['type'] !== 'file-workflow:run-terminal',
    ),
  }));
}

/** The principal the local, uncredentialed caller is (`weft.system.principal`'s subject). */
const LOCAL_PRINCIPAL = 'anonymous:local';

/** One JSON-RPC call to the sample world's Bureau, as the local caller. */
async function bureauResult<T>(method: string, params: JsonRecord): Promise<T> {
  const response = await fetch(new URL('/bureau/jsonrpc', E2E_SHOWCASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Makes the Release notes instance one a person started by hand from the workflow's page, on the
 * workflow's current version, with the one field a person fills in (rows 54l and 54p): the Bureau's
 * record names the viewer as its origin and the current version as the one it runs, and the engine
 * holds the person's input and that version, not the schedule's trigger. The schedule-fired run
 * the sample world holds would read the Schedule chain and "1.2.0, older version".
 */
async function personStarted(): Promise<InstanceRewrite> {
  const file = await bureauResult<{ version: string | null }>('bureau.workflows.get', {
    id: 'release-notes',
  });
  const current = file.version;
  if (current === null) throw new Error('Release notes has no current version.');
  // What `bureau.workflows.start` starts an instance with: the person's input inside the manual
  // envelope, and the person as its origin (`workflow-runtime.ts`).
  const origin = { kind: 'person', principal: LOCAL_PRINCIPAL, surface: 'web' };
  const trigger = { kind: 'manual', input: { branch: 'main' }, origin };
  return {
    engine: (state) => ({
      ...state,
      input: trigger,
      versionTuple: {
        ...(state['versionTuple'] as JsonRecord | undefined),
        workflowVersion: current,
      },
    }),
    record: (record) => ({ ...record, origin, trigger, workflowVersion: current }),
  };
}

/**
 * Makes the chat's thread read as the run still at its first call (row 06b): the message that
 * started it is sent as the run starts, the call is made `callAfterMilliseconds` later and has no
 * result yet, and there is no reply. Every row of the thread after the run's first call is dropped.
 */
async function answerThreadAsInFlight(
  page: Page,
  runId: string,
  startedAt: number,
  callAfterMilliseconds: number,
): Promise<void> {
  await page.route('**/ag-ui/threads/*/messages', async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as JsonRecord & { messages?: JsonRecord[] };
    const rows = body.messages ?? [];
    const firstCall = rows.findIndex(
      (row) =>
        String(row['id']).startsWith(`${runId}:`) &&
        row['role'] === 'assistant' &&
        Array.isArray(row['toolCalls']) &&
        row['toolCalls'].length > 0,
    );
    if (firstCall === -1) {
      await route.fulfill({ response, json: body });
      return;
    }
    const lastUser = rows.slice(0, firstCall).findLastIndex((row) => row['role'] === 'user');
    const messages = rows.slice(0, firstCall + 1).map((row, index) => {
      if (index === lastUser) return { ...row, createdAt: new Date(startedAt).toISOString() };
      if (index === firstCall) {
        return { ...row, createdAt: new Date(startedAt + callAfterMilliseconds).toISOString() };
      }
      return row;
    });
    await route.fulfill({ response, json: { ...body, messages } });
  });
  // The run's own stream is held open with nothing on it: the Bureau's stream of the finished run
  // would hand the page its reply and its terminal status.
  await page.route('**/bureau/v1/subscriptions/bureau.tasks.events**', () => {
    // Never answered: the stream stays connecting.
  });
}

/** Opens `path` at `width` and waits until the run's header says its status. */
async function openRun(
  page: Page,
  path: string,
  width: number,
  now: number = SAMPLE_NOW_MILLISECONDS,
): Promise<void> {
  await page.clock.setFixedTime(now);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();
}

for (const width of WIDTHS) {
  // The route leads the title, so a design review's route filter (`--grep '/runs/:run'`) runs these.
  test.describe(`/runs/:run at ${String(width)} pixels`, () => {
    test('a Release notes run you started, still going, says when it started and its step, and offers no Run again (54l, 54p)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await answerAsRunningInstance(page, world.runs.failed, 40_000, [], await personStarted());
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const header = page.locator('[data-run-header]');
      await expect(header).toContainText(/Running\s*, started 40 s ago, step 2 of 4/);
      await expect(header.getByRole('link', { name: 'Run again' })).toHaveCount(0);
      await expect(header.getByRole('button', { name: 'Run again' })).toHaveCount(0);
      // Started by is the person's chain, never the schedule's (54l): You, the run they started, this run.
      const lineage = page.getByTestId('run-lineage');
      await expect(lineage).toContainText('You');
      await expect(lineage).toContainText('Release notes, Mon, Nov 2, 10:45 AM');
      await expect(lineage).toContainText('This run');
      await expect(lineage).not.toContainText('Schedule');
      // The current version, and the branch the person gave it (54p).
      await expect(page.getByText('1.3.0, current version')).toBeVisible();
      await expect(page.locator('[data-section="input-output"]')).toContainText(/Branch\s*main/);
      // Counted as row 28e counts a card: every top-level key of what the run was started with, the
      // manual envelope's own keys (`kind`, `origin`) in JSON only, as the failed run's card does.
      await expect(page.locator('[data-section="input-output"]')).toContainText(
        /3 fields,\s*2 in JSON only/,
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'live instance',
        source: SOURCE,
      });
    });

    test('a run parked on a signal reads Waiting, and its header offers Cancel run (56g)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await answerAsRunningInstance(page, world.runs.failed, 56 * 60_000, ['notes-approved']);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const header = page.locator('[data-run-header]');
      await expect(header).toContainText('Waiting');
      await expect(header).toContainText('waiting for signal');
      // What it waits for, and nothing of its step (56g).
      await expect(header).not.toContainText('step 2 of 4');
      await expect(header).toContainText('notes-approved');
      await expect(header.getByRole('button', { name: 'Cancel run' })).toBeVisible();
      await expect(page.locator('[data-section="waiting"]')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'waiting on a signal',
        source: SOURCE,
      });
    });

    test('a chat run still going shows how long it has run and docks its message bar (06b)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      // Started at 10:45:50 AM, made its call 4 s later, and read 12 s after it started (06b).
      const startedAt = Date.parse('2026-11-02T10:45:50-06:00');
      const now = startedAt + 12_000;
      await rewriteOperation(page, 'bureau.tasks.get', (task) => ({
        ...task,
        status: 'working',
        createdAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(now - 1000).toISOString(),
      }));
      await answerThreadAsInFlight(page, world.runs.done, startedAt, 4000);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.done)}`, width, now);

      await expect(page.locator('[data-run-header]')).toContainText(/12 s so far/);
      // What happened says when it started to the second, and the call after the start (06b).
      const happened = page.locator('[data-section="what-happened"]');
      await expect(happened).toContainText('Started 10:45:50 AM');
      await expect(happened.locator('.ib-run-happened__offset').first()).toHaveText('+4 s');
      await expect(happened).toContainText('Not run yet');
      // The bar is docked: on the screen without scrolling, above the tab bar on a phone.
      const bar = page.getByRole('group', { name: 'Message the run' });
      await expect(bar).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Cancel run' })).toBeVisible();
      if (width <= 600) {
        const { docked, tabs } = await readBoxes(page, {
          docked: bar,
          tabs: page.locator('.weft-shell-tab-bar'),
        });
        expect(docked.y + docked.height).toBeLessThanOrEqual(tabs.y + 1);
        expect(docked.y).toBeGreaterThan(0);
      }
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'live chat run',
        source: SOURCE,
      });
    });

    test('a Release notes run whose step was tried three times says so on the step (14t, 55b)', async ({
      page,
    }) => {
      // Bureau runs an agent step once, so the sample world's failed run tried step 2 once: the
      // engine's timeline is rewritten to hold three tries of it, 3.4 s from the first to the last.
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await page.route(
        new RegExp(`/workflows/${world.runs.failed}/timeline(\\?.*)?$`),
        async (route: Route) => {
          const response = await route.fetch();
          const entries = (await response.json()) as JsonRecord[];
          const tries = entries.filter(
            (entry) => entry['documentStep'] === 1 && entry['operationType'] === 'activity',
          );
          const first = tries[0];
          if (first === undefined)
            throw new Error('The failed run’s timeline holds no try of step 2.');
          const start = Number(first['timestamp']);
          const retried = [0, 1400, 2800].map((offset, index) => ({
            ...first,
            step: Number(first['step']) + index,
            timestamp: start + offset,
            duration: 600,
            status: 'failed',
          }));
          await route.fulfill({
            response,
            json: [...entries.filter((entry) => !tries.includes(entry)), ...retried].toSorted(
              (left, right) => Number(left['timestamp']) - Number(right['timestamp']),
            ),
          });
        },
      );
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const block = page.getByTestId('run-step-failure');
      await expect(block).toContainText('Step 2, Collect merged changes, failed after 3 tries');
      await expect(block).toContainText('Interborough tried 3 times in 3.4 s.');
      // The engine records no activity text for the step, so no "while …" clause is said.
      await expect(block).not.toContainText(' while ');
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'failed after three tries',
        source: SOURCE,
      });
    });

    test('a finished chat run holds Run again with a link to connect a provider beneath it (54f)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.done)}`, width);

      const again = page.getByRole('button', { name: 'Run again' });
      await expect(again).toHaveAttribute('aria-disabled', 'true');
      const connect = page.getByRole('link', { name: 'Connect a provider' });
      await expect(connect).toHaveAttribute('href', '/settings/models');
      await expect(again).toHaveAttribute(
        'aria-describedby',
        (await connect.getAttribute('id')) ?? '',
      );
      // Beneath the actions, in the header's caption, never beside or above them (54f, 54z).
      const { button, link } = await readBoxes(page, { button: again, link: connect });
      expect(link.y).toBeGreaterThanOrEqual(button.y + button.height - 1);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'run again held, no provider',
        source: SOURCE,
      });
    });
  });
}
