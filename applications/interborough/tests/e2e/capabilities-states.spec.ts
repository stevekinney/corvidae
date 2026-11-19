/**
 * The states of Capabilities and Connect tools that the sample world does not hold (COR-2435,
 * COR-2436; design rows 30n to 30p, 31m, 31n, 31u, 32k, 33g, 34k, 34l, 34q, 34y), each captured for
 * the design review under its own name at 1280 and 375 pixels. The showcase host
 * (`fixtures/sample-world-seed.ts`) holds a connected GitHub source and no skill, no disabled plugin
 * and no sign-in in flight, so each state is made by answering the host's own read with what a
 * different world would answer (`/host/tool-sources`, `/host/plugins`, `bureau.agents.catalog`,
 * `bureau.skills.*`, the sign-in routes and the edit read). Nothing is written to the host.
 */
import type { Page, Route } from '@playwright/test';

import { CAPABILITIES_COPY } from '../../src/app/copy/capabilities.ts';
import {
  BLOCKED_AGENT_LIST,
  DELETE_BRANCH_TOOL,
  DEMO_PLUGIN,
  githubNotLoaded,
  githubWithAddress,
  LEDGER_EDITING,
  LEDGER_PROBE,
  paymentsSource,
  RELEASE_NOTES_DESCRIPTION,
  RELEASE_NOTES_INSTRUCTIONS,
  RELEASE_NOTES_SKILLS,
  SIGN_IN_START,
  SKILL_AGENT_DETAIL,
  SKILL_AGENTS,
  USED_BY_DEFINITIONS,
  USED_BY_TOOL_FIELDS,
} from './capabilities-states-stubs.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL });

const SOURCE = 'capabilities-states.spec.ts';
const WIDTHS = [1280, 375] as const;
const copy = CAPABILITIES_COPY;
const signInCopy = copy.source.connect.authentication.signIn;

type Json = Record<string, unknown>;

/** Answers a read of `glob` with what `change` makes of the host's own answer; other methods go through. */
async function amendRead(page: Page, glob: string, change: (body: Json) => Json): Promise<void> {
  await page.route(glob, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response, json: change((await response.json()) as Json) });
  });
}

/** Answers the Bureau operation `method` with `change` of the host's own answer; other operations go through. */
async function amendOperation(
  page: Page,
  method: string,
  change: (result: Json) => Json,
): Promise<void> {
  // The page's generated client posts every Bureau call to the host's composed `/jsonrpc`.
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: Json };
    await route.fulfill({
      response,
      json: { ...answer, result: change(answer.result ?? {}) },
    });
  });
}

/** Answers the Bureau operation `method` with `result`, never reaching the host. */
async function answerOperation(page: Page, method: string, result: Json): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
    };
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
  });
}

/** The GitHub source as a world where it is not loaded would list it: its tools are only remembered. */
async function githubIs(
  page: Page,
  state: 'failed' | 'needs-authorization',
  message?: string,
): Promise<void> {
  await amendRead(page, '**/host/tool-sources', (body) => ({
    ...body,
    sources: (body['sources'] as Json[]).map((source) =>
      source['id'] === 'github' ? githubNotLoaded(source, state, message) : source,
    ),
  }));
  // A source that is not loaded offers its tools to no agent: the catalog no longer holds them.
  await amendOperation(page, 'bureau.agents.catalog', (result) => ({
    ...result,
    tools: (result['tools'] as { name: string }[]).filter(
      (tool) => !tool.name.startsWith('github__'),
    ),
  }));
}

async function open(page: Page, width: number, path: string): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
}

/** The Sources tab as a world with these sources would list it (the sample world's own are `base`). */
async function sourcesAre(page: Page, change: (sources: Json[]) => Json[]): Promise<void> {
  await amendRead(page, '**/host/tool-sources', (body) => ({
    ...body,
    sources: change(body['sources'] as Json[]),
  }));
}

