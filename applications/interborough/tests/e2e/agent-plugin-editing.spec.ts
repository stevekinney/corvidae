/**
 * A plugin's agent defined in code, edited on its page against the real host (COR-2229). The demo
 * plugin's `demo:echo` is scripted and holds no file, so its Settings and Access tabs save as
 * versions of its overrides, through the same form and table an agent file uses, and the versions
 * list shows each with Restore. An agent whose plugin is disabled stays read-only: its tabs say
 * `Plugin Demo is disabled` in one line, and Duplicate stays in the header (the showcase host keeps
 * the demo plugin off).
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`).
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { AGENT_PAGE_COPY } from '../../src/app/copy/agents.ts';

import { bureau } from './agent-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 1280] as const;
const SOURCE = 'agent-plugin-editing.spec.ts';
const ECHO = 'demo:echo';
const settings = AGENT_PAGE_COPY.settings;

/** Puts the agent's overrides back to none, as a save of an empty set does, so a run leaves nothing behind. */
async function resetOverrides(request: APIRequestContext): Promise<void> {
  const read = await bureau(request, 'bureau.agents.overrides.get', { id: ECHO });
  const state = read.result as { hash: string; version: number | null } | undefined;
  if (state === undefined || state.version === null) return;
  await bureau(request, 'bureau.agents.overrides.update', {
    id: ECHO,
    expectedHash: state.hash,
    overrides: {},
  });
}

test.afterEach(async ({ request }) => {
  await resetOverrides(request);
});

/**
 * Answers one method of the Bureau with a refusal, as the host answers one it will not do (a
 * JSON-RPC error with the fault's code in its data), and sends every other call on. The error rides
 * a 200 response, so the browser logs nothing for it.
 */
async function refuse(
  page: Page,
  method: string,
  fault: { message: string; httpStatus: number; weftCode: string },
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const call = route.request().postDataJSON() as { method?: string; id?: unknown };
    if (call.method !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: call.id,
        error: {
          code: -32000,
          message: fault.message,
          data: { httpStatus: fault.httpStatus, weftCode: fault.weftCode },
        },
      },
    });
  });
}

const STALE = {
  message: 'The overrides changed after the tab read them.',
  httpStatus: 409,
  weftCode: 'StaleRevision',
} as const;
const FORBIDDEN = { message: 'Forbidden', httpStatus: 403, weftCode: 'Forbidden' } as const;
const FAILED = { message: 'Internal error', httpStatus: 500, weftCode: 'Internal' } as const;

/** The version the overrides are at, 0 for an agent nobody changed. A reset is a version too, so a run counts from here. */
async function versionNow(request: APIRequestContext): Promise<number> {
  const read = await bureau(request, 'bureau.agents.overrides.get', { id: ECHO });
  return (read.result as { version: number | null }).version ?? 0;
}

