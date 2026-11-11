/**
 * The Health Audit log tab on the sample world (`fixtures/sample-world-seed.ts`, the showcase host;
 * COR-2018, rows 82a to 82i, 82l, 82m, 82p, 82q, 82x to 82z, 83f and 83g). The page is read at
 * 1280 pixels, with the browser's clock pinned to the sample "now" so the period and the day
 * headings read as the boards draw them: the frame, the filter row with Export at its end, the
 * table under its day headings, the newest event open, and the pane of a tool call. Three events
 * the sample world does not hold are drawn by answering the Bureau's reads differently: an agent's
 * edit with a long change to its instructions, and a storage key whose name is two thousand
 * characters long, opened beside the table. Then the table and the pane at a phone's width.
 *
 * The sample world's log is what the host actually wrote, so its sentences are the ones the page
 * makes from those records; the design review reads each row against its board.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { answerAuditAsDesigned } from './board-activity-world.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'health-audit.spec.ts';

/** The table's rows. */
const rows = (page: Page) => page.locator('main tbody tr[data-cinder-row-id]');

/** One row as its four cells. */
async function cellsOf(page: Page, index: number): Promise<string[]> {
  return rows(page)
    .nth(index)
    .locator('th, td')
    .evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim() ?? ''));
}

/** Pins the browser's clock to the sample "now" and opens the log. */
async function openAudit(page: Page, address = '/health/audit'): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.goto(address);
  await expect(rows(page).first()).toBeVisible();
}

/**
 * Answers the Bureau's reads of `methods` with `answer`, from the request's own parameters, and
 * leaves every other read to the host.
 */
async function answerBureau(
  page: Page,
  answers: Record<string, (params: Record<string, unknown>) => unknown>,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const answer = body.method === undefined ? undefined : answers[body.method];
    if (answer === undefined) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: { jsonrpc: '2.0', id: body.id, result: answer(body.params ?? {}) },
    });
  });
}

/** A record at a Central-time clock time on a day of Oct or Nov 2026. */
function recordAt(
  sequence: number,
  month: 10 | 11,
  day: number,
  hour: number,
  minute: number,
  second: number,
  fields: Record<string, unknown>,
) {
  // Oct 29 is daylight time (UTC−5) and Nov 2 is standard time (UTC−6).
  const offset = month === 10 ? 5 : 6;
  return {
    sequence,
    timestamp: new Date(
      Date.UTC(2026, month - 1, day, hour + offset, minute, second),
    ).toISOString(),
    resource: 'host',
    principal: null,
    detail: null,
    ...fields,
  };
}

