/**
 * Duplicate on a plugin's code agent, against the real host (COR-2232, COR-2234). The demo plugin's
 * `demo:tool-runner` is scripted, stops on a pending approval and holds a toolbox, so a file cannot
 * state everything it does: pressing Duplicate asks first, listing what the copy leaves out, and
 * writes nothing until it is confirmed. A copy records where it came from, and its page says so in
 * one plain line of the header once the source has changed, on every tab, and says nothing while the
 * source is as it was.
 */
import { readFile } from 'node:fs/promises';

import { AGENT_PAGE_COPY } from '../../src/app/copy/agents.ts';
import {
  agentFilePath,
  bureau,
  faultCodeOf,
  listedStateOf,
  removeAgent,
  writeAgentFileAtomically,
} from './agent-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;
const SOURCE = 'demo:tool-runner';
const COPY = 'tool-runner';
const OLDER_COPY = 'tool-runner-older';
const words = AGENT_PAGE_COPY.plugin;

test.afterEach(async ({ request }) => {
  await removeAgent(request, COPY);
  await removeAgent(request, OLDER_COPY);
});

for (const width of WIDTHS) {
  test(`asks first, listing what the copy leaves out, and writes nothing until it is confirmed, at ${width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/agents/${encodeURIComponent(SOURCE)}`);
    await page.getByRole('button', { name: words.duplicate }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const rows = page.getByTestId('agent-duplicate-dropped').getByRole('listitem');
    await expect(rows.first()).toBeVisible();
    // Each row is a name in bold and a sentence, in a person's words, never a wire name.
    await expect(dialog.locator('li[data-dropped="stopWhen"] strong')).toHaveText('When it stops.');
    await expect(dialog.getByText('stopWhen')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/agents/:agent (duplicate confirmation)',
      state: 'ready',
      source: 'agent-duplicate.spec.ts',
    });
    await checkA11y(`duplicate confirmation at ${width}px`);

    // Cancel writes nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await faultCodeOf(request, COPY)).toBe('NotFound');

    // Confirming writes the copy and opens it.
    await page.getByRole('button', { name: words.duplicate }).click();
    await dialog.getByRole('button', { name: words.duplicate }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${COPY}$`));
  });

  test(`says on a copy that its source has changed, and nothing while it has not, at ${width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const copied = await bureau(request, 'bureau.agents.definitions.duplicate', { id: SOURCE });
    expect(copied.fault, 'duplicating the source').toBeUndefined();

    // The copy as it was made: its source is at the version it recorded, so the page says nothing.
    await page.goto(`/agents/${COPY}`);
    await expect(page.getByTestId('agent-header')).toBeVisible();
    await expect(page.getByTestId('agent-status')).toBeVisible();
    await expect(page.getByTestId('agent-copied-from')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/agents/:agent (copy of an unchanged source)',
      state: 'ready',
      source: 'agent-duplicate.spec.ts',
    });

    // A copy made when the source was at an older version.
    const text = await readFile(await agentFilePath(request, COPY), 'utf8');
    const older = text.replace(/^( {2}version: ).*$/mu, '$10.0.1');
    expect(older).not.toBe(text);
    await writeAgentFileAtomically(await agentFilePath(request, OLDER_COPY), older);
    await expect.poll(() => listedStateOf(request, OLDER_COPY)).toBe('ready');

    await page.goto(`/agents/${OLDER_COPY}`);
    const line = page.getByTestId('agent-copied-from');
    await expect(line).toBeVisible();
    await expect(line).toContainText(AGENT_PAGE_COPY.header.copiedFrom.lead);
    await expect(line).toContainText('0.0.1');
    // The source's display name is the copy's own, so the link says the identifier, never "Copied from tool-runner" on tool-runner.
    await expect(line.getByRole('link')).toHaveText(SOURCE);
    await expect(line.getByRole('link')).toHaveAttribute(
      'href',
      `/agents/${encodeURIComponent(SOURCE)}`,
    );
    await captureForDesignReview(page, {
      route: '/agents/:agent (copy of a changed source)',
      state: 'ready',
      source: 'agent-duplicate.spec.ts',
    });
    await checkA11y(`copy of a changed source at ${width}px`);

    // A second version whose changed keys include `from`: the file is edited by hand to say the
    // copy was made at another version.
    const edited = older.replace(/^( {2}version: ).*$/mu, '$10.0.2');
    expect(edited).not.toBe(older);
    // Versions outlive a deleted agent, so the count is read before the edit, not assumed.
    const versionCount = async () => {
      const answer = await bureau(request, 'bureau.agents.versions.list', { id: OLDER_COPY });
      return (answer.result as { versions?: unknown[] } | undefined)?.versions?.length ?? 0;
    };
    const before = await versionCount();
    await writeAgentFileAtomically(await agentFilePath(request, OLDER_COPY), edited);
    await expect.poll(versionCount).toBe(before + 1);

    // The header is shared, so the line stays on every tab.
    await page.goto(`/agents/${OLDER_COPY}/settings`);
    await expect(page.getByTestId('agent-copied-from')).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent (copy of a changed source)',
      state: 'ready',
      tab: 'settings',
      source: 'agent-duplicate.spec.ts',
    });

    // The version that changed `from` names it by its own label.
    const versions = page.getByTestId('agent-versions');
    await expect(versions).toContainText(AGENT_PAGE_COPY.versions.keys.from);
    await versions.scrollIntoViewIfNeeded();
    await captureForDesignReview(page, {
      route: '/agents/:agent (versions after a copy)',
      state: 'ready',
      tab: 'settings',
      source: 'agent-duplicate.spec.ts',
    });
  });

  test(`shows the dialog busy, then its failure with Duplicate armed as the retry, at ${width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/agents/${encodeURIComponent(SOURCE)}`);

    // (a) Confirming is held pending, so the dialog stays open and busy.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/bureau/jsonrpc', async (route) => {
      const call = route.request().postDataJSON() as { method?: string };
      if (call.method === 'bureau.agents.definitions.duplicate') await held;
      await route.fallback();
    });
    await page.getByRole('button', { name: words.duplicate }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: words.duplicate }).click();
    await expect(dialog.getByRole('button', { name: words.confirm.busy })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent (duplicate confirmation)',
      state: 'busy',
      source: 'agent-duplicate.spec.ts',
    });
    release();
    await expect(page).toHaveURL(new RegExp(`/agents/${COPY}$`));
    await page.unroute('**/bureau/jsonrpc');

    // (b) The name is taken now, so the next confirmation fails in the dialog and stays armed.
    await page.goto(`/agents/${encodeURIComponent(SOURCE)}`);
    await page.getByRole('button', { name: words.duplicate }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: words.duplicate }).click();
    await expect(dialog).toContainText(words.confirm.errorTitle);
    await expect(dialog.getByRole('button', { name: words.duplicate })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/agents/:agent (duplicate confirmation)',
      state: 'error',
      source: 'agent-duplicate.spec.ts',
    });
    await checkA11y(`duplicate confirmation failed at ${width}px`);
    expect(await faultCodeOf(request, COPY)).toBeUndefined();
  });

  test(`says on the page when the source's definition cannot be read, at ${width} pixels`, async ({
    page,
    pageErrors,
  }) => {
    // The one cause this test declares: the host answers a read of the source's definition with a 500.
    pageErrors.expectEvery({
      pattern: /status of 500.*\/bureau\/jsonrpc/,
      reason: 'the test makes the Bureau fail the read of the source before Duplicate asks',
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/agents/${encodeURIComponent(SOURCE)}`);
    await expect(page.getByTestId('agent-header')).toBeVisible();
    await page.route('**/bureau/jsonrpc', async (route) => {
      const call = route.request().postDataJSON() as { method?: string; id?: unknown };
      if (call.method !== 'bureau.agents.definitions.get') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 500,
        json: { jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'Internal error' } },
      });
    });
    await page.getByRole('button', { name: words.duplicate }).click();
    await expect(page.getByRole('alert').filter({ hasText: words.failed })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/agents/:agent (duplicate failed to read)',
      state: 'error',
      source: 'agent-duplicate.spec.ts',
    });
  });

  test(`says on a copy of a plugin's file agent that its source has changed, at ${width} pixels`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const copied = await bureau(request, 'bureau.agents.definitions.duplicate', { id: SOURCE });
    expect(copied.fault, 'duplicating the source').toBeUndefined();
    // The demo plugin ships no file agent, so the copy's detail is answered as a copy of one would
    // be: its source recorded by the fingerprint of its file, which is not the fingerprint now.
    await page.route('**/bureau/jsonrpc', async (route) => {
      const call = route.request().postDataJSON() as { method?: string; params?: { id?: string } };
      if (call.method !== 'bureau.agents.definitions.get' || call.params?.id !== COPY) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        result: { definition: Record<string, unknown> } & Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: {
          ...body,
          result: {
            ...body.result,
            definition: {
              ...body.result.definition,
              from: { agent: 'linear:triager', version: 'a'.repeat(64) },
            },
            fromNow: 'b'.repeat(64),
          },
        },
      });
    });
    await page.goto(`/agents/${COPY}`);
    const line = page.getByTestId('agent-copied-from');
    await expect(line).toContainText(
      `${AGENT_PAGE_COPY.header.copiedFrom.lead} linear:triager${AGENT_PAGE_COPY.header.copiedFrom.changed}`,
    );
    await captureForDesignReview(page, {
      route: '/agents/:agent (copy of a changed file source)',
      state: 'ready',
      source: 'agent-duplicate.spec.ts',
    });
  });
}