for (const width of WIDTHS) {
  // The sample world's own pages, under state names `responsive.spec.ts` (which captures the same
  // routes with stress data under the same file names) never writes.
  test(`the sample world's tools, sources and connect form, at ${width} pixels`, async ({
    page,
  }) => {
    for (const [path, state, settled] of [
      ['/capabilities', 'sample world tools', '[data-tool-row]'],
      ['/capabilities?tab=sources', 'sample world sources', '[data-source-row]'],
      ['/capabilities/connect', 'sample world connect form', '#connect-url'],
    ] as const) {
      await open(page, width, path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // Settled: the list has its rows (not a skeleton) before the page is captured.
      await expect(page.locator(settled).first()).toBeVisible();
      await captureForDesignReview(page, {
        route: path.split('?')[0] ?? path,
        state,
        source: SOURCE,
      });
    }
  });

  test.describe(`/capabilities lost tools and skills, at ${width} pixels`, () => {
    test('a failed source keeps its last listing: the tool, its warning, Reconnect and the kept asks level (30n, 30o)', async ({
      page,
    }) => {
      await githubIs(page, 'failed', 'The source could not be reached.');
      // The count rule is read on the list: on a phone an open tool takes the pane the list is in.
      await open(page, width, '/capabilities');
      await expect(page.locator('[data-tool-row][data-lost]')).toHaveCount(2);
      await page.goto('/capabilities?tool=github__create_issue');
      const detail = page.getByTestId('tool-detail');
      await expect(detail.getByTestId('tool-approval')).toContainText('Asks: On changes');
      await expect(detail.getByTestId('tool-lost-text')).toHaveText(
        'GitHub is disconnected. Agents can’t use this tool until it is reconnected.',
      );
      await expect(detail.getByTestId('tool-lost-reconnect')).toHaveText('Reconnect');
      await expect(detail.getByTestId('capability-users-empty')).toContainText(
        copy.tool.lost.noUsers,
      );
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'lost tool, failed source',
        source: SOURCE,
      });
    });

    test('a failed source’s page keeps its tools, paused, under the table (31u)', async ({
      page,
    }) => {
      await githubIs(page, 'failed', 'The source could not be reached.');
      await open(page, width, '/capabilities?tab=sources&source=github');
      await expect(page.getByTestId('source-detail')).toContainText(copy.source.tools.pausedFailed);
      await expect(page.getByTestId('source-tool-table')).toHaveAttribute('data-paused', '');
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'failed source, tools paused',
        source: SOURCE,
      });
    });

    test('a source waiting for sign-in keeps its tools, paused, with the line under the table (31u)', async ({
      page,
    }) => {
      await githubIs(page, 'needs-authorization');
      await open(page, width, '/capabilities?tab=sources&source=github');
      await expect(page.getByTestId('source-detail')).toContainText(copy.source.tools.paused);
      // Settled: the table is drawn, paused, and the sentence the listing makes false is not there.
      await expect(page.getByTestId('source-tool-table')).toHaveAttribute('data-paused', '');
      await expect(page.getByTestId('source-state-description')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'source waiting for sign-in',
        source: SOURCE,
      });
    });

    test('a disabled plugin’s tool says so, and Enable and restart asks first (30p)', async ({
      page,
    }) => {
      await amendRead(page, '**/host/plugins', (body) => ({
        ...body,
        plugins: [...(body['plugins'] as Json[]), DEMO_PLUGIN],
      }));
      await open(page, width, '/capabilities?tool=demo__draft-release-notes');
      const detail = page.getByTestId('tool-detail');
      await expect(detail.getByTestId('tool-lost-text')).toHaveText(
        'The Demo plugin is disabled. Enabling it restarts the server.',
      );
      await expect(detail.getByTestId('tool-source')).toContainText('From the Demo plugin');
      await expect(detail.getByTestId('tool-lost-enable')).toHaveText('Enable and restart');
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'lost tool, disabled plugin',
        source: SOURCE,
      });
      await detail.getByTestId('tool-lost-enable').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'lost tool, enable and restart question',
        source: SOURCE,
      });
    });

    test('a skill’s detail shows the instructions rendered first and the raw file last, with the skill’s description in Used by (31m, 31n)', async ({
      page,
    }) => {
      await answerOperation(page, 'bureau.skills.list', RELEASE_NOTES_SKILLS);
      await answerOperation(page, 'bureau.skills.get', RELEASE_NOTES_INSTRUCTIONS);
      // Workflow author names the skill, so Used by lists it with the skill's own description (31m).
      await answerOperation(page, 'bureau.agents.list', SKILL_AGENTS);
      await answerOperation(page, 'bureau.agents.definitions.get', SKILL_AGENT_DETAIL);
      await open(page, width, '/capabilities?tab=skills&skill=built-in%2Frelease-notes');
      const instructions = page.getByTestId('skill-instructions');
      await expect(instructions.getByTestId('skill-instructions-title')).toContainText(
        'Instructions',
      );
      await expect(instructions).toContainText(
        'Group the merged pull requests by what changed for a customer.',
      );
      await expect(instructions.getByTestId('skill-instructions-raw')).toBeVisible();
      // Used by: Workflow author, with the skill's own description beside it (31m).
      const users = page.getByTestId('skill-detail').getByTestId('capability-users');
      await expect(users).toContainText('Workflow author');
      await expect(users).not.toContainText('workflow-author');
      await expect(users).toContainText(`Loads it when relevant: ${RELEASE_NOTES_DESCRIPTION}`);
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'skill detail with instructions',
        source: SOURCE,
      });
    });

    test('a tool used by four agents says each one’s asks level, and the blocked one (30c, 30d, 31j, 31w, 31x)', async ({
      page,
    }) => {
      await amendOperation(page, 'bureau.agents.catalog', (result) => ({
        ...result,
        tools: (result['tools'] as { name: string }[]).map((tool) =>
          tool.name === 'github__create_issue' ? { ...tool, ...USED_BY_TOOL_FIELDS } : tool,
        ),
      }));
      await answerOperation(page, 'bureau.agents.definitions.list', USED_BY_DEFINITIONS);
      await open(page, width, '/capabilities?tool=github__create_issue');
      const users = page.getByTestId('tool-detail').getByTestId('capability-users');
      await expect(users).toBeVisible();
      await expect(users).toContainText(/Asks: [A-Za-z ]+ \(default\)/);
      await expect(users).toContainText('Asks: Always');
      await expect(users).toContainText(copy.tool.userAsks.inCode);
      await expect(users).toContainText(copy.tool.userAsks.blocked);
      // Of four agents only the blocked one has the note, and it names that agent.
      await expect(page.getByTestId('tool-blocked-note')).toHaveCount(1);
      await expect(page.getByTestId('tool-blocked-note')).toHaveText(
        copy.tool.blockedNote('Former intern'),
      );
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'tool used by four agents',
        source: SOURCE,
      });
    });

    test('the blocked, dangerous tool: Delete branch with its required Branch input and its open JSON schema (31w, 31x)', async ({
      page,
    }) => {
      await amendOperation(page, 'bureau.agents.catalog', (result) => ({
        ...result,
        tools: [
          ...(result['tools'] as { name: string }[]).filter(
            (tool) => tool.name !== DELETE_BRANCH_TOOL.name,
          ),
          DELETE_BRANCH_TOOL,
        ],
      }));
      await answerOperation(page, 'bureau.agents.list', BLOCKED_AGENT_LIST);
      await open(page, width, `/capabilities?tool=${DELETE_BRANCH_TOOL.name}`);
      const detail = page.getByTestId('tool-detail');
      await expect(detail.getByTestId('tool-risk')).toContainText('Dangerous');
      const users = detail.getByTestId('capability-users');
      await expect(users).toContainText('An agent allowed Delete branch');
      await expect(users).toContainText(copy.tool.userAsks.blocked);
      await expect(detail.getByTestId('tool-input-schema')).toContainText('Branch');
      await expect(detail.getByTestId('tool-input-schema')).toContainText('The branch to delete.');
      // The schema is open, never a disclosure to expand (owner report, 2026-11-19).
      await expect(
        detail.getByTestId('tool-input-schema').locator('.cinder-schema-view__source code'),
      ).toContainText('"branch"');
      await expect(page.getByTestId('tool-blocked-note')).toHaveText(
        copy.tool.blockedNote('An agent allowed Delete branch'),
      );
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'blocked dangerous tool',
        source: SOURCE,
      });
    });

    test('/agents/:agent/access states the same asks vocabulary (30d)', async ({ page }) => {
      await open(page, width, '/agents/workflow-author/access');
      await expect(page.locator('[data-tool]').first()).toBeVisible();
      await captureForDesignReview(page, {
        route: '/agents/:agent/access',
        state: 'agent access tab, asks levels',
        source: SOURCE,
      });
    });
  });

  test.describe(`/capabilities sources, at ${width} pixels`, () => {
    test('the GitHub source with its address and sentence, and a secondary Test connection (31o)', async ({
      page,
    }) => {
      await sourcesAre(page, (sources) =>
        sources.map((source) => (source['id'] === 'github' ? githubWithAddress(source) : source)),
      );
      await open(page, width, '/capabilities?tab=sources&source=github');
      const detail = page.getByTestId('source-detail');
      await expect(detail).toContainText('https://mcp.github.example/mcp');
      await expect(detail).toContainText(
        'An MCP server for issues and files in your repositories.',
      );
      await expect(page.getByTestId('source-tool-table')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'source detail with address',
        source: SOURCE,
      });
    });

    test('first use is the only primary Connect tools, and it opens Connect tools (32a)', async ({
      page,
    }) => {
      await sourcesAre(page, () => []);
      await open(page, width, '/capabilities?tab=sources');
      await expect(
        page.getByRole('heading', { level: 2, name: copy.source.empty.title }),
      ).toBeVisible();
      await expect(page.locator('main [data-cinder-variant="primary"]')).toHaveCount(1);
      await expect(page.locator('main [data-cinder-variant="primary"]')).toHaveText(
        copy.source.connect.action,
      );
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'sources first use',
        source: SOURCE,
      });
      await page.locator('main [data-cinder-variant="primary"]').click();
      await expect(page).toHaveURL(/\/capabilities\/connect$/);
    });

    test('an OpenAPI source shows its spec address, an API key line and the menu (32k)', async ({
      page,
    }) => {
      await sourcesAre(page, (sources) => [
        ...sources,
        paymentsSource(new Date(Date.now() - 60 * 60 * 1000).toISOString()),
      ]);
      await open(page, width, '/capabilities?tab=sources&source=payments');
      const detail = page.getByTestId('source-detail');
      await expect(detail).toContainText('https://api.example.com/openapi.json');
      await expect(page.getByTestId('source-status')).toContainText(
        /API key.*last tested.*OpenAPI spec/,
      );
      await expect(page.getByTestId('source-tool-table')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'openapi source',
        source: SOURCE,
      });
    });

    test('the more menu lists Edit connection, Test connection and Remove source in that order (32m)', async ({
      page,
    }) => {
      await open(page, width, '/capabilities?tab=sources&source=github');
      await expect(page.getByTestId('source-detail')).toBeVisible();
      await page.getByRole('button', { name: copy.source.menu.label }).click();
      const items = page.getByRole('menuitem');
      await expect(items).toHaveText([
        copy.source.menu.edit,
        copy.source.menu.test,
        copy.source.menu.remove,
      ]);
      await captureForDesignReview(page, {
        route: '/capabilities',
        state: 'source menu open',
        source: SOURCE,
      });
    });
  });
}

