/**
 * Every route in the route table, and every tab it offers, at 375, 768 and 1280 pixels, with long
 * values seeded where a page prints them: a 2,000-character storage key, a 200-character agent
 * description and a 300-character unbroken memory.
 *
 * A route fits when, at every width and on every tab, all of these hold:
 *
 * - neither the document nor the shell's outlet scrolls sideways;
 * - no box in the outlet reaches past the viewport's right edge unless an ancestor below the outlet
 *   holds it, in the next two ways;
 * - a region that scrolls sideways (`overflow-x: auto` or `scroll`) holds at most twice the
 *   viewport's width, so a wide table is a few swipes, not a 16,000-pixel scroll to read one value;
 * - a region that clips sideways (`overflow-x: hidden` or `clip`) either holds what it contains or
 *   truncates it with an ellipsis (`text-overflow: ellipsis`). Content cut off with no ellipsis and
 *   no way to reach it is overflow. A one-pixel visually-hidden region is not, and neither is the
 *   value in a text field, which scrolls itself.
 *
 * The page is measured only once it holds its seeded content: the frame is in the state the seed
 * gives that route (`ready` unless `EXPECTED_STATE` says otherwise), nothing is busy, the text a
 * seeded value prints is there (`MARKERS`), and the outlet's text has stopped changing.
 *
 * A route listed in `pending` (`responsive-routes.ts`) is not yet made responsive, and names the
 * issue that owns doing it. The list can only shrink: a listed route that fits (at the widths its
 * entry says it fails at) fails this specification, so remove it; an unlisted route that overflows
 * fails it too.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { STORAGE_COPY, WORKFLOW_COPY } from '../../src/app/copy.ts';
import { routes } from '../../src/app/routes.ts';
import { SEEDED_GOAL_RUN_IDENTIFIER } from '../../src/host/seed.ts';
import { createAgentFile, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import {
  pending,
  responsiveAddresses,
  responsiveVariants,
  type ResponsiveSeed,
} from './responsive-routes.ts';
import { bureauCall, waitingReviewOf } from './task-support.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 768, 1280] as const;
const HEIGHT = 900;

/** One edit of the host's catalog, as far as this specification reads it. */
interface CatalogEdit {
  readonly provider: string;
  readonly model: string;
  readonly basedOn?: string;
}

/** A scrolling region may hold this many viewports of content before it counts as overflow. */
const SCROLL_REGION_VIEWPORTS = 2;

const AGENT_ID = 'responsive-long-description';
/** The agent whose instructions hold the long word, on its Instructions tab and in its editor. */
const INSTRUCTIONS_AGENT_ID = 'responsive-long-instructions';
const LONG_DESCRIPTION = 'An agent description that keeps going well past one line. '
  .repeat(4)
  .padEnd(200, 'x')
  .slice(0, 200);
/** An instructions body with a word no line can break at, to be rendered as a document. */
const LONG_INSTRUCTIONS = `Responsive instructions ${'i'.repeat(300)}`;
const LONG_STORAGE_KEY = `responsive-${'k'.repeat(1989)}`;
const LONG_MEMORY = `responsive-memory-${'m'.repeat(300)}`;
/** A catalog row whose model name is one unbroken word, to be listed on Settings › Models. */
const LONG_MODEL = `responsive-model-${'m'.repeat(300)}`;
const CHAT_THREAD = newThreadId('responsive');
/** The chats whose runs wait on, and have had, an approval: each title is one 300-character word. */
const REVIEW_THREAD = newThreadId('responsive-review');
const DECIDED_REVIEW_THREAD = newThreadId('responsive-decided-review');
const LONG_REVIEW_TITLE = `Refund ${'w'.repeat(300)}`;
const MEMORY_THREAD = newThreadId('responsive-memory');
/** The agent-authored workflow the end-to-end host starts with; it has a file, so it has an editor. */
const WORKFLOW_FILE = 'e2e-digest';

