/**
 * "Explain further" on the Run page of a failed agent run (COR-2534). Under the explanation the
 * Bureau stored (COR-2533), the page offers to ask a model to read the run and explain it at more
 * length. It happens only when asked: the action is drawn, then the model's text is drawn under the
 * model's name with what it cost while the stored explanation stays above it, and with no provider
 * connected the Bureau's fault says to connect one.
 *
 * The run is the failing scripted agent's (`failure-explanation-agents.ts`), so its task is a real
 * failed run with a stored failure. The two operations that call a model are answered by the
 * specification, because no provider is connected to the end-to-end host: `get` answers what is
 * stored and `generate` answers the model's text, or the fault the Bureau answers when no provider
 * is connected (`UnsupportedCapability`, with its remediation in `error.data`).
 *
 * Captured for the design review on a desktop and a phone, in `/runs/:run`'s `failed agent run,
 * explain further offered`, `failed agent run explained further` and `failed agent run, no provider
 * connected` states. Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Page, Route } from '@playwright/test';

import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { FAILING_AGENT_NAME } from './failure-explanation-agents.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { tasksOfSession } from './task-support.ts';

const SOURCE = 'run-explain-further.spec.ts';
const WIDTHS = [1280, 375] as const;
const BUREAU_CALLS = '**/jsonrpc';
const BUREAU_LOGGED = /\/jsonrpc/;

const MODEL_EXPLANATION = {
  text: 'The scripted model failed before it could answer, so the run stopped at its first step.\n\nStart the run again once the model is reachable.',
  model: 'anthropic/claude-haiku-5-5',
  generatedAt: '2026-11-21T10:00:00.000Z',
  costUsd: 0.0021,
} as const;

const CONNECT_A_PROVIDER =
  'Connect a provider in Settings, under Models, so a model can write the explanation; the stored explanation of the failure still reads without one.';

/** Which answer the specification gives the two operations that call a model. */
type ModelAnswer = 'written' | 'no provider';

/**
 * Answers `bureau.tasks.explanation.get` with nothing stored and `bureau.tasks.explanation.generate`
 * with the model's text or with the fault of a Bureau that has no provider; every other call goes to
 * the host.
 */
async function answerModelCalls(page: Page, answer: ModelAnswer): Promise<void> {
  // What the task keeps: nothing until `generate` has written it, as the Bureau does, so a read
  // after the click (a refetch) shows the text and never blanks it.
  let stored: typeof MODEL_EXPLANATION | null = null;
  await page.route(BUREAU_CALLS, async (route: Route) => {
    const body = route.request().postData() ?? '';
    const method = /"method":"(bureau\.tasks\.explanation\.[a-z]+)"/.exec(body)?.[1];
    if (method === undefined) {
      await route.fallback();
      return;
    }
    const { id } = JSON.parse(body) as { id: unknown };
    if (method === 'bureau.tasks.explanation.get') {
      await route.fulfill({ json: { jsonrpc: '2.0', id, result: { explanation: stored } } });
      return;
    }
    if (answer === 'written') {
      stored = MODEL_EXPLANATION;
      await route.fulfill({
        json: { jsonrpc: '2.0', id, result: { explanation: MODEL_EXPLANATION } },
      });
      return;
    }
    await route.fulfill({
      status: 501,
      json: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: 'No model is connected to write the explanation',
          // The fields a Bureau's `UnsupportedCapability` carries on the wire (`faultToJsonRpcError`).
          data: {
            capability: 'generate',
            weftCode: 'UnsupportedCapability',
            httpStatus: 501,
            retryable: false,
            remediation: CONNECT_A_PROVIDER,
          },
        },
      },
    });
  });
}

for (const width of WIDTHS) {
  // The route leads the title, so a design review's route filter (`--grep '/runs/:run'`) runs these.
  test.describe(`/runs/:run at ${String(width)} pixels, a failed agent run explained further`, () => {
    const threads: string[] = [];

    test.afterEach(async () => {
      await deleteChats(threads.splice(0));
    });

    /** A failed run of the failing agent, opened on its own page at `width`. */
    async function openFailedRun(
      page: Page,
      request: Parameters<typeof runToEnd>[0],
    ): Promise<void> {
      const thread = newThreadId('run-explain-further');
      threads.push(thread);
      await runToEnd(request, FAILING_AGENT_NAME, thread, 'Fail on purpose.');
      const [failed] = await tasksOfSession(request, thread);
      expect(failed?.status).toBe('failed');
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/runs/${encodeURIComponent(failed!.id)}`);
      await expect(
        page.locator('[data-run-explanation] [data-explanation="summary"]'),
      ).toBeVisible();
    }

    test('offers "Explain further" under the stored explanation, and asks no model until it is pressed (COR-2534)', async ({
      page,
      request,
    }) => {
      await answerModelCalls(page, 'written');
      await openFailedRun(page, request);

      const further = page.locator('[data-explanation="further"]');
      await expect(further.getByRole('button', { name: 'Explain further' })).toBeVisible();
      await expect(page.locator('[data-explanation="model-text"]')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'failed agent run, explain further offered',
        source: SOURCE,
      });
    });

    test('shows the model’s text under its name and cost, with the stored explanation still above it (COR-2534)', async ({
      page,
      request,
    }) => {
      await answerModelCalls(page, 'written');
      await openFailedRun(page, request);

      await page.getByRole('button', { name: 'Explain further' }).click();

      const written = page.locator('[data-explanation="model-text"]');
      await expect(written).toContainText('Start the run again once the model is reachable.');
      await expect(written.locator('[data-explanation="model-name"]')).toContainText(
        'Written by anthropic/claude-haiku-5-5',
      );
      await expect(written.locator('[data-explanation="model-cost"]')).toContainText(
        'Cost of this explanation',
      );
      // What the Bureau stored stays on the page, above what the model wrote.
      await expect(page.locator('[data-explanation="summary"]')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Explain again' })).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'failed agent run explained further',
        source: SOURCE,
      });
    });

    test('says to connect a provider when none is connected (COR-2534)', async ({
      page,
      request,
      pageErrors,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(501, BUREAU_LOGGED),
        reason:
          'the test answers bureau.tasks.explanation.generate with a 501, as a Bureau with no provider does',
      });
      await answerModelCalls(page, 'no provider');
      await openFailedRun(page, request);

      await page.getByRole('button', { name: 'Explain further' }).click();

      const fault = page.locator('[data-explanation="further-fault"]');
      await expect(fault).toContainText('No model is connected to write the explanation');
      await expect(fault.locator('.cinder-error-state-remediation')).toHaveText(CONNECT_A_PROVIDER);
      // Nothing was written, and the stored explanation is still there.
      await expect(page.locator('[data-explanation="model-text"]')).toHaveCount(0);
      await expect(page.locator('[data-explanation="summary"]')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'failed agent run, no provider connected',
        source: SOURCE,
      });
    });
  });
}