/** Routes the edit read of the source `ledger`, which the showcase host does not hold. */
async function ledgerIsEditable(page: Page): Promise<void> {
  await page.route('**/host/tool-sources/ledger/editing', (route) =>
    route.fulfill({ json: LEDGER_EDITING }),
  );
  await page.route('**/host/tool-sources/ledger/probe', (route) =>
    route.fulfill({ json: LEDGER_PROBE }),
  );
}

for (const width of WIDTHS) {
  test.describe(`/capabilities/connect Edit connection, at ${width} pixels`, () => {
    test('opens Connect tools on the saved source with the breadcrumb Capabilities › Edit connection (32m)', async ({
      page,
    }) => {
      await ledgerIsEditable(page);
      await open(page, width, '/capabilities/connect?source=ledger');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        copy.source.connect.edit.title,
      );
      await expect(page.locator('#connect-url')).toHaveValue('https://mcp.ledger.example/mcp');
      await expect(page.locator('#connect-secret')).toHaveValue('');
      await captureForDesignReview(page, {
        route: '/capabilities/connect',
        state: 'edit mode',
        source: SOURCE,
      });
    });

    test('a save refused because the source changed says so in plain words and offers the reload', async ({
      page,
      pageErrors,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(409, /\/host\/tool-sources\/ledger/),
        reason: 'the test answers the save with a 409, which Chromium logs',
      });
      await ledgerIsEditable(page);
      await page.route('**/host/tool-sources/ledger', (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({
              status: 409,
              json: {
                error: 'failed',
                reason: 'conflict',
                message: 'The secret provider could not complete the operation.',
              },
            })
          : route.fallback(),
      );
      await open(page, width, '/capabilities/connect?source=ledger');
      await page.locator('#connect-name').fill('Ledger, renamed');
      await page.getByRole('button', { name: copy.source.connect.edit.save }).click();
      await expect(page.getByTestId('connect-edit-stale')).toContainText(
        copy.source.connect.edit.stale,
      );
      await expect(
        page.getByRole('button', { name: copy.source.connect.edit.reload }),
      ).toBeVisible();
      await captureForDesignReview(page, {
        route: '/capabilities/connect',
        state: 'edit refused, the source changed',
        source: SOURCE,
      });
    });
  });
}