for (const width of WIDTHS) {
  test(`edits the instructions of a running plugin's agent, and the save is the next version, at ${width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const base = await versionNow(request);
    await page.goto(`/agents/${encodeURIComponent(ECHO)}/settings`);

    const field = page.getByRole('textbox', { name: settings.instructionsLabel });
    await expect(field).toBeEnabled();
    await expect(page.getByTestId('agent-plugin-note')).toContainText('Demo ships this agent');
    await expect(page.getByTestId('agent-settings-save-note')).toHaveText(
      `Saving makes Version ${String(base + 1)}.`,
    );
    await expect(page.getByRole('button', { name: settings.deleteAction })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings (a plugin’s code agent)',
      state: 'ready',
      source: SOURCE,
    });
    await checkA11y(`plugin agent settings at ${width}px`);

    await field.fill('Answer in one short line.');
    await page.getByRole('button', { name: settings.save }).click();
    const saved = page.locator(
      `[data-testid="agent-versions"] [data-revision="${String(base + 1)}"]`,
    );
    await expect(saved).toContainText(`Version ${String(base + 1)}`);
    await expect(saved).toContainText('Current');
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings (a plugin’s code agent)',
      state: 'saved as the next version',
      source: SOURCE,
    });

    expect(await versionNow(request)).toBe(base + 1);
  });

  test(`allows a tool on the Access tab as the next version, and Restore writes an older version back, at ${width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const read = await bureau(request, 'bureau.agents.overrides.get', { id: ECHO });
    const { hash, version } = read.result as { hash: string; version: number | null };
    const first = (version ?? 0) + 1;
    await bureau(request, 'bureau.agents.overrides.update', {
      id: ECHO,
      expectedHash: hash,
      overrides: { instructions: 'Answer in one short line.' },
    });

    await page.goto(`/agents/${encodeURIComponent(ECHO)}/access`);
    await expect(page.getByTestId('agent-plugin-note')).toBeVisible();
    const boxes = page.getByTestId('agent-access-table').getByRole('checkbox');
    await expect(boxes.first()).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/agents/:agent/access (a plugin’s code agent)',
      state: 'ready',
      source: SOURCE,
    });
    await checkA11y(`plugin agent access at ${width}px`);

    await page.goto(`/agents/${encodeURIComponent(ECHO)}/settings`);
    await page.getByRole('textbox', { name: settings.instructionsLabel }).fill('Shout it back.');
    await page.getByRole('button', { name: settings.save }).click();
    await expect(
      page.locator(`[data-testid="agent-versions"] [data-revision="${String(first + 1)}"]`),
    ).toBeVisible();
    // A version of overrides is shown with its own instructions, never as a version with no definition.
    await page.getByRole('button', { name: AGENT_PAGE_COPY.versions.viewLabel(first) }).click();
    const view = page.getByTestId('agent-version-view');
    await expect(view).toContainText('Answer in one short line.');
    await expect(view).not.toContainText(AGENT_PAGE_COPY.versions.view.noDefinition);
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings (a plugin’s code agent, a version)',
      state: 'version view',
      source: SOURCE,
    });
    await view.getByRole('button', { name: AGENT_PAGE_COPY.versions.view.back }).click();
    await page.getByRole('button', { name: AGENT_PAGE_COPY.versions.restoreLabel(first) }).click();
    const question = page.getByRole('dialog', {
      name: AGENT_PAGE_COPY.versions.restoreDialog.title(first),
    });
    await expect(question).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings (a plugin’s code agent, Restore)',
      state: 'restore question',
      source: SOURCE,
    });
    await question
      .getByRole('button', { name: AGENT_PAGE_COPY.versions.restoreDialog.confirm(first) })
      .click();
    await expect(
      page.locator(`[data-testid="agent-versions"] [data-revision="${String(first + 2)}"]`),
    ).toBeVisible();
  });

  test(`the Instructions tab of a plugin's code agent says where its instructions are changed, and the Access tab holds the Asks the agent states itself, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/agents/${encodeURIComponent(ECHO)}/instructions`);
    // The scripted echo states no instructions, so its empty state's action goes to Settings.
    const action = page.getByTestId('agent-instructions-settings');
    await expect(action).toHaveText(AGENT_PAGE_COPY.instructions.emptyAction);
    await captureForDesignReview(page, {
      route: '/agents/:agent/instructions (a plugin’s code agent)',
      state: 'ready',
      source: SOURCE,
    });
    await checkA11y(`plugin agent instructions at ${width}px`);
    await action.click();
    await expect(page).toHaveURL(/\/agents\/demo%3Aecho\/settings$/);

    // The tool runner states Asks of its own, which an override would replace whole.
    await page.goto(`/agents/${encodeURIComponent('demo:tool-runner')}/access`);
    await expect(page.getByTestId('agent-plugin-note')).toContainText(
      'Its own tools and Asks stay as they are here',
    );
    // Its own tools are the host's Demo tools, each once: no copy of them filed as retired. They are
    // held with the Asks, because a change to the tools would drop the policy the agent states.
    await expect(page.locator('[data-group="plugin:demo"]')).toContainText('2 of 2');
    await expect(page.locator('[data-group="retired"]')).toHaveCount(0);
    await expect(
      page.getByTestId('agent-access-table').getByRole('checkbox', { name: /Allow Issue refund/ }),
    ).toBeDisabled();
    await captureForDesignReview(page, {
      route: '/agents/:agent/access (a plugin’s code agent that states its own Asks)',
      state: 'Asks held',
      source: SOURCE,
    });
  });

  test(`an agent whose plugin is disabled is read-only with the reason and Duplicate, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of ['settings', 'access'] as const) {
      await page.goto(
        `${E2E_SHOWCASE_URL}/agents/${encodeURIComponent('demo:release-helper')}/${tab}`,
      );
      const note = page.getByTestId('agent-plugin-note');
      await expect(note).toContainText('Plugin Demo is disabled');
      await expect(
        page.getByRole('button', { name: AGENT_PAGE_COPY.plugin.duplicate }),
      ).toBeVisible();
      await expect(page.getByRole('textbox', { name: settings.instructionsLabel })).toHaveCount(0);
      await captureForDesignReview(page, {
        route: `/agents/:agent/${tab} (an unavailable plugin agent)`,
        state: 'read-only',
        source: SOURCE,
      });
      await checkA11y(`unavailable plugin agent ${tab} at ${width}px`);
    }
  });

  test(`the Settings and Access tabs of a running plugin's file agent are read-only and say the plugin ships it, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // No plugin ships an agent file today: `demo:release-helper` is a code agent, so while Demo
    // runs its tabs are the editable form. The Bureau is made to answer for it as a ready agent
    // that is a file of the Demo plugin, which is the one shape the read-only branch renders for.
    const agent = 'demo:release-helper';
    await page.route('**/bureau/jsonrpc', async (route) => {
      const call = route.request().postDataJSON() as {
        method?: string;
        id?: unknown;
        params?: { id?: unknown };
      };
      if (call.method !== 'bureau.agents.definitions.get' || call.params?.id !== agent) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: call.id,
          result: {
            id: agent,
            source: 'file',
            state: 'ready',
            unavailable: null,
            name: 'release-helper',
            description: 'Drafts release notes.',
            a2a: false,
            hash: 'plugin-file-hash',
            problem: null,
            codeDefinition: null,
            definition: {
              name: 'release-helper',
              description: 'Drafts release notes.',
              model: 'anthropic/sonnet',
              tools: [],
              card: [],
              a2a: false,
              instructions: 'Draft release notes from the merged changes.',
            },
          },
        },
      });
    });
    for (const tab of ['settings', 'access'] as const) {
      await page.goto(`/agents/${encodeURIComponent(agent)}/${tab}`);
      // The agent is a file of the running Demo plugin, so the page only reads it.
      await expect(page.getByTestId('agent-plugin-note')).toContainText(
        AGENT_PAGE_COPY.plugin.note('Demo'),
      );
      await expect(page.getByTestId('agent-plugin-note')).not.toContainText('is disabled');
      await expect(page.getByRole('textbox', { name: settings.instructionsLabel })).toHaveCount(0);
      await expect(page.getByRole('button', { name: settings.save })).toHaveCount(0);
      await captureForDesignReview(page, {
        route: `/agents/:agent/${tab} (a running plugin’s file agent)`,
        state: 'read-only',
        source: SOURCE,
      });
      await checkA11y(`running plugin file agent ${tab} at ${width}px`);
    }
  });

  test(`the header of a running plugin's agent and of a built-in agent, and the built-in agent's Access tab that holds what it cannot read, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const [agent, kind] of [
      ['demo:release-helper', 'a running plugin’s agent'],
      [TEXT_ECHO_AGENT_NAME, 'a built-in agent'],
    ] as const) {
      await page.goto(`/agents/${encodeURIComponent(agent)}`);
      await expect(page.getByTestId('agent-header')).toBeVisible();
      await expect(
        page
          .getByTestId('agent-header')
          .getByRole(agent === TEXT_ECHO_AGENT_NAME ? 'link' : 'button', {
            name: AGENT_PAGE_COPY.duplicate,
          }),
      ).toBeVisible();
      await captureForDesignReview(page, {
        route: `/agents/:agent (${kind})`,
        state: 'header',
        source: SOURCE,
      });
      await checkA11y(`header of ${kind} at ${width}px`);
    }

    // A built-in agent's own policy is not on the wire, so its tools, Asks and guardrails are held.
    await page.goto(`/agents/${encodeURIComponent(TEXT_ECHO_AGENT_NAME)}/access`);
    await expect(page.getByTestId('agent-built-in')).toContainText(
      'Its own tools, Asks and guardrails stay as they are here',
    );
    await captureForDesignReview(page, {
      route: '/agents/:agent/access (a built-in agent)',
      state: 'tools, Asks and guardrails held',
      source: SOURCE,
    });
  });

  for (const tab of ['settings', 'access'] as const) {
    test(`the ${tab} tab of a plugin's code agent while its overrides load, when the read fails and is tried again, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const route = `/agents/:agent/${tab} (a plugin’s code agent)`;
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/bureau/jsonrpc', async (request) => {
        const call = request.request().postDataJSON() as { method?: string };
        if (call.method === 'bureau.agents.overrides.get') await held;
        await request.fallback();
      });
      await page.goto(`/agents/${encodeURIComponent(ECHO)}/${tab}`);
      await expect(page.getByTestId('agent-tab-loading')).toBeVisible();
      // The Skeleton draws nothing for its first 300 ms (`delay`), so the wrapper alone is a blank
      // body: wait for the placeholders themselves before the capture shows the loading state.
      await expect(
        page.getByTestId('agent-tab-loading').locator('.cinder-skeleton').first(),
      ).toBeVisible();
      await captureForDesignReview(page, { route, state: 'loading', source: SOURCE });
      release();
      await expect(page.getByTestId('agent-tab-loading')).toHaveCount(0);
      await page.unroute('**/bureau/jsonrpc');

      await refuse(page, 'bureau.agents.overrides.get', FAILED);
      await page.reload();
      await expect(page.getByTestId('agent-tab-failed')).toBeVisible();
      await captureForDesignReview(page, {
        route,
        state: 'failed, with Try again',
        source: SOURCE,
      });
      await checkA11y(`${tab} tab of a plugin agent, failed to load, at ${width}px`);
      await page.unroute('**/bureau/jsonrpc');
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByTestId('agent-tab-failed')).toHaveCount(0);
      await expect(page.getByTestId('agent-plugin-note')).toBeVisible();
    });
  }

  test(`a save of a plugin's code agent that is stale or refused says so on Settings and on Access, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const alert = page.getByRole('alert');

    // Settings: the instructions are saved with Save changes.
    await page.goto(`/agents/${encodeURIComponent(ECHO)}/settings`);
    const field = page.getByRole('textbox', { name: settings.instructionsLabel });
    await expect(field).toBeEnabled();
    await field.fill('Answer in one short line.');
    await refuse(page, 'bureau.agents.overrides.update', STALE);
    await page.getByRole('button', { name: settings.save }).click();
    await expect(alert.filter({ hasText: settings.stale })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings (a plugin’s code agent)',
      state: 'stale write',
      source: SOURCE,
    });
    await page.unroute('**/bureau/jsonrpc');
    await refuse(page, 'bureau.agents.overrides.update', FORBIDDEN);
    await page.getByRole('button', { name: settings.save }).click();
    await expect(alert.filter({ hasText: settings.forbidden })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings (a plugin’s code agent)',
      state: 'forbidden',
      source: SOURCE,
    });
    await page.unroute('**/bureau/jsonrpc');

    // Access: the spend limit saves when the field is left.
    const access = AGENT_PAGE_COPY.access;
    await page.goto(`/agents/${encodeURIComponent(ECHO)}/access`);
    const spend = page.getByLabel(access.spendLabel);
    await expect(spend).toBeEnabled();
    await refuse(page, 'bureau.agents.overrides.update', STALE);
    await spend.fill('4');
    await spend.press('Tab');
    await expect(page.locator('[data-failed="spend"]')).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent/access (a plugin’s code agent)',
      state: 'stale write',
      source: SOURCE,
    });
    await page.unroute('**/bureau/jsonrpc');
    await refuse(page, 'bureau.agents.overrides.update', FORBIDDEN);
    await spend.fill('5');
    await spend.press('Tab');
    await expect(alert.filter({ hasText: access.forbidden })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent/access (a plugin’s code agent)',
      state: 'forbidden',
      source: SOURCE,
    });
    await checkA11y(`a refused save on Access at ${width}px`);
  });
}
