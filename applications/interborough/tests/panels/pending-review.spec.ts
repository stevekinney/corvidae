/**
 * COR-910 (2 of 2) — the pending-review app, loaded the way an MCP Apps host loads it: the built
 * `ui://` page in a sandboxed frame under its declared deny-all policy, behind the ext-apps 2.0.x
 * `AppBridge`. Tool calls are answered from fixtures, so the spec proves the page, not the Bureau.
 */
import { default as Axe } from '@axe-core/playwright';
import { pendingReview } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type Page } from '@playwright/test';

import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { startSignedInRefundFixture } from '../../src/host/server-integration/signed-in-refund.test-support.ts';
import { deleteChats, newThreadId, runToEnd } from '../e2e/chat-support.ts';
import { E2E_BASE_URL } from '../e2e/e2e-constants.ts';
import { REMEMBER_APPROVAL_AGENT } from '../e2e/regeneration-proof-agent.ts';
import { bureauCall, waitingReviewOf } from '../e2e/task-support.ts';
import {
  expectFollowsHost,
  firstDurationSeconds,
  hostContextFor,
  REDUCED_MOTION_SECONDS,
  SCHEMES,
  type Scheme,
} from './host-theme.ts';

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
  const built = await buildPanelPage({
    entry: pendingReview.entry.href,
    title: pendingReview.title,
    styles: pendingReview.styles ?? '',
  });
  pageHtml = built.html;
});