/** What the sign-in routes answer: starting one, and then how it ended. */
async function signInGoes(
  page: Page,
  standing: { readonly outcome: string; readonly reason?: string },
): Promise<void> {
  await page.route('**/host/tool-source-sign-ins', (route: Route) =>
    route.fulfill({ json: SIGN_IN_START }),
  );
  await page.route('**/host/tool-source-sign-ins/sign-in-1', (route: Route) =>
    route.fulfill({ json: { signIn: 'sign-in-1', ...standing } }),
  );
}

/** Opens Connect tools with an OAuth MCP server named GitHub filled in, ready to sign in. */
async function openOAuthForm(page: Page, width: number): Promise<void> {
  // A world with no GitHub source saved, so the address typed below is not a duplicate of one and
  // rows 33f and 33g are captured without a duplicate-name error.
  await sourcesAre(page, (sources) => sources.filter((source) => source['id'] !== 'github'));
  await open(page, width, '/capabilities/connect');
  await page.locator('#connect-name').fill('GitHub');
  await page.locator('#connect-url').fill('https://mcp.github.example/mcp');
  await page.locator('#connect-authentication [data-cinder-segment-value="oauth"]').click();
}

const signInStart = (page: Page) => page.getByTestId('connect-sign-in-start');
const signInState = (page: Page) => page.getByTestId('connect-sign-in');