/** The state the frame is in once a route holds its seeded content; `ready` unless listed. */
const EXPECTED_STATE: Readonly<Record<string, string>> = {};

/** Text a route prints only once its seeded content has loaded. */
const MARKERS: Readonly<Record<string, RegExp>> = {
  // The list prints the seeded chats' titles, among them the memory thread's 300-character one.
  '/chats': /Say hello/,
  '/chats/:chat': /Say hello/,
  '/agents': /An agent description that keeps going/,
  '/capabilities': /Reads only|Changes things|Dangerous|Not classified/,
  '/capabilities (skills tab)': /e2e-summarize/,
  // Only the open skill's detail prints this heading; the long word is in its row at 1280 too.
  '/capabilities (skill open)': /Where it comes from/,
  '/agents/:agent': /An agent description that keeps going/,
  '/agents/:agent (instructions tab)': /iiiiiiiiii/,
  '/agents/:agent (settings tab)': /Version 1/,
  // Only the form prints this heading; the long word is in the textarea, which the text does not include.
  '/agents/:agent/edit': /Guardrails and limits/,
  '/agents/:agent/memories': /mmmmmmmmmm/,
  '/workflows': /order-processing/,
  '/workflows/:workflow/runs': /order-processing/,
  '/workflows/:workflow (file)': /Writes the daily digest/,
  '/workflows/:workflow (file, code tab)': /Write the digest/,
  '/workflows/:workflow (file, runs tab)': /Recent runs/,
  '/workflows/:workflow (file, history tab)': /Revisions that have run/,
  '/workflows/:workflow/runs/:run': /Input and output/,
  '/workflows/:workflow/edit': /Workflow file/,
  '/runs/:run': /Input and output/,
  // The list prints the question each waiting review asks, and the open review its source line,
  // which links to the chat whose title is the long word.
  '/reviews': /Refund order order-1001 for/,
  '/reviews (review open)': /wwwwwwwwww/,
  '/reviews (done tab, review open)': /wwwwwwwwww/,
  '/schedules': /inventory-sync/,
  '/schedules/:schedule': /Next fires/,
  '/goals': /seeded-goal/,
  '/goals/:goal': /seeded-goal/,
  // This host's engine holds none of the Bureau's own types; the Bureau's host lists them (26-workflows).
  '/internal-workflows': /No internal workflows/,
  '/health/runs': /order-processing/,
  // The summary line prints once the fleet, its queues and its diagnostics have all been read.
  '/health/workers': /\d+ of \d+ connected/,
  '/health/workers (worker open)': /Last heard from/,
  // The audit log lists the seeded schedule's creation.
  '/health/audit': /schedule\.created/,
  // The added row's long name, beside the Decisions part's heading, which loads last.
  '/settings/models': /mmmmmmmmmm/,
};

/** What was measured: how far the document and the outlet scroll sideways, and what else does not fit. */
interface Overflow {
  readonly document: number;
  readonly outlet: number;
  readonly violations: readonly string[];
}

