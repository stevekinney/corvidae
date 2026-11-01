/**
 * Capabilities › Sources against the real host (COR-1845): the saved tool sources the host starts
 * with (`tool-sources-seed.ts`), an MCP server and an OpenAPI service that load, one behind OAuth
 * that waits for a sign-in and one that fails. Their tools are in the Tools tab beside every other,
 * each tool says whether it asks first, the Accepts secrets switch saves to the source and reads
 * back after a reload, and Sign in completes against a mock authorization server.
 *
 * Connecting a new source from the page is a separate change (COR-1845 split), so the sources here
 * are written before the host starts. The switch cases leave the host as they found it.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { CAPABILITIES_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';
import {
  E2E_FLAGGED_TOOL,
  E2E_LONG_OPERATION,
  E2E_TOOL_SOURCES,
  E2E_UNMATCHED_TOOL,
} from './tool-sources-support.ts';

const copy = CAPABILITIES_COPY;
const WIDTHS = [375, 1280] as const;

const sourceRow = (page: Page, id: string) => page.locator(`[data-source-row="${id}"]`);
const detail = (page: Page) => page.getByTestId('source-detail');
const toolOf = (page: Page, source: string, tool: string) =>
  page.locator(`[data-source-tool="${source}__${tool}"]`);
const switchOf = (page: Page, source: string, tool: string) =>
  toolOf(page, source, tool).getByRole('switch');

async function snapshotOf(request: APIRequestContext) {
  const response = await request.get('/host/tool-sources');
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    sources: {
      id: string;
      state: string;
      authorized?: boolean;
      tools: {
        name: string;
        tool: string;
        acceptsSecrets: boolean;
        savedAcceptsSecrets: boolean;
      }[];
    }[];
  };
}

test.describe('the Sources tab', () => {
  for (const width of WIDTHS) {
    test(`lists every saved source with where it stands, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capabilities?tab=sources');

      await expect(page.getByTestId('sources-count')).toHaveText('4');
      const states = {
        [E2E_TOOL_SOURCES.notes]: 'loaded',
        [E2E_TOOL_SOURCES.petstore]: 'loaded',
        [E2E_TOOL_SOURCES.ledger]: 'needs-authorization',
        [E2E_TOOL_SOURCES.broken]: 'failed',
      };
      for (const [id, state] of Object.entries(states)) {
        await expect(sourceRow(page, id)).toHaveAttribute('data-state', state);
      }
      await checkA11y(`the Sources tab at ${width}px`);
    });
  }

  test('says why a source failed, in words that hold no address', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/capabilities?tab=sources&source=${E2E_TOOL_SOURCES.broken}`);

    const failure = page.getByTestId('source-failure');
    await expect(failure).toContainText(copy.source.stateDescriptions.failed);
    await expect(failure.locator('.ib-capability__prose')).not.toBeEmpty();
    await expect(failure).not.toContainText('127.0.0.1');
  });

  test('puts the tools of an MCP server and an OpenAPI service in Capabilities beside every other', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities');
    await expect(page.locator('[data-view="capabilities"]')).toHaveAttribute('data-state', 'ready');

    for (const name of [
      `${E2E_TOOL_SOURCES.notes}__lookup`,
      `${E2E_TOOL_SOURCES.notes}__wipe`,
      `${E2E_TOOL_SOURCES.petstore}__list-pets`,
      `${E2E_TOOL_SOURCES.petstore}__create-pet`,
      `${E2E_TOOL_SOURCES.petstore}__delete-pet`,
    ]) {
      await expect(page.locator(`[data-tool-row="${name}"]`)).toHaveCount(1);
    }
  });

  for (const width of WIDTHS) {
    test(`opens a source with its tools, each with its tier and whether it asks first, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capabilities?tab=sources');
      await sourceRow(page, E2E_TOOL_SOURCES.notes).click();

      await expect(detail(page)).toHaveAttribute('data-source', E2E_TOOL_SOURCES.notes);
      await expect(page).toHaveURL(new RegExp(`source=${E2E_TOOL_SOURCES.notes}`));
      await expect(
        toolOf(page, E2E_TOOL_SOURCES.notes, 'lookup').getByTestId('tool-standing'),
      ).toContainText(copy.source.tools.standing.runs);
      await expect(
        toolOf(page, E2E_TOOL_SOURCES.notes, 'wipe').getByTestId('tool-standing'),
      ).toContainText(copy.source.tools.standing['asks-first']);
      // Accepts secrets is off until the owner turns it on.
      await expect(switchOf(page, E2E_TOOL_SOURCES.notes, 'lookup')).not.toBeChecked();
      await checkA11y(`a source open at ${width}px`);
    });
  }

  test('opens a tool of a source in the Tools tab, where it is granted to agents', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/capabilities?tab=sources&source=${E2E_TOOL_SOURCES.notes}`);
    await toolOf(page, E2E_TOOL_SOURCES.notes, 'wipe')
      .getByRole('link', { name: copy.source.tools.open(`${E2E_TOOL_SOURCES.notes}__wipe`) })
      .click();

    await expect(page.getByTestId('tool-detail')).toHaveAttribute(
      'data-tool',
      `${E2E_TOOL_SOURCES.notes}__wipe`,
    );
  });

  test('shows a tool with a long name, a flagged tool, and a setting that reaches no tool', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/capabilities?tab=sources&source=${E2E_TOOL_SOURCES.petstore}`);

    await expect(page.locator('[data-source-tool*="list-everything"]')).toHaveCount(1);
    expect(E2E_LONG_OPERATION.length).toBeGreaterThan(30);
    // The seed flagged this tool, and the running host loaded it flagged, so there is nothing pending.
    await expect(switchOf(page, E2E_TOOL_SOURCES.petstore, E2E_FLAGGED_TOOL)).toBeChecked();
    await expect(
      toolOf(page, E2E_TOOL_SOURCES.petstore, E2E_FLAGGED_TOOL).getByTestId('takes-effect'),
    ).toHaveCount(0);
    await expect(page.getByTestId('source-unmatched')).toContainText(E2E_UNMATCHED_TOOL);
  });

  test('turns Accepts secrets on for a tool, saves it to the source, and reads it back after a reload', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const address = `/capabilities?tab=sources&source=${E2E_TOOL_SOURCES.petstore}`;
    await page.goto(address);
    const control = switchOf(page, E2E_TOOL_SOURCES.petstore, 'list-pets');
    await expect(control).not.toBeChecked();
    await expect(control).toHaveAttribute('data-changes', '');

    await control.click();
    await expect(control).toBeChecked();
    // The running host loads the change at its next start, and the row says so.
    await expect(
      toolOf(page, E2E_TOOL_SOURCES.petstore, 'list-pets').getByTestId('takes-effect'),
    ).toBeVisible();
    const afterChange = await snapshotOf(request);
    const saved = afterChange.sources.find((source) => source.id === E2E_TOOL_SOURCES.petstore);
    expect(saved?.tools.find((tool) => tool.tool === 'list-pets')).toMatchObject({
      acceptsSecrets: false,
      savedAcceptsSecrets: true,
    });

    await page.reload();
    await expect(switchOf(page, E2E_TOOL_SOURCES.petstore, 'list-pets')).toBeChecked();
    // The other tools are as they were.
    await expect(switchOf(page, E2E_TOOL_SOURCES.petstore, 'delete-pet')).not.toBeChecked();

    // Back to the default, so nothing else sees a change.
    await switchOf(page, E2E_TOOL_SOURCES.petstore, 'list-pets').click();
    await expect(switchOf(page, E2E_TOOL_SOURCES.petstore, 'list-pets')).not.toBeChecked();
    await page.reload();
    await expect(switchOf(page, E2E_TOOL_SOURCES.petstore, 'list-pets')).not.toBeChecked();
    await expect(
      toolOf(page, E2E_TOOL_SOURCES.petstore, 'list-pets').getByTestId('takes-effect'),
    ).toHaveCount(0);
  });

  test('signs in to an OAuth server, and the page then says to restart to list its tools', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/capabilities?tab=sources&source=${E2E_TOOL_SOURCES.ledger}`);
    await expect(detail(page)).toHaveAttribute('data-state', 'needs-authorization');

    const before = await snapshotOf(request);
    const alreadySignedIn = before.sources.find(
      (source) => source.id === E2E_TOOL_SOURCES.ledger,
    )?.authorized;
    if (alreadySignedIn !== true) {
      const popup = page.waitForEvent('popup');
      await page.getByRole('button', { name: copy.source.signIn.action }).click();
      const signIn = await popup;
      // The mock authorization server approves at once and sends the browser back to the host.
      await signIn.waitForURL(/\/host\/oauth\/callback\//);
      await expect(signIn.getByText(/^Signed in\./)).toBeVisible();
      // The page the authorization server came back to keeps nothing of the request.
      expect(await signIn.content()).not.toMatch(/access-|refresh-/);
      await signIn.close();
    }

    await page.reload();
    await expect(page.getByTestId('source-state-description')).toHaveText(
      copy.source.signIn.signedIn,
    );
    const content = await page.content();
    expect(content).not.toMatch(/access-|refresh-/);
    const after = await snapshotOf(request);
    expect(after.sources.find((source) => source.id === E2E_TOOL_SOURCES.ledger)).toMatchObject({
      authorized: true,
    });
  });
});
