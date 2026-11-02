/**
 * COR-910 (2 of 2) — the pending-review app, loaded the way an MCP Apps host loads it: the built
 * `ui://` page in a sandboxed frame under its declared deny-all policy, behind the ext-apps 2.0.x
 * `AppBridge`. Tool calls are answered from fixtures, so the spec proves the page, not the Bureau.
 */
import { default as Axe } from '@axe-core/playwright';
import { pendingReview } from '@lostgradient/plugin-inspectors';
import type { McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type Page } from '@playwright/test';

import { buildMcpAppPage } from '../../src/host/mcp-app-build.ts';
import { MCP_APP_UI_META } from '../../src/host/mcp-app-mounts.ts';

const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = 'Pending reviews';

let hostScript = '';
let pageHtml = '';

test.beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL('./reference-host.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'esm',
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, 'The reference host did not build');
  hostScript = await bundle.outputs[0]!.text();
  const built = await buildMcpAppPage({
    entry: pendingReview.entry.href,
    title: pendingReview.title,
    styles: pendingReview.styles ?? '',
  });
  pageHtml = built.html;
});

const review = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  runId: `run-${id}`,
  kind: 'tool-approval',
  status: 'pending',
  agentName: 'worker',
  requestedAt: 1,
  ageMilliseconds: 5,
  sessionId: 's',
  round: 0,
  approval: {
    callId: 'c',
    toolName: 'shell',
    arguments: { cmd: 'ls' },
    reason: 'outside the sandbox',
    action: { type: 'approval', risk: 'high', operation: { kind: 'command', command: 'ls' } },
  },
  ...overrides,
});