/** Measures the page by the rules in this file's header. */
async function overflowOf(page: Page): Promise<Overflow> {
  return page.evaluate((scrollRegionViewports) => {
    const outlet = document.querySelector('main.weft-shell-outlet');
    const viewport = window.innerWidth;
    const limit = viewport + 1;
    const name = (element: Element): string => {
      const first = typeof element.className === 'string' ? element.className.split(' ')[0] : '';
      return element.tagName.toLowerCase() + (first ? `.${first}` : '');
    };
    /** Whether an ancestor below the outlet scrolls or clips sideways; that region is judged on its own. */
    const heldByRegion = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== outlet;) {
        if (getComputedStyle(parent).overflowX !== 'visible') return true;
        parent = parent.parentElement;
      }
      return false;
    };
    const violations: string[] = [];
    const add = (violation: string): void => {
      if (!violations.includes(violation) && violations.length < 8) violations.push(violation);
    };
    if (outlet !== null) {
      for (const element of outlet.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if (style.display === 'none') continue;
        // A text field scrolls its own value, which is what it is for.
        const isField = /^(input|textarea|select)$/i.test(element.tagName);
        if (
          !isField &&
          style.overflowX !== 'visible' &&
          element.clientWidth > 1 &&
          element.scrollWidth > element.clientWidth + 1
        ) {
          const held = `${name(element)} holds ${element.scrollWidth}px in ${element.clientWidth}px`;
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
            if (element.scrollWidth > scrollRegionViewports * viewport) add(`scrolls: ${held}`);
          } else if (style.textOverflow !== 'ellipsis') {
            add(`cut off: ${held}`);
          }
        }
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.right > limit && !heldByRegion(element)) {
          add(`escapes: ${name(element)} ends at ${Math.round(box.right)}px`);
        }
      }
    }
    return {
      document: document.documentElement.scrollWidth - viewport,
      outlet: outlet === null ? 0 : outlet.scrollWidth - outlet.clientWidth,
      violations,
    };
  }, SCROLL_REGION_VIEWPORTS);
}

/** What does not fit in a measurement, in words; empty when it all fits. */
function problemsOf(overflow: Overflow): string[] {
  return [
    ...(overflow.document > 0 ? [`the document scrolls ${overflow.document}px`] : []),
    ...(overflow.outlet > 0 ? [`the outlet scrolls ${overflow.outlet}px`] : []),
    ...overflow.violations,
  ];
}

