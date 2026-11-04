/**
 * The shell's search palette and its keys on the sample world (`fixtures/sample-world-seed.ts`, the
 * showcase host; COR-2015, design rows 03c, 03g, 03e, 03f): what ⌘K lists with nothing typed, what a
 * search for "refund" groups and how each row reads, that ⌘K opens the palette from inside the
 * composer and ⌘⇧K does not, and that "Use single-key shortcuts" in Settings turns the G sequences
 * and C off. Each captioned state is captured for the design review under its own name.
 */
import type { Locator, Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { PALETTE_COPY, SETTINGS_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'shell-search.spec.ts';

const palette = (page: Page) => page.getByRole('dialog', { name: PALETTE_COPY.label });
const search = (page: Page) => palette(page).getByRole('combobox');
const groupsOf = (page: Page) =>
  palette(page)
    .getByRole('group')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));

/** A row's title and its meta, the two parts the design draws on one line. */
async function rowText(row: Locator): Promise<[string, string]> {
  return row.evaluate((element): [string, string] => {
    const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    return [
      clean(element.querySelector('.cinder-command-item__text')?.textContent),
      clean(element.querySelector('.cinder-command-item__meta')?.textContent),
    ];
  });
}

/**
 * The sample world's tool catalog lists Bureau's, GitHub's and the settings tools, but not the three
 * tools Tool runner's own toolbox holds (`src/host/showcase-agents.ts`), which the Capabilities
 * pages (B12) put in it. Until then the catalog answer carries Issue refund, so the palette's tool
 * row is read as the design draws it ("Issue refund · issue-refund · tool · Tool runner").
 */
async function listIssueRefundInCatalog(page: Page): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const call = route.request().postDataJSON() as { method?: string } | null;
    if (call?.method !== 'bureau.agents.catalog') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as {
      result: { tools: Record<string, unknown>[] };
    };
    body.result.tools = body.result.tools.filter((tool) => tool['name'] !== 'issue-refund');
    body.result.tools.push({
      name: 'issue-refund',
      title: 'Issue refund',
      description: 'Refund an order to the original card. A person approves every refund.',
      shortDescription: 'Refunds an order',
      inputSchema: null,
      tier: 'mutating',
      defaultApproval: 'ask',
      source: 'host',
      plugin: null,
      skill: null,
      users: ['tool-runner'],
    });
    return route.fulfill({ response, json: body });
  });
}

/** Opens `path` at desktop width and waits until the shell has the counts the sample world gives it. */
async function open(page: Page, path: string): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
  await expect(page.getByRole('link', { name: 'Reviews, 2 need you' })).toBeAttached();
}

/** Opens the palette with its key, once the shell has registered it. */
async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
}