async function open(page: Page, reviews: unknown[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${HOST_ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Reference host</title><script type="module">${hostScript}</script>`,
    }),
  );
  await page.goto(`${HOST_ORIGIN}/`);
  await page.evaluate<
    void,
    { html: string; csp: McpUiResourceCsp; reviews: { id: string }[]; title: string }
  >(
    async ({ html, csp, reviews: queue, title }) => {
      const host = window.referenceHost;
      const state = { queue: [...queue] as { id: string; status: string }[] };
      Object.assign(window, { queueState: state });
      host.handlers['bureau.reviews.list'] = () => ({
        reviews: state.queue.filter((item) => item.status === 'pending'),
      });
      host.handlers['bureau.reviews.get'] = (args) => {
        const found = state.queue.find((item) => item.id === args['id']);
        if (found === undefined) throw new Error('NotFound');
        return found;
      };
      host.handlers['bureau.reviews.resolve'] = (args) => {
        const found = state.queue.find((item) => item.id === args['id']);
        if (found === undefined || found.status !== 'pending') throw new Error('NotFound');
        found.status = args['decision'] === 'approve' ? 'approved' : 'denied';
        return {
          id: found.id,
          kind: 'tool-approval',
          decision: args['decision'],
          receipt: 'applied',
        };
      };
      await host.mount(html, csp, {}, title);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      reviews: reviews as { id: string }[],
      title: TITLE,
    },
  );
  return { errors, app: page.frameLocator(`iframe[title="${TITLE}"]`) };
}

const calls = (page: Page, name: string) =>
  page.evaluate((tool) => window.referenceHost.calls.filter((call) => call.name === tool), name);

test.describe('the pending-review MCP App', () => {
  test('lists the current reviews and offers each its three decisions', async ({ page }) => {
    const { app, errors } = await open(page, [review('a'), review('b', { agentName: 'other' })]);
    await expect(app.getByRole('heading', { level: 1, name: 'Pending reviews (2)' })).toBeVisible();
    await expect(
      app.getByRole('heading', { level: 2, name: 'worker asks to run shell' }),
    ).toBeVisible();
    const group = app.getByRole('group', { name: 'Decide worker asks to run shell' });
    await expect(group.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await expect(group.getByRole('button', { name: 'Deny' })).toBeEnabled();
    await expect(group.getByRole('button', { name: 'Reject with feedback' })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('approves by keyboard, removes the review, and decides it exactly once', async ({
    page,
  }) => {
    const { app } = await open(page, [review('a')]);
    const approve = app.getByRole('button', { name: 'Approve' });
    await approve.focus();
    await page.keyboard.press('Enter');
    await expect(app.getByRole('status')).toHaveText('Approved.');
    await expect(app.getByRole('heading', { level: 1 })).toHaveText('Pending reviews (0)');
    expect(await calls(page, 'bureau.reviews.resolve')).toHaveLength(1);
  });

  test('rejects with feedback: a blank reason cannot be sent, the reason is sent verbatim', async ({
    page,
  }) => {
    const { app } = await open(page, [review('a')]);
    await app.getByRole('button', { name: 'Reject with feedback' }).click();
    const reason = app.getByLabel('Feedback for the agent');
    await expect(reason).toBeFocused();
    const send = app.getByRole('button', { name: 'Send rejection' });
    await expect(send).toBeDisabled();
    await reason.fill('   ');
    await expect(send).toBeDisabled();
    await reason.fill('Use a dry run first');
    await expect(send).toBeEnabled();
    await send.click();
    await expect(app.getByRole('status')).toHaveText('Rejected with feedback.');
    const [call] = await calls(page, 'bureau.reviews.resolve');
    expect(call?.arguments).toEqual({
      id: 'a',
      decision: 'reject',
      round: 0,
      reason: 'Use a dry run first',
    });
  });

  test('keeps a half-typed reason and its focus across a refresh', async ({ page }) => {
    const { app } = await open(page, [review('a')]);
    await app.getByRole('button', { name: 'Reject with feedback' }).click();
    const reason = app.getByLabel('Feedback for the agent');
    await reason.fill('draft');
    const listCalls = async (): Promise<number> => {
      const made = await calls(page, 'bureau.reviews.list');
      return made.length;
    };
    const before = await listCalls();
    await expect.poll(listCalls).toBeGreaterThan(before);
    await expect(reason).toHaveValue('draft');
    await expect(reason).toBeFocused();
  });

  test('refuses a review that was resolved elsewhere, without resolving it again', async ({
    page,
  }) => {
    const { app } = await open(page, [review('a')]);
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as { queueState: { queue: { status: string }[] } }
      ).queueState.queue[0]!.status = 'approved';
    });
    await app.getByRole('button', { name: 'Deny' }).click();
    await expect(
      app.getByText('This review is already approved. It was not decided.'),
    ).toBeVisible();
    expect(await calls(page, 'bureau.reviews.resolve')).toHaveLength(0);
  });

  test('refuses a review whose approval was replaced (a stale round)', async ({ page }) => {
    const { app } = await open(page, [review('a')]);
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as { queueState: { queue: { round: number }[] } }
      ).queueState.queue[0]!.round = 1;
    });
    await app.getByRole('button', { name: 'Approve' }).click();
    await expect(app.getByRole('status')).toContainText('This review changed while you read it.');
    expect(await calls(page, 'bureau.reviews.resolve')).toHaveLength(0);
  });

  test('reports a decision the host refuses, and leaves the review listed', async ({ page }) => {
    const { app } = await open(page, [review('a')]);
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    // A caller who may read reviews but not resolve them: `get` answers, `resolve` is refused.
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.reviews.resolve'] = () => {
        throw new Error('NotFound');
      };
    });
    await app.getByRole('button', { name: 'Approve' }).click();
    await expect(app.getByRole('status')).toContainText('The decision was refused');
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    const resolves = await calls(page, 'bureau.reviews.resolve');
    expect(resolves).toHaveLength(1);
  });

  test('sends the round it displayed, and reports a review that moved on as undecided', async ({
    page,
  }) => {
    const { app } = await open(page, [review('a', { round: 2 })]);
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    // Another resolver re-gates the approval between the app's read and its decision.
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.reviews.resolve'] = () => {
        throw new Error('Conflict: REVIEW_ROUND_CHANGED: now at round 3');
      };
    });
    await app.getByRole('button', { name: 'Approve' }).click();
    await expect(app.getByRole('status')).toContainText('changed while you read it');
    await expect(app.getByRole('status')).not.toContainText('Approved');
    const [call] = await calls(page, 'bureau.reviews.resolve');
    expect(call?.arguments).toEqual({ id: 'a', decision: 'approve', round: 2 });
  });

  test('reports a decision that took effect when only the outcome write failed', async ({
    page,
  }) => {
    const { app } = await open(page, [review('a')]);
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.reviews.resolve'] = () => {
        throw new Error('Conflict: APPROVAL_OUTCOME_NOT_WRITTEN: session write failed');
      };
    });
    await app.getByRole('button', { name: 'Approve' }).click();
    await expect(app.getByRole('status')).toContainText('Approved. Warning');
    await expect(app.getByRole('status')).not.toContainText('refused');
  });

  test('lists a human wait without offering to approve it', async ({ page }) => {
    const wait = {
      id: 'w',
      runId: 'run-w',
      kind: 'human-wait',
      status: 'pending',
      agentName: 'worker',
      requestedAt: 1,
      ageMilliseconds: 1,
      signalName: 'answer',
      prompt: 'Which region?',
    };
    const { app } = await open(page, [wait]);
    await expect(app.getByText('Which region?')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  test('offers no decision for an expired review', async ({ page }) => {
    const expired = review('a');
    (expired.approval.action as Record<string, unknown>)['expiresAt'] = '2020-01-01T00:00:00Z';
    const { app } = await open(page, [expired]);
    await expect(app.getByText('Expired')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await expect(app.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  test('announces a review that was canceled with its run', async ({ page }) => {
    const { app } = await open(page, [review('a'), review('b')]);
    await expect(app.getByRole('heading', { level: 1 })).toHaveText('Pending reviews (2)');
    await page.evaluate(() => {
      (
        window as unknown as { queueState: { queue: { status: string }[] } }
      ).queueState.queue[0]!.status = 'canceled';
    });
    await expect(app.getByRole('status')).toHaveText('1 no longer pending.');
    await expect(app.getByRole('heading', { level: 1 })).toHaveText('Pending reviews (1)');
  });

  test('keeps what it shows when the host stops answering, then reconnects', async ({ page }) => {
    const { app } = await open(page, [review('a')]);
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.reviews.list'] = () => {
        throw new Error('down');
      };
    });
    await expect(app.getByRole('status')).toHaveText('Connection lost. Retrying.');
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.reviews.list'] = () => ({
        reviews: (window as unknown as { queueState: { queue: unknown[] } }).queueState.queue,
      });
    });
    await expect(app.getByRole('status')).toHaveText('Reconnected.');
  });

  test('has no axe violations and honors reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    const { app } = await open(page, [review('a')]);
    await app.getByRole('button', { name: 'Reject with feedback' }).click();
    await expect(app.getByLabel('Feedback for the agent')).toBeVisible();
    const results = await new Axe({ page }).include('iframe').analyze();
    expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    const transition = await frame.evaluate(
      () => getComputedStyle(document.querySelector('button')!).transitionDuration,
    );
    expect(['0s', '0.00001s']).toContain(transition === '' ? '0s' : transition.split(',')[0]);
  });

  test('cannot reach the network, the parent, storage, or the camera', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(HOST_ORIGIN) && !request.url().startsWith('about:')) {
        requests.push(request.url());
      }
    });
    const { app } = await open(page, [review('a')]);
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    const outcome = await frame.evaluate(async () => {
      const reach = async (probe: () => unknown): Promise<string> => {
        try {
          await probe();
          return 'reached';
        } catch {
          return 'blocked';
        }
      };
      return {
        fetch: await reach(() => fetch('https://example.com/steal')),
        parent: await reach(() => parent.document.body),
        storage: await reach(() => localStorage.getItem('x')),
        camera: await reach(() => navigator.mediaDevices.getUserMedia({ video: true })),
      };
    });
    expect(outcome).toEqual({
      fetch: 'blocked',
      parent: 'blocked',
      storage: 'blocked',
      camera: 'blocked',
    });
    expect(requests).toEqual([]);
  });

  test('tears down without deciding anything', async ({ page }) => {
    const { app } = await open(page, [review('a')]);
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(async () => window.referenceHost.teardown());
    await expect(page.locator(`iframe[title="${TITLE}"]`)).toHaveCount(0);
    expect(await calls(page, 'bureau.reviews.resolve')).toHaveLength(0);
  });
});