/** Waits until the outlet's text and busy state have stopped changing for three reads in a row. */
async function untilQuiet(page: Page): Promise<void> {
  const outlet = page.locator('main.weft-shell-outlet');
  let previous = '';
  let streak = 0;
  await expect
    .poll(
      async () => {
        const text = await outlet.innerText();
        const busy = await outlet.locator('[aria-busy="true"]').count();
        const signature = `${busy}:${text.length}`;
        streak = signature === previous && busy === 0 ? streak + 1 : 0;
        previous = signature;
        return streak;
      },
      { intervals: [150], timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/**
 * Opens `pattern`'s address at `width` and waits until the page holds its seeded content: the
 * frame is in the state the seed gives the route, the route's marker text is there, and the outlet
 * has stopped changing.
 */
async function settle(page: Page, pattern: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto((addresses[pattern] ?? variantAddresses[pattern])!);
  const outlet = page.locator('main.weft-shell-outlet');
  await expect(outlet).toBeVisible();
  const frame = outlet.locator('[data-view]').first();
  await expect(frame).toHaveAttribute('data-state', EXPECTED_STATE[pattern] ?? 'ready');
  const marker = MARKERS[pattern];
  if (marker !== undefined) await expect(outlet).toContainText(marker);
  await reveal[pattern]?.(page);
  await untilQuiet(page);
}

/**
 * What a page needs done before it prints a seeded value: the storage page lists keys a page at a
 * time, so it searches for the long key's start and opens the key.
 */
const reveal: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  // The file's header carries its four actions; measure the page only once all four are there.
  '/workflows/:workflow (file)': async (page) => {
    const header = page.locator('[data-page="workflow-detail"] .cinder-page-header__actions');
    for (const name of [
      WORKFLOW_COPY.page.startAction,
      WORKFLOW_COPY.pauseAction,
      WORKFLOW_COPY.editAction,
      WORKFLOW_COPY.deleteAction,
    ]) {
      await expect(
        header.getByRole('button', { name }).or(header.getByRole('link', { name })),
      ).toBeVisible();
    }
  },
  // The table lists keys in order, a page at a time, and a search reads a bounded number of keys
  // before it offers Load more, so search for the long key's start, load on until it is listed, and
  // open it: the table cuts it short with an ellipsis, and the pane beside it holds the whole key.
  '/health/storage': async (page) => {
    const search = page.getByLabel(STORAGE_COPY.searchLabel);
    await search.fill('responsive-');
    await search.press('Enter');
    const key = page.locator('.ib-storage__key', { hasText: LONG_STORAGE_KEY });
    const more = page.getByRole('button', { name: STORAGE_COPY.loadMore });
    for (let pages = 0; pages < 20; pages += 1) {
      await expect(key.or(more).first()).toBeVisible();
      if ((await key.count()) > 0) break;
      await more.click();
    }
    await expect(key).toBeVisible();
    await key.click();
    await expect(page.getByTestId('storage-key-name')).toContainText(LONG_STORAGE_KEY);
  },
};

/**
 * Everything that does not fit on `pattern` at `width`: the page as opened, then each tab it offers
 * (and each tab a tab reveals), one at a time. A finding names the tab it was found on.
 */
async function problemsAt(page: Page, pattern: string, width: number): Promise<string[]> {
  await settle(page, pattern, width);
  const findings = problemsOf(await overflowOf(page));
  const outlet = page.locator('main.weft-shell-outlet');
  const visited = new Set<string>();
  for (let clicks = 0; clicks < 40; clicks += 1) {
    const tabs = await outlet.getByRole('tab').evaluateAll((elements) =>
      elements.map((element) => ({
        name: (element.textContent ?? '').trim(),
        selected: element.getAttribute('aria-selected') === 'true',
        disabled:
          element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      })),
    );
    for (const tab of tabs) if (tab.selected) visited.add(tab.name);
    const next = tabs.find((tab) => !visited.has(tab.name) && !tab.disabled);
    if (next === undefined) break;
    visited.add(next.name);
    const trigger = outlet.getByRole('tab').filter({ hasText: next.name }).first();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-selected', 'true');
    await untilQuiet(page);
    for (const problem of problemsOf(await overflowOf(page))) {
      findings.push(`[tab ${next.name}] ${problem}`);
    }
  }
  return findings;
}

/** The catalog edits the host holds now. */
async function catalogEdits(request: APIRequestContext): Promise<CatalogEdit[]> {
  const response = await request.get('/host/providers');
  return ((await response.json()) as { catalog: CatalogEdit[] }).catalog;
}

/**
 * Adds a row named `model` to the host's catalog, on Gemini, which has no allowlist, so the host
 * serves it (the end-to-end home restricts Anthropic to two models). Connecting is safe to repeat.
 */
async function addCatalogRow(request: APIRequestContext, model: string): Promise<void> {
  const connected = await request.put('/host/providers/gemini', {
    data: { apiKey: 'e2e-responsive-gemini-key' },
  });
  expect(connected.ok(), 'connecting gemini').toBe(true);
  const current = await catalogEdits(request);
  const edits = current.filter((edit) => edit.model !== model);
  const put = await request.put('/host/catalog', {
    data: { edits: [...edits, { provider: 'gemini', model, basedOn: 'gemini-2.5-pro' }] },
  });
  expect(put.status(), 'adding the long model').toBe(200);
}

/** Takes the row named `model` out of the host's catalog edits. */
async function removeCatalogRow(request: APIRequestContext, model: string): Promise<void> {
  const current = await catalogEdits(request);
  const edits = current.filter((edit) => edit.model !== model);
  await request.put('/host/catalog', { data: { edits } });
}

/**
 * Starts a refund run named `title` that waits on its approval, and returns the review's identifier.
 * The chat is titled by what the run was asked, so the review's source line links to a long title.
 */
async function reviewOfRun(
  request: APIRequestContext,
  threadId: string,
  title: string,
): Promise<string> {
  await runToEnd(request, 'tool-runner', threadId, title);
  const review = await waitingReviewOf(request, threadId);
  return review.id;
}

let addresses: Readonly<Record<string, string>>;
let variantAddresses: Readonly<Record<string, string>>;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
  try {
    await removeAgent(request, AGENT_ID);
    await createAgentFile(request, AGENT_ID, {
      name: AGENT_ID,
      description: LONG_DESCRIPTION,
    });
    await removeAgent(request, INSTRUCTIONS_AGENT_ID);
    await createAgentFile(request, INSTRUCTIONS_AGENT_ID, {
      name: INSTRUCTIONS_AGENT_ID,
      description: LONG_DESCRIPTION,
      instructions: LONG_INSTRUCTIONS,
    });
    await runToEnd(request, 'assistant', CHAT_THREAD, 'Say hello');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, MEMORY_THREAD, LONG_MEMORY);
    const waitingReview = await reviewOfRun(request, REVIEW_THREAD, LONG_REVIEW_TITLE);
    const decidedReview = await reviewOfRun(request, DECIDED_REVIEW_THREAD, LONG_REVIEW_TITLE);
    await bureauCall(request, 'bureau.reviews.resolve', {
      id: decidedReview,
      decision: 'approve',
      round: 0,
    });
    const stored = await request.put(`/v1/storage/${encodeURIComponent(LONG_STORAGE_KEY)}`, {
      headers: { 'content-type': 'application/octet-stream' },
      data: Buffer.from('a value'),
    });
    expect(stored.status(), 'storing the long key').toBeLessThan(300);
    await addCatalogRow(request, LONG_MODEL);
    const listed = await request.get('/v1/workflows?type=order-processing&limit=1');
    const runs = (await listed.json()) as { items?: { id: string }[] };
    const scheduled = await request.get('/v1/schedules');
    const schedules = (await scheduled.json()) as { items?: { id: string }[] };
    const seed: ResponsiveSeed = {
      chat: CHAT_THREAD,
      agent: AGENT_ID,
      instructionsAgent: INSTRUCTIONS_AGENT_ID,
      memoryAgent: TEXT_ECHO_AGENT_NAME,
      workflow: 'order-processing',
      workflowFile: WORKFLOW_FILE,
      run: runs.items?.[0]?.id ?? 'responsive-run',
      schedule: schedules.items?.[0]?.id ?? 'responsive-schedule',
      goal: SEEDED_GOAL_RUN_IDENTIFIER,
      review: `bureau:${waitingReview}`,
      decidedReview: `bureau:${decidedReview}`,
    };
    addresses = responsiveAddresses(seed);
    variantAddresses = responsiveVariants(seed);
  } finally {
    await request.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
  try {
    await removeAgent(request, AGENT_ID);
    await removeAgent(request, INSTRUCTIONS_AGENT_ID);
    await request.delete(`/v1/storage/${encodeURIComponent(LONG_STORAGE_KEY)}`);
    await removeCatalogRow(request, LONG_MODEL);
    const listed = await request.post('/bureau/jsonrpc', {
      data: {
        jsonrpc: '2.0',
        id: 'list',
        method: 'bureau.memory.list',
        params: { agentId: TEXT_ECHO_AGENT_NAME, limit: 100 },
      },
    });
    const body = (await listed.json()) as {
      result?: { memories: { id: string; content: string }[] };
    };
    for (const memory of body.result?.memories ?? []) {
      if (!memory.content.includes(LONG_MEMORY)) continue;
      await request.post('/bureau/jsonrpc', {
        data: {
          jsonrpc: '2.0',
          id: 'forget',
          method: 'bureau.memory.forget',
          params: { agentId: TEXT_ECHO_AGENT_NAME, id: memory.id },
        },
      });
    }
    await deleteChats([CHAT_THREAD, MEMORY_THREAD, REVIEW_THREAD, DECIDED_REVIEW_THREAD]);
  } finally {
    await request.dispose();
  }
});