test.describe('the search palette on the sample world', () => {
  test('with nothing typed it lists what waits on you, then Go to rows and New chat (03c)', async ({
    page,
    checkA11y,
  }) => {
    await open(page, '/');
    await openPalette(page);

    await expect(search(page)).toHaveAttribute('placeholder', 'Search everything');
    await expect(palette(page).getByText('esc', { exact: true })).toBeVisible();

    // Waiting on you leads, newest first, and the first row is highlighted with its amber glyph.
    const headings = await groupsOf(page);
    expect(headings[0]).toBe('Waiting on you');
    const rows = palette(page).getByRole('option');
    const refund = rows.nth(0);
    await expect(refund).toHaveAttribute('aria-selected', 'true');
    expect(await rowText(refund)).toEqual(['Refund order 4471 for $42.00?', 'Approval · waiting']);
    await expect(refund.locator('.cinder-command-item__leading')).toHaveAttribute(
      'data-cinder-tone',
      'warning',
    );
    expect(await rowText(rows.nth(1))).toEqual([
      'Which environment should the release go to?',
      'Question',
    ]);

    // Then the navigation rows with their keys read "G then H", and New chat shows the one key C.
    const home = palette(page).getByRole('option', { name: 'Go to Home' });
    await expect(home.locator('kbd')).toHaveText(['G', 'H']);
    await expect(home).toContainText('then');
    await expect(
      palette(page).getByRole('option', { name: 'Go to Reviews', exact: true }).locator('kbd'),
    ).toHaveText(['G', 'R']);
    await expect(
      palette(page).getByRole('option', { name: 'New chat', exact: true }).locator('kbd'),
    ).toHaveText(['C']);
    const labels = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')),
    );
    expect(labels.indexOf('Go to Home')).toBe(2);
    expect(labels.indexOf('New chat')).toBeGreaterThan(labels.indexOf('Go to Settings'));
    // Those rows run on under no heading of their own.
    await expect(palette(page).getByText(PALETTE_COPY.groups.actions, { exact: true })).toHaveCount(
      0,
    );

    // The footer names the two prefixes and the key that opens a row.
    await expect(palette(page).locator('.cinder-command-palette__footer')).toHaveText(
      /^\s*>\s*actions\s*@\s*agents\s*Enter to open\s*$/,
    );
    await captureForDesignReview(page, {
      route: '/',
      state: 'search empty query',
      source: SOURCE,
    });
    await checkA11y('the search palette with nothing typed');
  });

  test('a search for "refund" groups waiting, chats, runs, agents and tools, then actions (03g)', async ({
    page,
    checkA11y,
  }) => {
    await listIssueRefundInCatalog(page);
    await open(page, '/');
    await openPalette(page);
    await search(page).fill('refund');
    // The search settles after the typing does; the last group to arrive is the tools.
    await expect(
      palette(page).getByRole('group', { name: 'Agents and tools', exact: true }),
    ).toBeVisible();

    // The five groups of the design, in its order; other kinds (a workflow, a schedule) sit between.
    const groups = await groupsOf(page);
    const named = groups.filter((group) =>
      ['Waiting on you', 'Chats', 'Runs', 'Agents and tools', 'Actions'].includes(group ?? ''),
    );
    expect(named).toEqual(['Waiting on you', 'Chats', 'Runs', 'Agents and tools', 'Actions']);

    const group = (name: string) => palette(page).getByRole('group', { name, exact: true });
    const first = group('Waiting on you').getByRole('option').first();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    expect(await rowText(first)).toEqual(['Refund order 4471 for $42.00?', 'Approval · waiting']);

    const chat = group('Chats').getByRole('option', { name: /^Please refund order 4471/ });
    expect(await rowText(chat)).toEqual([
      'Please refund order 4471, it arrived damaged.',
      'Tool runner',
    ]);

    const run = group('Runs').getByRole('option', {
      name: /^Refund order 4471, Tool runner, waiting for approval$/,
    });
    expect(await rowText(run)).toEqual(['Refund order 4471', 'Tool runner · waiting for approval']);

    // A tool: its name for a person, then its identifier small and monospaced, "tool", and who uses it.
    const tool = group('Agents and tools').getByRole('option', { name: /^Issue refund,/ });
    expect(await rowText(tool)).toEqual(['Issue refund', 'issue-refund · tool · Tool runner']);
    const identifier = tool.locator('.cinder-command-item__meta code.ib-identifier');
    await expect(identifier).toHaveText('issue-refund');
    const [codeFont, metaFont] = await Promise.all([
      identifier.evaluate((element) => getComputedStyle(element).fontFamily),
      tool
        .locator('.cinder-command-item__label')
        .evaluate((element) => getComputedStyle(element).fontFamily),
    ]);
    expect(codeFont).not.toBe(metaFont);

    await expect(
      group('Actions').getByRole('option', { name: 'New chat about refund' }),
    ).toBeVisible();
    await captureForDesignReview(page, {
      route: '/',
      state: 'search refund',
      source: SOURCE,
    });
    // The list scrolls inside the palette, so the groups below the fold are captured as well.
    await palette(page)
      .getByRole('listbox')
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    await expect(group('Actions')).toBeInViewport();
    await captureForDesignReview(page, {
      route: '/',
      state: 'search refund end of list',
      source: SOURCE,
    });
    await checkA11y('the search palette for refund');
  });

  test('"New chat about" opens a new chat with the topic in the composer, unsent (03g)', async ({
    page,
  }) => {
    await open(page, '/');
    await openPalette(page);
    await search(page).fill('refund');
    await palette(page).getByRole('option', { name: 'New chat about refund' }).click();

    await expect(page).toHaveURL(/\/chats\/new\?about=refund$/);
    await expect(page.locator('textarea').first()).toHaveValue('refund');
  });

  test('a phone gets the same rows as a bottom sheet with no esc hint (05d)', async ({ page }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();
    await page
      .getByRole('banner')
      .getByRole('button', { name: /^Search everything/ })
      .click();
    await expect(palette(page)).toBeVisible();
    await expect(palette(page).locator('.cinder-command-palette__escape')).toHaveCount(0);
    const rows = palette(page).getByRole('option');
    expect(await rowText(rows.nth(0))).toEqual([
      'Refund order 4471 for $42.00?',
      'Approval · waiting',
    ]);
    const height = await rows.first().evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureForDesignReview(page, {
      route: '/',
      state: 'search empty query',
      source: SOURCE,
    });
  });
});