for (const width of WIDTHS) {
  test.describe(`/capabilities/connect Sign in on Connect tools, at ${width} pixels`, () => {
    test('is a segmented control with OAuth’s note, and idle offers Sign in to GitHub with a key icon (33g)', async ({
      page,
    }) => {
      await openOAuthForm(page, width);
      const segments = page.locator('#connect-authentication [data-cinder-segment-value]');
      await expect(segments).toHaveCount(3);
      await expect(segments.first()).toContainText(copy.source.connect.authentication.oauthNote);
      await expect(signInStart(page)).toHaveText(signInCopy.action('GitHub'));
      await expect(signInState(page)).toHaveAttribute('data-state', 'idle');
      await captureForDesignReview(page, {
        route: '/capabilities/connect',
        state: 'sign in idle',
        source: SOURCE,
      });
    });

    test('Bearer token asks for a masked Token with its help (34q)', async ({ page }) => {
      await sourcesAre(page, (sources) => sources.filter((source) => source['id'] !== 'github'));
      await open(page, width, '/capabilities/connect');
      await page.locator('#connect-name').fill('GitHub');
      await page.locator('#connect-url').fill('https://mcp.github.example/mcp');
      await page.locator('#connect-authentication [data-cinder-segment-value="bearer"]').click();
      await expect(page.locator('#connect-secret')).toHaveAttribute('type', 'password');
      await captureForDesignReview(page, {
        route: '/capabilities/connect',
        state: 'sign in bearer token',
        source: SOURCE,
      });
    });

    test('waiting reads Waiting for GitHub… with Cancel and the line under it (34y)', async ({
      page,
    }) => {
      await signInGoes(page, { outcome: 'waiting' });
      await openOAuthForm(page, width);
      const popup = page.waitForEvent('popup');
      await signInStart(page).click();
      await popup;
      await expect(signInState(page)).toHaveAttribute('data-state', 'waiting');
      await expect(page.getByTestId('connect-sign-in-waiting')).toHaveText(
        signInCopy.waiting('GitHub'),
      );
      await expect(page.getByText(signInCopy.approve('GitHub'))).toBeVisible();
      await captureForDesignReview(page, {
        route: '/capabilities/connect',
        state: 'sign in waiting',
        source: SOURCE,
      });
    });

    const ENDINGS = [
      {
        state: 'sign in canceled',
        standing: { outcome: 'canceled' },
        shows: signInCopy.canceled('GitHub'),
        row: '34k',
      },
      {
        state: 'sign in declined',
        standing: { outcome: 'canceled', reason: 'denied' },
        shows: signInCopy.declined('GitHub'),
        row: '34k',
      },
      {
        state: 'sign in refused',
        standing: { outcome: 'refused', reason: 'invalid_request' },
        shows: signInCopy.refused('GitHub', signInCopy.reasons['invalid_request'] ?? ''),
        row: '34l',
      },
      {
        state: 'signed in',
        standing: { outcome: 'succeeded' },
        shows: signInCopy.signedIn,
        row: '33g',
      },
    ] as const;
    for (const ending of ENDINGS) {
      test(`${ending.state}: the provider’s window closes and the page says so (${ending.row})`, async ({
        page,
      }) => {
        await signInGoes(page, ending.standing);
        await openOAuthForm(page, width);
        const popupOpened = page.waitForEvent('popup');
        await signInStart(page).click();
        const popup = await popupOpened;
        await popup.close();
        await expect(page.getByText(ending.shows)).toBeVisible();
        await captureForDesignReview(page, {
          route: '/capabilities/connect',
          state: ending.state,
          source: SOURCE,
        });
      });
    }

    test('a blocked window says to allow pop-ups, with Try again', async ({ page }) => {
      await page.addInitScript(() => {
        window.open = () => null;
      });
      await signInGoes(page, { outcome: 'waiting' });
      await openOAuthForm(page, width);
      await signInStart(page).click();
      await expect(signInState(page)).toHaveAttribute('data-state', 'blocked');
      await expect(page.getByText(signInCopy.blocked)).toBeVisible();
      await captureForDesignReview(page, {
        route: '/capabilities/connect',
        state: 'sign in blocked',
        source: SOURCE,
      });
    });
  });
}