test('gives every route in the table an address, and every pending route an owner and a route', () => {
  const patterns = routes.filter((route) => route.redirect === undefined).map((r) => r.pattern);
  expect(Object.keys(addresses).toSorted()).toEqual(patterns.toSorted());
  for (const entry of pending) {
    expect(patterns, entry.pattern).toContain(entry.pattern);
    expect(entry.issue, entry.pattern).toMatch(/^COR-\d+$/);
  }
  expect(new Set(pending.map((entry) => entry.pattern)).size).toBe(pending.length);
});

test.describe('the measurement', () => {
  /** Appends `html` to the outlet of a settled page at 375 pixels and measures it. */
  async function measureInjected(page: Page, html: string): Promise<string[]> {
    await settle(page, '/reviews', 375);
    await page.evaluate((markup) => {
      const holder = document.createElement('div');
      holder.innerHTML = markup;
      document.querySelector('main.weft-shell-outlet')!.append(holder);
    }, html);
    return problemsOf(await overflowOf(page));
  }

  test('passes a page that fits', async ({ page }) => {
    await settle(page, '/reviews', 375);
    expect(problemsOf(await overflowOf(page))).toEqual([]);
  });

  test('fails a box that reaches past the viewport', async ({ page }) => {
    const problems = await measureInjected(page, '<div style="width: 2000px">wide</div>');
    expect(problems.join('\n')).toContain('escapes: div');
  });

  test('passes a scrolling region that holds up to twice the viewport, and fails one that holds more', async ({
    page,
  }) => {
    const fits = await measureInjected(
      page,
      '<div style="overflow-x: auto; width: 300px"><div style="width: 700px">table</div></div>',
    );
    expect(fits).toEqual([]);
    const tooWide = await measureInjected(
      page,
      '<div style="overflow-x: auto; width: 300px"><div style="width: 2000px">table</div></div>',
    );
    expect(tooWide.join('\n')).toContain('scrolls: div holds');
  });

  test('passes a line truncated with an ellipsis, and fails content clipped without one', async ({
    page,
  }) => {
    const truncated = await measureInjected(
      page,
      '<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 200px">' +
        `${'k'.repeat(2000)}</div>`,
    );
    expect(truncated).toEqual([]);
    const clipped = await measureInjected(
      page,
      '<div style="overflow-x: clip; width: 200px"><div style="width: 2000px">cut</div></div>',
    );
    expect(clipped.join('\n')).toContain('cut off: div holds');
  });
});