test.describe('the keys', () => {
  test('⌘K opens the palette with the composer focused, and the link shortcut is ⌘⇧K (03e)', async ({
    page,
  }) => {
    await open(page, '/chats/new');
    const composer = page.locator('textarea').first();
    await composer.click();
    await composer.fill('a draft that stays');
    await expect(composer).toBeFocused();

    // ⌘⇧K is the composer's own link shortcut: it drops a link into the draft and opens nothing.
    await page.keyboard.press('Control+Shift+K');
    await expect(composer).toHaveValue('a draft that stays[](url)');
    await expect(palette(page)).toHaveCount(0);
    await expect(composer).toBeFocused();

    // ⌘K opens the palette from the same field and leaves the draft as it was.
    await composer.fill('a draft that stays');
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    await expect(composer).toHaveValue('a draft that stays');
  });

  test('the G sequences and C can be turned off in Settings, and ignore a field (03f)', async ({
    page,
  }) => {
    await open(page, '/settings');
    const toggle = page.getByRole('switch', { name: SETTINGS_COPY.keyboard.singleKeyLabel });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // On: G then R goes to Reviews.
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/\/reviews$/);

    // Off: G then R and C do nothing, but ⌘K and ? still answer.
    await page.goto('/settings');
    await page.getByRole('switch', { name: SETTINGS_COPY.keyboard.singleKeyLabel }).click();
    await page.getByRole('switch', { name: SETTINGS_COPY.keyboard.singleKeyLabel }).blur();
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await page.keyboard.press('c');
    await expect(page).toHaveURL(/\/settings$/);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await openPalette(page);
    // The palette stops printing keys that do nothing, and the rows still go where they say.
    await expect(
      palette(page).getByRole('option', { name: 'Go to Reviews', exact: true }).locator('kbd'),
    ).toHaveCount(0);
    await palette(page).getByRole('option', { name: 'Go to Reviews', exact: true }).click();
    await expect(page).toHaveURL(/\/reviews$/);

    // The choice survives a reload; back on, a key typed into a field still does nothing.
    await page.goto('/settings');
    const back = page.getByRole('switch', { name: SETTINGS_COPY.keyboard.singleKeyLabel });
    await expect(back).toHaveAttribute('aria-checked', 'false');
    await back.click();
    await expect(back).toHaveAttribute('aria-checked', 'true');
    await page.goto('/chats/new');
    const composer = page.locator('textarea').first();
    await composer.click();
    await page.keyboard.type('gr');
    await expect(page).toHaveURL(/\/chats\/new$/);
    await expect(composer).toHaveValue('gr');
  });
});