/**
 * The owner's report of 2026-11-19, on the sample world's own built-in Read asset: one field, no
 * agent. Read first at the widths the review leads with, 1920 and 1280, then 768 and 375.
 */
for (const width of [1920, 1280, 768, 375] as const) {
  test(`a tool's page reads what it does, who can use it, then its fields beside the open schema, at ${width} pixels`, async ({
    page,
  }) => {
    await open(page, width, '/capabilities');
    const row = page.locator('[data-tool-row]', {
      has: page.getByTestId('tool-row-name').getByText('Read asset', { exact: true }),
    });
    const name = await row.getAttribute('data-tool-row');
    expect(name).not.toBeNull();
    await page.goto(`/capabilities?tool=${encodeURIComponent(name ?? '')}`);
    const detail = page.getByTestId('tool-detail');

    // 1: the name and its one sentence, then Add to an agent as a button at the header's end.
    await expect(detail.getByRole('heading', { level: 3 })).toHaveText('Read asset');
    await expect(detail.getByTestId('tool-summary')).toHaveText('Read a managed asset.');
    await expect(detail.locator('header').getByTestId('tool-add-to-agent')).toHaveText(
      copy.tool.addToAgent.label,
    );
    // 3: no raw identifier by the name; Copy tool ID holds it.
    await expect(detail.locator('header')).not.toContainText(name ?? '');
    await expect(
      detail.getByRole('button', { name: copy.tool.copyIdentifier.label }),
    ).toBeVisible();
    // 4: one set of badges, the same words as the list row, with one height and one top.
    await expect(detail.getByTestId('tool-risk')).toHaveText('Reads');
    await expect(detail.getByTestId('tool-approval')).toHaveText('Asks: Never');
    await expect(detail.getByTestId('tool-source')).toHaveText('Built in');
    const boxes = await Promise.all(
      ['tool-risk', 'tool-approval', 'tool-source'].map(
        async (testId) => (await detail.getByTestId(testId).boundingBox()) ?? undefined,
      ),
    );
    const [first, ...rest] = boxes;
    expect(first).toBeDefined();
    for (const box of rest) {
      expect(box).toBeDefined();
      expect(Math.abs((box?.y ?? 0) - (first?.y ?? 0))).toBeLessThanOrEqual(0.5);
      expect(Math.abs((box?.height ?? 0) - (first?.height ?? 0))).toBeLessThanOrEqual(0.5);
    }
    // 5: one line for nobody, with no link in it.
    const empty = detail.getByTestId('capability-users-empty');
    await expect(empty).toHaveText(copy.tool.noUsers.line);
    await expect(empty.locator('a')).toHaveCount(0);
    // 6: the field is a row with its name, Required, its type in words and its rule; no table.
    const inputs = detail.getByTestId('tool-input-schema');
    await expect(inputs.getByRole('table')).toHaveCount(0);
    const field = inputs.locator('.cinder-schema-view__item').first();
    await expect(field).toContainText('Asset ID');
    await expect(field).toContainText('Required');
    await expect(field).toContainText('text');
    await expect(field).toContainText('At least 1 character');
    // The field's name starts where the Inputs heading starts.
    const headingBox = await detail.getByRole('heading', { name: copy.tool.inputs }).boundingBox();
    const labelBox = await field.locator('.cinder-schema-view__label').boundingBox();
    expect(Math.abs((labelBox?.x ?? 0) - (headingBox?.x ?? 0))).toBeLessThanOrEqual(1);
    // 2: the schema is open; beside the fields from 1280, under them at 768 and below.
    const source = inputs.locator('.cinder-schema-view__source');
    await expect(source.locator('code')).toContainText('"assetId"');
    const fieldsBox = await inputs.locator('.cinder-schema-view__fields').boundingBox();
    const sourceBox = await source.boundingBox();
    expect(fieldsBox).not.toBeNull();
    expect(sourceBox).not.toBeNull();
    if (fieldsBox !== null && sourceBox !== null) {
      if (width >= 1280) {
        expect(sourceBox.x).toBeGreaterThanOrEqual(fieldsBox.x + fieldsBox.width - 1);
        expect(Math.abs(sourceBox.y - fieldsBox.y)).toBeLessThanOrEqual(1);
      } else {
        expect(sourceBox.y).toBeGreaterThanOrEqual(fieldsBox.y + fieldsBox.height - 1);
      }
    }
    await captureForDesignReview(page, {
      route: '/capabilities',
      state: 'tool page, one field and no agent',
      source: SOURCE,
    });
  });
}