for (const route of routes) {
  if (route.redirect !== undefined) continue;
  const owner = pending.find((entry) => entry.pattern === route.pattern);

  if (owner === undefined) {
    test(`${route.pattern} fits at 375, 768 and 1280 pixels, on every tab`, async ({ page }) => {
      for (const width of WIDTHS) {
        expect(
          await problemsAt(page, route.pattern, width),
          `${route.pattern} at ${width}px`,
        ).toEqual([]);
      }
    });
  } else {
    test(`${route.pattern} still overflows, which ${owner.issue} owns (remove it from pending once it fits)`, async ({
      page,
    }) => {
      const failing: number[] = [];
      for (const width of WIDTHS) {
        const problems = await problemsAt(page, route.pattern, width);
        if (problems.length > 0) failing.push(width);
      }
      expect(failing.length, `${route.pattern} fits now; remove it from pending`).toBeGreaterThan(
        0,
      );
      for (const width of owner.failsAt ?? []) {
        expect(failing, `${route.pattern} fits at ${width}px now; narrow its failsAt`).toContain(
          width,
        );
      }
    });
  }
}

// The names do not depend on the seed's values, only the addresses do.
const VARIANTS = Object.keys(responsiveVariants({ workflowFile: WORKFLOW_FILE } as ResponsiveSeed));
for (const variant of VARIANTS) {
  test(`${variant} fits at 375, 768 and 1280 pixels, on every tab`, async ({ page }) => {
    for (const width of WIDTHS) {
      expect(await problemsAt(page, variant, width), `${variant} at ${width}px`).toEqual([]);
    }
  });
}