const review = (id: string, overrides: Record<string, unknown> = {}) => ({
  source: 'bureau',
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

async function open(
  page: Page,
  reviews: unknown[],
  scheme?: Scheme,
  snapshotOnly = false,
  trustedRefund = false,
) {
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
    {
      html: string;
      csp: McpUiResourceCsp;
      reviews: { id: string }[];
      title: string;
      hostContext: unknown;
      snapshotOnly: boolean;
      trustedRefund: boolean;
    }
  >(
    async ({ html, csp, reviews: queue, title, hostContext, snapshotOnly, trustedRefund }) => {
      const host = window.referenceHost;
      if (snapshotOnly) {
        host.withoutServerTools = true;
        host.toolResult = {
          content: [{ type: 'text', text: 'Opening snapshot' }],
          structuredContent: { reviews: queue },
        };
      }
      const state = { queue: [...queue] as { id: string; status: string }[] };
      Object.assign(window, { queueState: state });
      host.handlers['bureau.reviews.list'] = () => ({
        reviews: state.queue.filter((item) => item.status === 'pending'),
        nextPageToken: null,
        total: state.queue.filter((item) => item.status === 'pending').length,
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
      if (trustedRefund) {
        const metadata = { 'interborough.reviewEligibility': [{ id: 'protected', round: 0 }] };
        host.rawHandlers['bureau.reviews.list'] = () => ({
          content: [],
          structuredContent: {
            reviews: state.queue.filter((item) => item.status === 'pending'),
            nextPageToken: null,
            total: state.queue.filter((item) => item.status === 'pending').length,
          },
          _meta: metadata,
        });
        host.rawHandlers['bureau.reviews.get'] = (args) => ({
          content: [],
          structuredContent: state.queue.find((item) => item.id === args['id']),
          _meta: metadata,
        });
      }
      await host.mount(html, csp, {}, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      reviews: reviews as { id: string }[],
      title: TITLE,
      hostContext: scheme === undefined ? undefined : hostContextFor(scheme),
      snapshotOnly,
      trustedRefund,
    },
  );
  return { errors, app: page.frameLocator(`iframe[title="${TITLE}"]`) };
}

const calls = (page: Page, name: string) =>
  page.evaluate((tool) => window.referenceHost.calls.filter((call) => call.name === tool), name);

test.describe('the pending-review MCP App', () => {
  test('a signed-in reviewer decides a real refund through the sandboxed panel', async ({
    page,
    context,
  }) => {
    const fixture = await startSignedInRefundFixture();
    try {
      const cookie = await fixture.signIn();
      const id = await fixture.requestRefund();
      const [name, ...value] = cookie.split('=');
      await context.addCookies([
        {
          name: name!,
          value: value.join('='),
          domain: 'settings.example',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
      await page.route('https://settings.example/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') {
          await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><title>Reference host</title><script type="module">${hostScript}</script>`,
          });
          return;
        }
        const target = new URL(url.pathname + url.search, fixture.host.url);
        const response = await route.fetch({
          url: target.href,
          headers: { ...(await route.request().allHeaders()), host: 'settings.example' },
        });
        await route.fulfill({ response });
      });
      const resource = await fixture.send('/host/plugins/inspectors/apps/pending-review', {
        headers: { cookie },
      });
      expect(resource.ok()).toBe(true);
      const mounted = (await resource.json()) as { html: string; ui: { csp: McpUiResourceCsp } };
      await page.goto('https://settings.example/');
      await page.evaluate(
        async ({ html, csp, title }) => {
          window.referenceHost.usePendingReviewHost();
          await window.referenceHost.mount(html, csp, {}, title);
        },
        { html: mounted.html, csp: mounted.ui.csp, title: TITLE },
      );
      const app = page.frameLocator(`iframe[title="${TITLE}"]`);
      await expect(app.getByText(/\$42\.00 for order order/)).toBeVisible();
      await app.getByRole('button', { name: 'Approve' }).click();
      await expect(app.getByRole('status')).toHaveText('Approved.');
      const read = await fixture.send('/host/plugins/inspectors/apps/pending-review/tool-calls', {
        method: 'POST',
        headers: { cookie, origin: 'https://settings.example', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'bureau.reviews.get', arguments: { id } }),
      });
      expect(await read.json()).toMatchObject({ structuredContent: { id, status: 'approved' } });
    } finally {
      await fixture.close();
    }
  });
  test('approves a real ordinary review through the mounted panel and host bridge', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('pending-panel-real-approval');
    try {
      await runToEnd(
        request,
        REMEMBER_APPROVAL_AGENT,
        threadId,
        'Record the harmless fixture value',
      );
      const waiting = await waitingReviewOf(request, threadId);
      const displayed = (await bureauCall(request, 'bureau.reviews.get', { id: waiting.id })) as {
        id: string;
        round: number;
        status: string;
      };
      expect(displayed.status).toBe('pending');
      const resource = await request.get(
        `${E2E_BASE_URL}/host/plugins/inspectors/apps/${pendingReview.name}`,
      );
      expect(resource.ok()).toBe(true);
      const mounted = (await resource.json()) as { html: string; ui: { csp: McpUiResourceCsp } };
      const forwarded: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      await page.exposeFunction(
        'forwardPendingReview',
        async (name: string, args: Record<string, unknown>) => {
          forwarded.push({ name, arguments: args });
          const response = await request.post(
            `${E2E_BASE_URL}/host/plugins/inspectors/apps/${pendingReview.name}/tool-calls`,
            { data: { name, arguments: args } },
          );
          const body = (await response.json()) as Record<string, unknown>;
          return Array.isArray(body['content'])
            ? body
            : {
                isError: true,
                content: [{ type: 'text', text: 'The host refused the operation.' }],
              };
        },
      );
      await page.route(`${HOST_ORIGIN}/`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><title>Reference host</title><script type="module">${hostScript}</script>`,
        }),
      );
      await page.goto(`${HOST_ORIGIN}/`);
      await page.evaluate(
        async ({ html, csp, title, tools }) => {
          const host = window.referenceHost;
          const forward = (
            window as unknown as Record<string, (...args: unknown[]) => Promise<never>>
          )['forwardPendingReview']!;
          for (const tool of tools) host.rawHandlers[tool] = (args) => forward(tool, args);
          await host.mount(html, csp, {}, title);
        },
        {
          html: mounted.html,
          csp: mounted.ui.csp,
          title: TITLE,
          tools: pendingReview.allowedTools,
        },
      );
      const app = page.frameLocator(`iframe[title="${TITLE}"]`);
      const section = app.getByRole('region').filter({ hasText: 'remember-proof-mutation' });
      await section.getByRole('button', { name: 'Approve' }).click();
      await expect
        .poll(() => forwarded.filter((call) => call.name === 'bureau.reviews.resolve'))
        .toHaveLength(1);
      expect(
        forwarded.find((call) => call.name === 'bureau.reviews.resolve')?.arguments,
      ).toMatchObject({ id: displayed.id, round: displayed.round, decision: 'approve' });
      await expect
        .poll(
          async () =>
            (
              (await bureauCall(request, 'bureau.reviews.get', { id: displayed.id })) as {
                status: string;
              }
            ).status,
        )
        .toBe('approved');
    } finally {
      await deleteChats([threadId]);
    }
  });

  test('shows an uncorrelated missing-round snapshot read-only', async ({ page }) => {
    const item = review('snapshot');
    delete (item as { round?: number }).round;
    const { app } = await open(page, [item], undefined, true);
    await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(await calls(page, 'bureau.reviews.resolve')).toHaveLength(0);
  });

  test('keeps a protected refund read-only when serverTools is the only authority', async ({
    page,
  }) => {
    const protectedReview = review('protected', {
      effect: {
        kind: 'refund',
        refundId: 'refund-1',
        orderId: 'order-1',
        cents: 4200,
        currency: 'USD',
        status: 'admitted',
      },
    });
    const { app } = await open(page, [protectedReview]);
    await expect(app.getByText(/\$42\.00 for order order-1/)).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(await calls(page, 'bureau.reviews.resolve')).toHaveLength(0);
  });

  test('uses matching trusted-parent eligibility for a protected review', async ({ page }) => {
    const protectedReview = review('protected', {
      effect: {
        kind: 'refund',
        refundId: 'refund-1',
        orderId: 'order-1',
        cents: 4200,
        currency: 'USD',
        status: 'admitted',
      },
    });
    const { app } = await open(page, [protectedReview], undefined, false, true);
    const approve = app.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(app.getByRole('status')).toHaveText('Approved.');
    const [call] = await calls(page, 'bureau.reviews.resolve');
    expect(call?.arguments).toMatchObject({ id: 'protected', round: 0, decision: 'approve' });
  });
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

  test('fences a double click and keyboard activation while a decision is pending', async ({
    page,
  }) => {
    const { app } = await open(page, [review('a')]);
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.reviews.resolve'] = async () => {
        await new Promise<void>((resolve) => {
          Object.assign(window, { releaseReview: resolve });
        });
        return { id: 'a', kind: 'tool-approval', decision: 'approve', receipt: 'applied' };
      };
    });
    const approve = app.getByRole('button', { name: 'Approve' });
    await approve.click();
    await expect
      .poll(async () => {
        const resolved = await calls(page, 'bureau.reviews.resolve');
        return resolved.length;
      })
      .toBe(1);
    await approve.dispatchEvent('click');
    await approve.dispatchEvent('click');
    await approve.dispatchEvent('keydown', { key: 'Enter' });
    expect(await calls(page, 'bureau.reviews.resolve')).toHaveLength(1);
    await page.evaluate(() => (window as unknown as { releaseReview(): void }).releaseReview());
  });

  test('reconciles a lost response before allowing another decision', async ({ page }) => {
    const { app } = await open(page, [review('a')]);
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.reviews.resolve'] = () => {
        (
          window as unknown as { queueState: { queue: { status: string }[] } }
        ).queueState.queue[0]!.status = 'approved';
        throw new Error('response lost');
      };
    });
    await app.getByRole('button', { name: 'Approve' }).click();
    await expect(app.getByRole('status')).toContainText('could not be confirmed');
    await expect
      .poll(async () => {
        const reads = await calls(page, 'bureau.reviews.get');
        return reads.length;
      })
      .toBeGreaterThan(1);
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
    await expect(app.getByText('This review is no longer pending.')).toBeVisible();
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
    await expect(app.getByRole('status')).toContainText('The decision could not be confirmed');
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
      window.referenceHost.rawHandlers['bureau.reviews.resolve'] = () => ({
        isError: true,
        content: [{ type: 'text', text: 'Review changed' }],
        structuredContent: { code: 'Conflict', data: { reason: 'REVIEW_ROUND_CHANGED' } },
      });
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
      window.referenceHost.rawHandlers['bureau.reviews.resolve'] = () => ({
        content: [{ type: 'text', text: 'Decision applied' }],
        structuredContent: {
          id: 'a',
          kind: 'tool-approval',
          decision: 'approve',
          receipt: 'applied',
          warning: 'APPROVAL_OUTCOME_NOT_WRITTEN',
        },
      });
    });
    await app.getByRole('button', { name: 'Approve' }).click();
    await expect(app.getByRole('status')).toContainText('The decision took effect');
    await expect(app.getByRole('status')).not.toContainText('refused');
  });

  test('lists a human wait without offering to approve it', async ({ page }) => {
    const wait = {
      source: 'bureau',
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
        nextPageToken: null,
        total: (window as unknown as { queueState: { queue: unknown[] } }).queueState.queue.length,
      });
    });
    await expect(app.getByRole('status')).toHaveText('Reconnected.');
  });

  for (const scheme of SCHEMES) {
    test(`follows the host's ${scheme} theme and has no axe violations in it`, async ({ page }) => {
      // The system says the other scheme: the host's word is the one the panel follows.
      await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
      const { app } = await open(page, [review('a')], scheme);
      await expect(app.getByRole('heading', { level: 2 })).toBeVisible();
      await expectFollowsHost(app, scheme);
      await app.getByRole('button', { name: 'Reject with feedback' }).click();
      await expect(app.getByLabel('Feedback for the agent')).toBeVisible();
      const results = await new Axe({ page }).include('iframe').analyze();
      expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    });
  }

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
    expect(firstDurationSeconds(transition)).toBeLessThanOrEqual(REDUCED_MOTION_SECONDS);
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