test.describe('Health › Audit log on the sample world', () => {
  test('is the Health frame, one row of filters with Export at its end, and the log under its day headings', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // The rows the board draws (`board-activity-world.ts`), in the sample world's own words.
    await answerAuditAsDesigned(page);
    await openAudit(page);
    const main = page.locator('main');

    // 82a to 82c: Health is active with its dot, the heading is Health, the tab is the leaf, and
    // the four tabs read in order with no Diagnostics tab.
    await expect(page.getByRole('link', { name: /^Health/ }).first()).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('header').getByText('Audit log', { exact: true })).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    await expect(main.getByTestId('storage-backend')).toContainText('Running on SQLite in');
    await expect(main.getByText('Live', { exact: true })).toBeVisible();
    await expect(main.getByRole('tab')).toHaveText(['Overview', 'Workers', 'Storage', 'Audit log']);
    await expect(main.getByRole('tab', { name: 'Audit log' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // 82d: who, period and action selects, the search, and the count, left to right in one row.
    const controls = [
      main.getByLabel('Who', { exact: true }),
      main.getByLabel('Period', { exact: true }),
      main.getByLabel('Action', { exact: true }),
      main.getByPlaceholder('Search by actor, action or target'),
      main.getByTestId('audit-count'),
    ];
    await expect(controls[0]!).toHaveValue('');
    await expect(controls[0]!.locator('option:checked')).toHaveText('Anyone');
    await expect(controls[1]!.locator('option:checked')).toHaveText('Last 7 days');
    await expect(controls[2]!.locator('option:checked')).toHaveText('Any action');
    await expect(controls[2]!.locator('option')).toHaveText([
      'Any action',
      'Approved',
      'Deleted',
      'Edited',
      'Removed',
      'Started',
    ]);
    await expect(controls[4]!).toHaveText(/^[\d,]+ events$/);
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    for (const [index, box] of boxes.entries()) {
      expect(box, `control ${index}`).not.toBeNull();
      if (index > 0) expect((box?.x ?? 0) > (boxes[index - 1]?.x ?? 0)).toBe(true);
      expect(Math.abs((box?.y ?? 0) - (boxes[0]?.y ?? 0))).toBeLessThan(20);
    }

    // 82e: Export is a secondary button with a download icon, at the end of the same row.
    const exportButton = main.getByRole('button', { name: 'Export', exact: true });
    await expect(exportButton).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(exportButton.locator('svg')).toHaveCount(1);
    const exportBox = await exportButton.boundingBox();
    const countBox = boxes[4];
    expect((exportBox?.x ?? 0) > (countBox?.x ?? 0)).toBe(true);
    expect(Math.abs((exportBox?.y ?? 0) - (boxes[0]?.y ?? 0))).toBeLessThan(20);

    // 82f: a data table of four columns in a bordered box beside the pane; What is semibold and
    // the rest regular, and every row is one line.
    await expect(main.locator('thead th')).toHaveText(['When', 'Who', 'What', 'Target']);
    const weights = await rows(page)
      .first()
      .locator('th, td')
      .evaluateAll((cells) =>
        cells.map((cell) => getComputedStyle(cell.querySelector('span') ?? cell).fontWeight),
      );
    expect(Number(weights[2])).toBeGreaterThanOrEqual(600);
    expect(Number(weights[1])).toBeLessThan(600);
    const heights = await rows(page).evaluateAll((all) =>
      all.slice(0, 9).map((row) => row.getBoundingClientRect().height),
    );
    expect(Math.max(...heights)).toBeLessThan(44);
    const layout = main.locator('.ib-audit__layout');
    expect(await layout.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe(
      '1px',
    );
    const tableBox = await main.locator('table').boundingBox();
    const paneBox = await main.getByTestId('audit-detail').boundingBox();
    expect((paneBox?.x ?? 0) >= (tableBox?.x ?? 0) + (tableBox?.width ?? 0) - 1).toBe(true);

    // 82h: today's rows, newest first as When, Who, What and Target, under a heading that names
    // the day and the zone; a row's target is one line.
    const headings = await main
      .locator('tbody th[colspan], tbody td[colspan]')
      .evaluateAll((cells) => cells.map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()));
    expect(headings[0]).toBe('Today, Nov 2, Central time');
    expect(await cellsOf(page, 0)).toEqual([
      '10:45 AM',
      'You',
      'Removed the Anthropic key',
      'Anthropic provider',
    ]);
    expect(await cellsOf(page, 1)).toEqual([
      '10:42 AM',
      'Tool runner',
      'Asked to refund order 4471',
      'Issue refund, order 4471',
    ]);
    expect(await cellsOf(page, 2)).toEqual([
      '10:42 AM',
      'You',
      'Started a run',
      'Chat › Please refund order 4471, it arrived damaged.',
    ]);
    expect(await cellsOf(page, 3)).toEqual([
      '10:33 AM',
      'Tool runner',
      'Refunded order 4472',
      '$18.50, Issue refund',
    ]);
    expect(await cellsOf(page, 4)).toEqual([
      '10:33 AM',
      'You',
      'Approved a tool call',
      'Issue refund, order 4472',
    ]);
    const today = await rows(page).evaluateAll((all) =>
      all.map((row) => row.querySelector('td, th')?.textContent?.trim() ?? ''),
    );
    expect(today.slice(0, 5)).toEqual(['10:45 AM', '10:42 AM', '10:42 AM', '10:33 AM', '10:33 AM']);
    // 82j: the rest of the timeline holds: order 4472 asked at 10:30 before it was approved and
    // refunded, and the server started at 9:00 AM and logged the Daily summary runs it missed.
    expect(await cellsOf(page, 6)).toEqual([
      '10:30 AM',
      'Tool runner',
      'Asked to refund order 4472',
      'Issue refund, order 4472',
    ]);
    expect(await cellsOf(page, 7)).toEqual([
      '9:00 AM',
      'Interborough',
      'Noticed 4 missed runs',
      'Daily summary',
    ]);
    // The server names the version it started at.
    expect(await cellsOf(page, 8)).toEqual([
      '9:00 AM',
      'Interborough',
      'Server started',
      'Interborough 2.4.1',
    ]);
    // 82h: today lists nine rows, and the log nine plus the two days that follow.
    await expect(rows(page)).toHaveCount(11);
    // 82i: yesterday's one row follows under a heading of its own, then Thu Oct 29's.
    expect(headings[1]).toBe('Yesterday, Sun Nov 1, Central time');
    expect(await cellsOf(page, 9)).toEqual([
      '4:12 PM',
      'You',
      'Deleted a chat',
      '“Scratch test”, 12 messages',
    ]);
    expect(headings[2]).toBe('Thu Oct 29, Central time');
    expect(await cellsOf(page, 10)).toEqual([
      '11:38 AM',
      'You',
      'Edited an agent',
      'Tool runner, version 3 → 4',
    ]);
    const texts = await rows(page).evaluateAll((all) => all.map((row) => row.textContent ?? ''));
    expect(
      texts.some((text) => text.includes('Interborough') && text.includes('Noticed 4 missed runs')),
    ).toBe(true);
    expect(
      texts.some((text) => text.includes('Interborough') && text.includes('Server started')),
    ).toBe(true);
    // 82j: the log holds actions and decisions, and no row is a chat message: the one row that says
    // "messages" is the deleted chat's, which counts them.
    expect(texts.filter((text) => /message/i.test(text) && !text.includes('Scratch test'))).toEqual(
      [],
    );

    // 82l: the newest event is open on load with its row tinted; the pane sits beside the table.
    await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');

    // 82m, 82n: the pane of the key removal, top to bottom, with its footer.
    const pane = main.getByTestId('audit-detail');
    await expect(pane.locator('h3')).toHaveText('You removed the Anthropic key');
    await expect(pane).toContainText(
      /^You removed the Anthropic key\s*Today at 10:45:00 AM, from this browser/,
    );
    // One flat list holds every fact, a row each, with no box around any of them.
    await expect(pane.getByTestId('audit-facts').locator('dl')).toHaveCount(1);
    const facts = pane.locator('.ib-audit-detail__fact');
    await expect(facts.nth(0)).toContainText('Provider');
    await expect(facts.nth(0)).toContainText('Anthropic');
    await expect(facts.nth(1)).toContainText('Effect');
    await expect(facts.nth(1)).toContainText(
      'Agents that use a model can’t run until a provider is connected',
    );
    await expect(pane.getByRole('link', { name: 'Open Providers ›' })).toHaveAttribute(
      'href',
      '/settings/models',
    );
    const copyJson = pane.getByRole('button', { name: 'Copy as JSON' });
    await expect(copyJson).toBeVisible();
    await expect(copyJson).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(pane).toContainText(
      'Audit records are kept 90 days (Settings › Data and retention). Export downloads the filtered list as JSON Lines.',
    );
    await expect(pane.getByRole('link', { name: 'Settings › Data and retention' })).toHaveAttribute(
      'href',
      '/settings/data-and-retention',
    );

    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'ready',
      source: SOURCE,
    });
    await checkA11y('health audit log at 1280px');
  });

  test('a tall window holds every day under its heading, down to Thu Oct 29, with no row below the table’s own scroll', async ({
    page,
    checkA11y,
  }) => {
    // The table is as tall as the window less the page around it, and scrolls inside that, so the
    // last day is below the fold of an ordinary window. 1500 pixels hold every day (rows 82h, 82i).
    await page.setViewportSize({ width: 1280, height: 1500 });
    await answerAuditAsDesigned(page);
    await openAudit(page);
    const main = page.locator('main');
    const headings = main.locator('tbody th[colspan], tbody td[colspan]');
    await expect(headings.nth(0)).toHaveText('Today, Nov 2, Central time');
    await expect(headings.nth(1)).toHaveText('Yesterday, Sun Nov 1, Central time');
    const oldest = headings.filter({ hasText: /^Thu Oct 29/ });
    await expect(oldest).toHaveCount(1);
    await oldest.scrollIntoViewIfNeeded();
    const box = await oldest.boundingBox();
    expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(1500);
    const texts = await rows(page).evaluateAll((all) => all.map((row) => row.textContent ?? ''));
    expect(
      texts.some((text) => text.includes('Edited an agent') && text.includes('Tool runner')),
    ).toBe(true);
    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'ready all days',
      source: SOURCE,
    });
    await checkA11y('health audit log, every day, at 1280 by 1500');
  });

  test('a tool call that asks is titled by the agent and the tool’s own words, with the tool, its risk, the amount and Waiting on you', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // The rows the board draws: the sample world also holds the settings changes its own seeding
    // made at 10:45 AM (three `settings.changed` events), which the design's nine rows leave out.
    await answerAuditAsDesigned(page);
    await openAudit(page);
    const main = page.locator('main');
    await rows(page).nth(1).click();
    const pane = main.getByTestId('audit-detail');

    // 82x: the title, and the line that names the chat by its real title.
    await expect(pane.locator('h3')).toHaveText('Tool runner asked to refund order 4471');
    await expect(pane).toContainText(
      'Today at 10:42:20 AM, in the chat “Please refund order 4471, it arrived damaged.”',
    );

    // 82y: Tool with the small identifier, Risk as muted text, Amount, and Status in the warning
    // tone with the shared word; the agent and the chat repeat the title, so they are no rows.
    await expect(pane.getByTestId('audit-facts').locator('dl')).toHaveCount(1);
    const lists = pane.locator('.ib-audit-detail__fact');
    await expect(lists).toHaveCount(4);
    await expect(lists.nth(0)).toContainText('Tool');
    await expect(lists.nth(0)).toContainText('Issue refund');
    await expect(lists.nth(0).locator('code')).toHaveText('issue-refund');
    await expect(lists.nth(1)).toContainText('Risk');
    await expect(lists.nth(1)).toContainText('Dangerous, Can’t be undone');
    const riskColor = await lists
      .nth(1)
      .locator('dd span')
      .evaluate((element) => getComputedStyle(element).color);
    const bodyColor = await lists
      .nth(0)
      .locator('dd span')
      .first()
      .evaluate((element) => getComputedStyle(element).color);
    expect(riskColor).not.toBe(bodyColor);
    await expect(lists.nth(2)).toContainText('Amount');
    await expect(lists.nth(2)).toContainText('$42.00');
    await expect(lists.nth(3)).toContainText('Status');
    await expect(lists.nth(3)).toContainText('Waiting on you');
    await expect(pane.getByText('Needs you')).toHaveCount(0);
    await expect(pane.getByText('Agent', { exact: true })).toHaveCount(0);

    // 82z: Open review and Copy as JSON, then the footer.
    await expect(pane.getByRole('link', { name: 'Open review ›' })).toHaveAttribute(
      'href',
      /^\/reviews\?review=approval/,
    );
    await expect(pane.getByRole('button', { name: 'Copy as JSON' })).toBeVisible();
    await expect(pane).toContainText('Audit records are kept 90 days');

    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'a tool-call event',
      source: SOURCE,
    });
    await checkA11y('health audit log, a tool-call event');
  });

  test('an agent’s edit shows its version, what changed and the instructions’ diff clamped to six lines with Show all', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const definition = (instructions: string) => ({
      name: 'tool-runner',
      description: null,
      model: 'sonnet',
      tools: [],
      card: [],
      a2a: false,
      instructions,
    });
    const header = 'You handle refund requests and order questions.';
    const footer = 'Escalate refunds over $100 to a person.';
    const before = [header, 'Always answer within two sentences.', footer].join('\n');
    const after = [
      header,
      'Answer in as many sentences as the question needs, and',
      'link the order page whenever an order number appears.',
      footer,
      ...Array.from({ length: 60 }, (_, index) => `Follow rule ${index + 1} before replying.`),
    ].join('\n');
    await answerBureau(page, {
      'bureau.audit.query': (params) =>
        params['includeTotal'] === true
          ? { records: [], nextCursor: null, total: 1 }
          : {
              records: [
                recordAt(26, 10, 29, 7, 40, 12, {
                  type: 'agent.updated',
                  resource: 'agent:tool-runner',
                  principal: 'anonymous:local',
                  detail: {
                    agentName: 'tool-runner',
                    revision: 4,
                    previousRevision: 3,
                    changedKeys: 'instructions,tools',
                    toolsAdded: 'issue-refund',
                  },
                }),
              ],
              nextCursor: null,
            },
      'bureau.agents.versions.list': () => ({
        versions: [
          {
            revision: 4,
            hash: 'b',
            savedAt: '2026-10-29T12:40:12Z',
            savedBy: null,
            definition: definition(after),
            changedKeys: [],
          },
          {
            revision: 3,
            hash: 'a',
            savedAt: '2026-10-20T12:40:12Z',
            savedBy: null,
            definition: definition(before),
            changedKeys: [],
          },
        ],
      }),
    });
    await openAudit(page, '/health/audit?period=30d');
    const main = page.locator('main');
    const pane = main.getByTestId('audit-detail');

    // 82p: the title, the line, and the rows Agent (a link), Version and Changed.
    await expect(pane.locator('h3')).toHaveText('You edited an agent');
    await expect(pane).toContainText('Thu Oct 29 at 7:40:12 AM, from this browser');
    const rows = pane.locator('.ib-audit-detail__fact');
    await expect(rows.nth(0)).toContainText('Agent');
    await expect(rows.nth(0).getByRole('link', { name: 'Tool runner' })).toHaveAttribute(
      'href',
      '/agents/tool-runner',
    );
    await expect(rows.nth(1)).toContainText('3 → 4');
    await expect(rows.nth(2)).toContainText('Instructions, Tools, added Issue refund');

    // 82q: a diff clamped to a few lines, with a footer that counts and a Show all at its right.
    const diff = pane.getByTestId('audit-instruction-diff');
    await expect(diff).toContainText(/Showing 6 of \d+ changed lines/);
    await expect(diff.locator('.cinder-source-diff-viewer__line-code').first()).toHaveText(header);
    const removed = diff.locator('[data-cinder-line-kind="removal"]');
    await expect(removed.first()).toContainText('Always answer within two sentences.');
    const showAll = diff.getByRole('button', { name: 'Show all' });
    await expect(showAll).toBeVisible();

    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'a long change',
      source: SOURCE,
    });
    await checkA11y('health audit log, a long change');
    await showAll.click();
    await expect(diff.getByRole('button', { name: 'Show all' })).toHaveCount(0);
    await expect(diff).toContainText('Follow rule 60 before replying.');
  });

  test('a very long target is one line in its row and whole in the pane, with its length and Copy key', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const stem = 'workflows/release-notes/checkpoints/9f2c1e7a-4b6d-48aa-b0e3-5d7f1c2a9e11/steps/';
    const key =
      `${stem}${'collect-merged-changes/attempts/3/output/'.repeat(60)}`.slice(0, 1990) +
      'notes.json';
    expect(key).toHaveLength(2000);
    await answerBureau(page, {
      'bureau.audit.query': (params) =>
        params['includeTotal'] === true
          ? { records: [], nextCursor: null, total: 2 }
          : {
              records: [
                recordAt(40, 11, 2, 9, 12, 0, {
                  type: 'storage.key.deleted',
                  resource: `storage:${key}`,
                  principal: 'system:host',
                }),
                recordAt(39, 11, 2, 9, 0, 0, {
                  type: 'host.started',
                  principal: 'system:host',
                }),
              ],
              nextCursor: null,
            },
    });
    await openAudit(page);
    const main = page.locator('main');

    // 83f: the target keeps to one line with an ellipsis, so the row is as tall as any other.
    const cell = rows(page).first().locator('td').last();
    await expect(cell.locator('.cinder-table__cell-text')).toHaveAttribute(
      'title',
      `Storage › ${key}`,
    );
    const lineHeights = await rows(page).evaluateAll((all) =>
      all.map((row) => row.getBoundingClientRect().height),
    );
    expect(Math.abs((lineHeights[0] ?? 0) - (lineHeights[1] ?? 0))).toBeLessThan(2);
    const overflow = await cell
      .locator('.cinder-table__cell-text')
      .evaluate((element) => getComputedStyle(element).textOverflow);
    expect(overflow).toBe('ellipsis');

    // 83g: the pane shows the whole value, wrapped, in small monospace, with its length and Copy key.
    const target = main.getByTestId('audit-target');
    await expect(main.getByTestId('audit-detail').locator('dl')).toHaveCount(0);
    await expect(target).toContainText('Target, 2,000 characters');
    await expect(target.locator('p').nth(1)).toHaveText(key);
    const mono = await target
      .locator('p')
      .nth(1)
      .evaluate((element) => getComputedStyle(element).fontFamily);
    expect(mono).toMatch(/mono/i);
    await expect(target.getByRole('button', { name: 'Copy key' })).toBeVisible();
    // A value with no break in it never widens the pane or the page.
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    const paneBox = await main.getByTestId('audit-detail').boundingBox();
    const targetBox = await target.boundingBox();
    expect((targetBox?.x ?? 0) + (targetBox?.width ?? 0)).toBeLessThanOrEqual(
      (paneBox?.x ?? 0) + (paneBox?.width ?? 0) + 1,
    );

    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'a very long target',
      source: SOURCE,
    });
    await checkA11y('health audit log, a very long target');
  });

  test('at a phone’s width the table and an event’s pane are one pane at a time, with a Back button', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // The rows the board draws, as above: the sample world's own settings changes are not among them.
    await answerAuditAsDesigned(page);
    await openAudit(page);
    const main = page.locator('main');

    // 82l: below the push breakpoint the list shows alone, and choosing a row pushes its pane.
    await expect(main.getByTestId('audit-detail')).toHaveCount(0);
    await captureForDesignReview(page, { route: '/health/audit', state: 'ready', source: SOURCE });
    await checkA11y('health audit log at 375px');
    await rows(page).nth(1).click();
    await expect(main.getByTestId('audit-detail')).toBeVisible();
    await expect(main.getByTestId('audit-detail').locator('h3')).toHaveText(
      'Tool runner asked to refund order 4471',
    );
    await expect(rows(page)).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'an event open',
      source: SOURCE,
    });
    await main.getByRole('button', { name: 'Back' }).click();
    await expect(rows(page).first()).toBeVisible();
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  });

  test('narrows by who, action and text, holds the filters in the address, and opens nothing until a row is chosen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAudit(page);
    const main = page.locator('main');

    await main.getByLabel('Who', { exact: true }).selectOption('agents');
    await expect(page).toHaveURL(/actor=agents/);
    await expect(rows(page).first()).toBeVisible();
    for (const cells of await rows(page).evaluateAll((all) =>
      all.map((row) => [...row.querySelectorAll('td, th')].map((cell) => cell.textContent?.trim())),
    )) {
      expect(cells[1]).not.toBe('You');
      expect(cells[1]).not.toBe('Interborough');
    }
    // 82s: with filters changed no event is open, and the pane says what to do.
    await expect(main.getByText('Select an event to see what changed')).toBeVisible();
    await expect(
      main.getByText('Each event shows who did it, when, and the before and after.'),
    ).toBeVisible();

    await main.getByLabel('Who', { exact: true }).selectOption('');
    await main.getByLabel('Action', { exact: true }).selectOption('removed');
    await expect(page).toHaveURL(/action=removed/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Removed the Anthropic key');
    await expect(main.getByTestId('audit-count')).toHaveText('1 event');

    await main.getByLabel('Action', { exact: true }).selectOption('');
    await main.getByPlaceholder('Search by actor, action or target').fill('4472');
    await expect(rows(page).first()).toBeVisible();
    for (const text of await rows(page).evaluateAll((all) =>
      all.map((row) => row.textContent ?? ''),
    )) {
      expect(text).toContain('4472');
    }
  });
});
