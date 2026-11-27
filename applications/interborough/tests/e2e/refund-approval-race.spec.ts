import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import type { McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import { buildCheckoutApplication } from '../../scripts/build.ts';
import { designReviewColorScheme } from '../../scripts/environment-configuration.ts';
import { captureForDesignReviewWithPhone } from './design-review-capture.ts';
import { startRefundRace } from './refund-race.test-support.ts';
import { approveReview } from './task-support.ts';

let directory: string;
let buildDirectory: string;
let hostScript: string;

test.beforeAll(async () => {
  directory = createTemporaryDirectory('refund-browser-build');
  buildDirectory = join(directory, 'build');
  await buildCheckoutApplication({ outdir: buildDirectory });
  const bundle = await Bun.build({
    entrypoints: [new URL('../panels/reference-host.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'esm',
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, 'Reference host did not build');
  hostScript = await bundle.outputs[0]!.text();
});
test.afterAll(() => {
  if (directory) removeTemporaryPath(directory);
});

test('hydrates private Reviews without repeating its opening reads', async ({ browser }) => {
  const fixture = await startRefundRace(buildDirectory);
  let context: BrowserContext | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: AggregateError | undefined;
  try {
    const refund = await fixture.requestRefund();
    const cookie = await fixture.signIn(fixture.hosts[0], 'alice');
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'x-refund-fixture-host': '0' },
      viewport: { width: 1280, height: 900 },
      colorScheme: designReviewColorScheme() ?? 'light',
    });
    const [name, ...value] = cookie.split('=');
    await context.addCookies([
      {
        name: name!,
        value: value.join('='),
        url: fixture.origin,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    const reads: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/jsonrpc') return;
      const method = request.postDataJSON()?.method;
      if (method === 'bureau.reviews.list') reads.push(method);
    });
    const response = await page.goto(
      `${fixture.origin}/reviews?review=${encodeURIComponent(`bureau:${refund.reviewId}`)}`,
    );
    expect(response?.headers()['cache-control']).toBe('private, no-store');
    expect(await response?.text()).toContain(refund.reviewId);
    await page.getByRole('radio', { name: /^Done/ }).click();
    await captureForDesignReviewWithPhone(page, {
      route: '/reviews',
      state: 'private-done',
      source: 'refund-approval-race.spec.ts',
    });
    await page.getByRole('radio', { name: /^Waiting/ }).click();
    const pane = page.locator('.ib-reviews__detail');
    await expect(pane).toContainText('$42.00');
    expect(reads).toEqual([]);
    await captureForDesignReviewWithPhone(page, {
      route: '/reviews',
      state: 'private-waiting-detail',
      source: 'refund-approval-race.spec.ts',
    });
    const refreshed = ['pending', 'resolved'].map((status) =>
      page.waitForResponse((candidate) => {
        const request = candidate.request();
        if (request.method() !== 'POST' || new URL(candidate.url()).pathname !== '/jsonrpc')
          return false;
        const body = request.postDataJSON();
        return body?.method === 'bureau.reviews.list' && body.params?.status === status;
      }),
    );
    const [responses] = await Promise.all([Promise.all(refreshed), approveReview(pane)]);
    await expect.poll(() => fixture.proxy.calls.length).toBe(1);
    await expect.poll(() => fixture.proxy.calls[0]?.finished).toBeDefined();
    expect(fixture.proxy.calls[0]?.input).toMatchObject({
      id: refund.reviewId,
      round: 0,
      decision: 'approve',
    });
    expect(fixture.proxy.calls[0]?.status).toBe(200);
    expect(fixture.proxy.calls[0]?.response).toMatchObject({
      result: { id: refund.reviewId, decision: 'approve', receipt: 'applied' },
    });
    for (const response of responses) {
      expect(response.status()).toBe(200);
      expect(await response.finished()).toBeNull();
    }
    await fixture.proxy.drain();
    await page.getByRole('button', { name: 'Quick settings' }).click();
    await captureForDesignReviewWithPhone(page, {
      route: '/reviews',
      state: 'private-quick-settings',
      source: 'refund-approval-race.spec.ts',
    });
    const navigation = page.waitForResponse(
      (candidate) =>
        candidate.request().isNavigationRequest() &&
        new URL(candidate.url()).pathname === '/settings',
    );
    const plugins = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'GET' &&
        new URL(candidate.url()).pathname === '/host/plugins',
    );
    const [settingsResponse, pluginsResponse] = await Promise.all([
      navigation,
      plugins,
      page.getByRole('link', { name: 'All settings' }).click(),
    ]);
    expect(settingsResponse.status(), 'Settings document response').toBe(200);
    expect(pluginsResponse.status(), 'Settings shell plugins response').toBe(200);
    expect(await pluginsResponse.finished(), 'Settings shell plugins response body').toBeNull();
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
    await fixture.proxy.drain();
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanup: unknown[] = [];
    try {
      await context?.close();
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await fixture.close();
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      cleanupFailure = new AggregateError(
        primaryFailure === undefined ? cleanup : [primaryFailure, ...cleanup],
        'Reviews hydration fixture cleanup failed',
      );
  }
  if (cleanupFailure) throw cleanupFailure;
  if (primaryFailure !== undefined) throw primaryFailure;
});

for (const distinctOwners of [false, true]) {
  for (const scenario of ['reviews', 'panel', 'deny', 'regate'] as const) {
    test(`${distinctOwners ? 'distinct-owner reviewers' : 'same-owner control'}: ${scenario} claims first`, async ({
      browser,
    }, testInfo) => {
      const fixture = await startRefundRace(buildDirectory, {
        regate: scenario === 'regate',
        distinctOwners,
      });
      const contexts: BrowserContext[] = [];
      const pages: Page[] = [];
      let panelMounted = false;
      let primaryFailure: unknown;
      let cleanupFailure: AggregateError | undefined;
      try {
        fixture.proxy.setHostScript(hostScript);
        const refund = await fixture.requestRefund();
        const cookies = [
          await fixture.signIn(fixture.hosts[0], 'alice'),
          await fixture.signIn(fixture.hosts[1], 'bob'),
        ];
        for (const index of [0, 1] as const) {
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            extraHTTPHeaders: { 'x-refund-fixture-host': String(index) },
          });
          contexts.push(context);
          const [name, ...value] = cookies[index]!.split('=');
          await context.addCookies([
            {
              name: name!,
              value: value.join('='),
              url: fixture.origin,
              secure: true,
              httpOnly: true,
              sameSite: 'Lax',
            },
          ]);
          pages.push(await context.newPage());
        }
        const reviews = pages[0]!;
        await reviews.goto(
          `${fixture.origin}/reviews?review=${encodeURIComponent(`bureau:${refund.reviewId}`)}`,
        );
        const pane = reviews.locator('.ib-reviews__detail');
        await expect(pane).toContainText('order');
        await expect(pane).toContainText('$42.00');
        const panelPage = pages[1]!;
        const resource = await fixture.send(
          fixture.hosts[1],
          '/host/plugins/inspectors/apps/pending-review',
          { headers: { cookie: cookies[1]! } },
        );
        expect(resource.status).toBe(200);
        const mounted = (await resource.json()) as { html: string; ui: { csp: McpUiResourceCsp } };
        await panelPage.goto(`${fixture.origin}/__refund-fixture/panel`);
        await panelPage.evaluate(
          async ({ html, csp }) => {
            window.referenceHost.usePendingReviewHost();
            await window.referenceHost.mount(html, csp, {}, 'Pending reviews');
          },
          { html: mounted.html, csp: mounted.ui.csp },
        );
        panelMounted = true;
        const panel = panelPage.frameLocator('iframe[title="Pending reviews"]');
        await expect(panel.getByText(/\$42\.00 for order order/)).toBeVisible();
        expect(await fixture.provider.refunds()).toEqual([]);
        for (const host of fixture.hosts) {
          const response = await fetch(`${host.control}/arm`);
          expect(response.ok).toBe(true);
        }
        if (scenario === 'reviews' || scenario === 'panel')
          for (const host of fixture.hosts) {
            const response = await fetch(`${host.control}/arm-provider`);
            expect(response.ok).toBe(true);
          }
        const clicks = Promise.all([
          scenario === 'deny'
            ? pane.getByRole('button', { name: 'Deny' }).click()
            : approveReview(pane),
          panel.getByRole('button', { name: 'Approve' }).click(),
        ]);
        fixture.proxy.setPhase('waiting-for-claims');
        const status = async (index: 0 | 1) => {
          const response = await fetch(`${fixture.hosts[index].control}/status`);
          return (await response.json()) as {
            claimArrived: boolean;
            claimCommitted: boolean;
            providerSubmitArrived: boolean;
            providerAccepted: boolean;
            providerSubmitCalls: number;
          };
        };
        await expect
          .poll(async () => {
            const states = await Promise.all([status(0), status(1)]);
            return states.every((item) => item.claimArrived);
          })
          .toBe(true);
        const first = scenario === 'panel' ? 1 : 0;
        const second = first === 0 ? 1 : 0;
        await fetch(`${fixture.hosts[first].control}/claim`);
        await expect
          .poll(async () => {
            const state = await status(first);
            return state.claimCommitted;
          })
          .toBe(true);
        if (scenario === 'regate') {
          await fetch(`${fixture.hosts[first].control}/resume`);
          await expect
            .poll(() => fixture.proxy.calls.find((call) => call.host === first)?.finished)
            .toBeDefined();
          expect(fixture.proxy.calls.find((call) => call.host === first)?.response).toMatchObject({
            result: { id: refund.reviewId, decision: 'approve', receipt: 'superseded' },
          });
        }
        await fetch(`${fixture.hosts[second].control}/claim`);
        if (scenario === 'regate') {
          await expect
            .poll(async () => {
              const state = await status(second);
              return state.claimCommitted;
            })
            .toBe(true);
          await fetch(`${fixture.hosts[second].control}/resume`);
        }
        await expect
          .poll(() => fixture.proxy.calls.find((call) => call.host === second)?.finished)
          .toBeDefined();
        const losing = fixture.proxy.calls.find((call) => call.host === second)!;
        expect(losing.status).toBe(200);
        if (second === 0)
          expect(losing.response).toMatchObject({ error: { data: { weftCode: 'Conflict' } } });
        else
          expect(losing.response).toMatchObject({
            isError: true,
            structuredContent: { code: 'Conflict' },
          });
        await expect
          .poll(() =>
            fixture.proxy.reads.some((read) => {
              const body = read.response as
                | {
                    result?: { id?: string; round?: number };
                    structuredContent?: { id?: string; round?: number };
                  }
                | undefined;
              const review = body?.result ?? body?.structuredContent;
              return (
                read.host === second &&
                read.input['id'] === refund.reviewId &&
                read.started > losing.finished! &&
                read.finished !== undefined &&
                read.status === 200 &&
                review?.id === refund.reviewId &&
                review?.round === (scenario === 'regate' ? 1 : 0)
              );
            }),
          )
          .toBe(true);
        expect(await fixture.provider.refunds()).toEqual([]);
        await fetch(`${fixture.hosts[first].control}/resume`);
        if (scenario === 'reviews' || scenario === 'panel') {
          await expect
            .poll(async () => {
              const state = await status(first);
              return state.providerSubmitArrived;
            })
            .toBe(true);
          const firstStatus = await status(first);
          const secondStatus = await status(second);
          expect(firstStatus.providerSubmitCalls).toBe(1);
          expect(secondStatus.providerSubmitCalls).toBe(0);
          expect(await fixture.provider.refunds()).toEqual([]);
          expect(await fixture.provider.submissions()).toBe(0);
          expect(await fixture.ledger.get(refund.refundId)).toMatchObject({ status: 'submitting' });
          expect(fixture.proxy.calls.find((call) => call.host === first)?.finished).toBeUndefined();
          const send = await fetch(`${fixture.hosts[first].control}/provider-send`);
          expect(send.ok).toBe(true);
          await expect
            .poll(async () => {
              const state = await status(first);
              return state.providerAccepted;
            })
            .toBe(true);
          expect(await fixture.provider.refunds()).toHaveLength(1);
          expect(await fixture.provider.submissions()).toBe(1);
          expect(await fixture.ledger.get(refund.refundId)).toMatchObject({ status: 'submitting' });
          expect(fixture.proxy.calls.find((call) => call.host === first)?.finished).toBeUndefined();
          const reply = await fetch(`${fixture.hosts[first].control}/provider-reply`);
          expect(reply.ok).toBe(true);
        }
        await clicks;
        await expect
          .poll(() => fixture.proxy.calls.find((call) => call.host === first)?.finished)
          .toBeDefined();
        const accepted = fixture.proxy.calls.find((call) => call.host === first)!;
        expect(accepted.status).toBe(200);
        if (first === 0)
          expect(accepted.response).toMatchObject({
            result: {
              id: refund.reviewId,
              decision: scenario === 'deny' ? 'deny' : 'approve',
              receipt: scenario === 'regate' ? 'superseded' : 'applied',
            },
          });
        else
          expect(accepted.response).toMatchObject({
            structuredContent: { id: refund.reviewId, decision: 'approve', receipt: 'applied' },
          });
        expect(fixture.proxy.calls).toHaveLength(2);
        for (const call of fixture.proxy.calls) {
          expect(call.input).toMatchObject({
            id: refund.reviewId,
            round: 0,
            decision: scenario === 'deny' && call.host === 0 ? 'deny' : 'approve',
          });
          if (call.host === 0) expect(call.input).toMatchObject({ decisionSurface: 'reviews' });
          else expect(call.input).not.toHaveProperty('decisionSurface');
        }
        await expect
          .poll(async () => {
            const value = await fixture.ledger.get(refund.refundId);
            return value?.status;
          })
          .toBe(
            scenario === 'deny'
              ? 'failed'
              : scenario === 'regate'
                ? 'admitted'
                : 'provider-pending',
          );
        const saved = await fixture.ledger.get(refund.refundId);
        if (scenario === 'deny' || scenario === 'regate')
          expect(await fixture.provider.refunds()).toEqual([]);
        else
          expect(await fixture.provider.refunds()).toMatchObject([
            { paymentReference: 'charge', amount: 4200, currency: 'USD', receipt: saved?.receipt },
          ]);
        if (scenario === 'reviews' || scenario === 'panel')
          expect(await fixture.provider.submissions()).toBe(1);
        const evidence = await fixture.durableEvidence(refund.reviewId);
        expect(evidence.claims).toHaveLength(scenario === 'regate' ? 0 : 1);
        expect(evidence.tasks).toHaveLength(1);
        expect(evidence.starts).toHaveLength(1);
        expect(evidence.decisions).toHaveLength(scenario === 'regate' ? 0 : 1);
        if (scenario !== 'regate')
          expect(evidence.decisions[0]).toMatchObject({
            decision: scenario === 'deny' ? 'deny' : 'approve',
            decidedBy: distinctOwners
              ? `owner:refund-reviewer-${scenario === 'panel' ? 'bob' : 'alice'}`
              : 'owner:admin',
            reviewerProvenance: {
              actorId: scenario === 'panel' ? 'bob' : 'alice',
              transport: scenario === 'panel' ? 'mcp' : 'jsonRpcHttp',
              ...(scenario === 'panel' ? { panelUri: 'ui://inspectors/pending-review/v1' } : {}),
            },
            ...(scenario !== 'panel' ? { decisionSurface: 'reviews' } : {}),
          });
        if (scenario === 'panel')
          expect(evidence.decisions[0]).not.toHaveProperty('decisionSurface');
        if (scenario === 'regate') {
          await expect
            .poll(() =>
              fixture.proxy.reads.some((read) => {
                const body = read.response as
                  | { result?: { reviews?: { id?: string; round?: number; status?: string }[] } }
                  | undefined;
                return (
                  read.host === 0 &&
                  read.name === 'bureau.reviews.list' &&
                  read.started > accepted.finished! &&
                  read.status === 200 &&
                  body?.result?.reviews?.some(
                    (review) =>
                      review.id === refund.reviewId &&
                      review.round === 1 &&
                      review.status === 'pending',
                  )
                );
              }),
            )
            .toBe(true);
          for (const index of [0, 1] as const) {
            const response = await fixture.send(fixture.hosts[index], '/bureau/jsonrpc', {
              method: 'POST',
              headers: {
                cookie: cookies[index]!,
                origin: fixture.origin,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'bureau.reviews.get',
                params: { id: refund.reviewId },
              }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
              result: { id: refund.reviewId, round: 1, status: 'pending' },
            });
          }
          await expect(panel.getByText(/\$42\.00 for order order/)).toBeVisible();
          await expect(panel.getByRole('button', { name: 'Approve' })).toBeEnabled();
          await expect(pane).toContainText('$42.00');
          await expect(pane.getByRole('button', { name: 'Approve' })).toBeEnabled();
        } else {
          await expect(
            panel.getByRole('heading', { name: 'Nothing is waiting for a decision.' }),
          ).toBeVisible();
          fixture.proxy.setPhase('reviews-done-navigation');
          await reviews.goto(
            `${fixture.origin}/reviews?tab=done&review=${encodeURIComponent(`bureau:${refund.reviewId}`)}`,
          );
          await expect(reviews.locator('.ib-reviews__detail')).toContainText(
            scenario === 'deny' ? 'Denied' : 'Approved',
          );
        }
        if (scenario === 'deny' || scenario === 'regate')
          expect(await fixture.provider.refunds()).toEqual([]);
        fixture.proxy.setPhase('panel-teardown');
        await panelPage.evaluate(() => window.referenceHost.teardown());
        panelMounted = false;
        fixture.proxy.setPhase('drain');
        await fixture.proxy.drain();
      } catch (error) {
        primaryFailure = error;
        throw error;
      } finally {
        fixture.proxy.setPhase('cleanup');
        const cleanup: unknown[] = [];
        for (const host of fixture.hosts) {
          for (const path of ['claim', 'resume', 'provider-send', 'provider-reply']) {
            try {
              await fetch(`${host.control}/${path}`);
            } catch (error) {
              cleanup.push(error);
            }
          }
        }
        if (panelMounted) {
          try {
            await pages[1]!.evaluate(() => window.referenceHost.teardown());
          } catch (error) {
            cleanup.push(error);
          }
        }
        for (const context of contexts) {
          try {
            await context.close();
          } catch (error) {
            cleanup.push(error);
          }
        }
        try {
          await fixture.close();
        } catch (error) {
          cleanup.push(error);
        }
        try {
          await testInfo.attach('refund-race-client-cancellations', {
            body: JSON.stringify(
              fixture.proxy.cancellations.map((error) => ({
                ...(JSON.parse(error.message) as Record<string, unknown>),
                cause: String(error.cause),
              })),
            ),
            contentType: 'application/json',
          });
        } catch (error) {
          cleanup.push(error);
        }
        if (cleanup.length) {
          await testInfo.attach('refund-race-cleanup-errors', {
            body: cleanup.map(String).join('\n'),
            contentType: 'text/plain',
          });
          if (primaryFailure === undefined)
            cleanupFailure = new AggregateError(cleanup, 'Refund race cleanup failed');
        }
      }
      if (cleanupFailure) throw cleanupFailure;
    });
  }
}

for (const surface of ['reviews', 'panel'] as const) {
  test(`same-owner control: ${surface} reports a failed outcome write`, async ({
    browser,
  }, testInfo) => {
    const fixture = await startRefundRace(buildDirectory);
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let panelMounted = false;
    let primaryFailure: unknown;
    let cleanupFailure: AggregateError | undefined;
    try {
      fixture.proxy.setHostScript(hostScript);
      const refund = await fixture.requestRefund();
      const index = surface === 'reviews' ? 0 : 1;
      const host = fixture.hosts[index];
      const cookie = await fixture.signIn(host, index === 0 ? 'alice' : 'bob');
      const read = () =>
        fixture.send(host, '/bureau/jsonrpc', {
          method: 'POST',
          headers: { cookie, origin: fixture.origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'bureau.reviews.get',
            params: { id: refund.reviewId },
          }),
        });
      const initialResponse = await read();
      const initial = (await initialResponse.json()) as { result: { sessionId: string } };
      expect(initial.result.sessionId).toBeTruthy();
      const arm = await fetch(
        `${host.control}/arm-outcome?session=${encodeURIComponent(initial.result.sessionId)}`,
      );
      expect(arm.ok).toBe(true);
      const probe = await fetch(`${host.control}/probe-metadata`);
      expect(probe.ok).toBe(true);
      const initialStatus = await fetch(`${host.control}/status`);
      expect(await initialStatus.json()).toMatchObject({
        outcomeFailures: 0,
        metadataPasses: 1,
      });
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { 'x-refund-fixture-host': String(index) },
      });
      const [name, ...value] = cookie.split('=');
      await context.addCookies([
        {
          name: name!,
          value: value.join('='),
          url: fixture.origin,
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
      page = await context.newPage();
      if (surface === 'reviews') {
        await page.goto(
          `${fixture.origin}/reviews?review=${encodeURIComponent(`bureau:${refund.reviewId}`)}`,
        );
        const pane = page.locator('.ib-reviews__detail');
        await expect(pane).toContainText('$42.00');
        fixture.proxy.setPhase('warning-decision');
        await approveReview(pane);
        await expect(page.getByText('The decision took effect', { exact: true })).toBeVisible();
      } else {
        const resource = await fixture.send(host, '/host/plugins/inspectors/apps/pending-review', {
          headers: { cookie },
        });
        expect(resource.status).toBe(200);
        const mounted = (await resource.json()) as { html: string; ui: { csp: McpUiResourceCsp } };
        await page.goto(`${fixture.origin}/__refund-fixture/panel`);
        await page.evaluate(
          async ({ html, csp }) => {
            window.referenceHost.usePendingReviewHost();
            await window.referenceHost.mount(html, csp, {}, 'Pending reviews');
          },
          { html: mounted.html, csp: mounted.ui.csp },
        );
        panelMounted = true;
        const panel = page.frameLocator('iframe[title="Pending reviews"]');
        await expect(panel.getByText(/\$42\.00 for order order/)).toBeVisible();
        await panel.getByRole('button', { name: 'Approve' }).click();
        await expect(panel.getByRole('status')).toContainText('The decision took effect');
      }
      await expect.poll(() => fixture.proxy.calls[0]?.finished).toBeDefined();
      expect(fixture.proxy.calls).toHaveLength(1);
      const call = fixture.proxy.calls[0]!;
      expect(call.input).toMatchObject({ id: refund.reviewId, round: 0, decision: 'approve' });
      expect(call.status).toBe(200);
      expect(call.response).toMatchObject(
        surface === 'reviews'
          ? {
              result: {
                id: refund.reviewId,
                receipt: 'applied',
                warning: 'APPROVAL_OUTCOME_NOT_WRITTEN',
              },
            }
          : {
              structuredContent: {
                id: refund.reviewId,
                receipt: 'applied',
                warning: 'APPROVAL_OUTCOME_NOT_WRITTEN',
              },
            },
      );
      const faultResponse = await fetch(`${host.control}/status`);
      const fault = (await faultResponse.json()) as {
        outcomeFailures: number;
        metadataPasses: number;
      };
      expect(fault.outcomeFailures).toBeGreaterThan(0);
      expect(fault.metadataPasses).toBe(1);
      const status = await read();
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        result: { id: refund.reviewId, status: 'approved', effect: { status: 'provider-pending' } },
      });
      expect(await fixture.provider.refunds()).toHaveLength(1);
      const evidence = await fixture.durableEvidence(refund.reviewId);
      expect(evidence.decisions).toHaveLength(1);
      if (panelMounted) {
        await page.evaluate(() => window.referenceHost.teardown());
        panelMounted = false;
      }
      if (surface !== 'reviews') fixture.proxy.setPhase('drain');
      await fixture.proxy.drain();
      for (const cancellation of fixture.proxy.cancellations) {
        const diagnostic = JSON.parse(cancellation.message) as { started: number; phase: string };
        expect(diagnostic.phase).toBe('warning-decision');
        expect(
          fixture.proxy.reads.some(
            (read) =>
              read.host === 0 &&
              read.name === 'bureau.reviews.list' &&
              read.started > diagnostic.started &&
              read.status === 200 &&
              read.finished !== undefined,
          ),
        ).toBe(true);
      }
      expect(fixture.proxy.calls).toHaveLength(1);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup: unknown[] = [];
      if (panelMounted && page) {
        try {
          await page.evaluate(() => window.referenceHost.teardown());
        } catch (error) {
          cleanup.push(error);
        }
      }
      if (context) {
        try {
          await context.close();
        } catch (error) {
          cleanup.push(error);
        }
      }
      try {
        await fixture.close();
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await testInfo.attach('refund-warning-client-cancellations', {
          body: JSON.stringify(
            fixture.proxy.cancellations.map((error) => ({
              ...(JSON.parse(error.message) as Record<string, unknown>),
              cause: String(error.cause),
            })),
          ),
          contentType: 'application/json',
        });
      } catch (error) {
        cleanup.push(error);
      }
      if (cleanup.length) {
        await testInfo.attach('refund-warning-cleanup-errors', {
          body: cleanup.map(String).join('\n'),
          contentType: 'text/plain',
        });
        if (primaryFailure === undefined)
          cleanupFailure = new AggregateError(cleanup, 'Refund warning cleanup failed');
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  });
}

test('replaces private refund details when the signed-in actor changes', async ({
  browser,
}, testInfo) => {
  const fixture = await startRefundRace(buildDirectory);
  let context: BrowserContext | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: AggregateError | undefined;
  try {
    const refund = await fixture.requestRefund();
    const host = fixture.hosts[0];
    const alice = await fixture.signIn(host, 'alice');
    const foreign = await fixture.signIn(host, 'other-merchant');
    const setCookie = async (cookie: string) => {
      const [name, ...value] = cookie.split('=');
      await context!.addCookies([
        {
          name: name!,
          value: value.join('='),
          url: fixture.origin,
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    };
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'x-refund-fixture-host': '0' },
    });
    await setCookie(alice);
    const page = await context.newPage();
    const alicePrincipal = await fixture.send(host, '/api/v1/principal', {
      headers: { cookie: alice },
    });
    expect(alicePrincipal.status).toBe(200);
    const aliceIdentity = (await alicePrincipal.json()) as {
      workspace: { workspaceId: string; actorId: string; membershipRevision?: string };
    };
    expect(aliceIdentity).toMatchObject({ workspace: { actorId: 'alice' } });
    fixture.proxy.allowOldIdentityContextCancellation(
      encodeURIComponent(
        JSON.stringify([
          aliceIdentity.workspace.workspaceId,
          aliceIdentity.workspace.actorId,
          ...(aliceIdentity.workspace.membershipRevision === undefined
            ? []
            : [aliceIdentity.workspace.membershipRevision]),
        ]),
      ),
    );
    const foreignPrincipal = await fixture.send(host, '/api/v1/principal', {
      headers: { cookie: foreign },
    });
    expect(foreignPrincipal.status).toBe(200);
    const foreignIdentity = (await foreignPrincipal.json()) as {
      workspace: { workspaceId: string; actorId: string; membershipRevision?: string };
    };
    expect(foreignIdentity.workspace.actorId).toBe('other-merchant');
    const expectedIdentity = encodeURIComponent(
      JSON.stringify([
        foreignIdentity.workspace.workspaceId,
        foreignIdentity.workspace.actorId,
        ...(foreignIdentity.workspace.membershipRevision === undefined
          ? []
          : [foreignIdentity.workspace.membershipRevision]),
      ]),
    );
    await page.goto(
      `${fixture.origin}/reviews?review=${encodeURIComponent(`bureau:${refund.reviewId}`)}`,
    );
    const pane = page.locator('.ib-reviews__detail');
    await expect(pane).toContainText('order');
    await expect(pane).toContainText('$42.00');
    await expect(pane.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    const foreignList = page.waitForResponse((response) => {
      const request = response.request();
      return (
        new URL(response.url()).pathname === '/jsonrpc' &&
        response.status() === 200 &&
        request.headers()['x-interborough-expected-identity'] === expectedIdentity &&
        request.postDataJSON()?.method === 'bureau.reviews.list'
      );
    });
    await setCookie(foreign);
    fixture.proxy.setPhase('identity-change');
    const principalResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/principal' && response.status() === 200,
    );
    await page.evaluate(() => {
      if (document.visibilityState !== 'visible') throw new Error('The page is not visible');
      window.dispatchEvent(new Event('focus'));
    });
    const principal = await principalResponse;
    expect(await principal.json()).toMatchObject({
      workspace: { actorId: 'other-merchant' },
    });
    await expect(page.getByTestId('review-gone')).toBeVisible();
    await expect(page.getByRole('alert', { name: 'Couldn’t load reviews' })).toHaveCount(0);
    await expect(page.getByText('$42.00', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    const foreignListResponse = await foreignList;
    expect(await foreignListResponse.json()).toMatchObject({ result: { reviews: [], total: 0 } });
    expect(fixture.proxy.calls).toEqual([]);
    const evidence = await fixture.durableEvidence(refund.reviewId);
    expect(evidence.claims).toEqual([]);
    expect(evidence.decisions).toEqual([]);
    expect(await fixture.provider.submissions()).toBe(0);
    expect(await fixture.provider.refunds()).toEqual([]);
    await fixture.proxy.drain();
    await testInfo.attach('refund-identity-client-cancellations', {
      body: JSON.stringify(
        fixture.proxy.cancellations.map((error) => ({
          message: error.message,
          cause: String(error.cause),
        })),
      ),
      contentType: 'application/json',
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanup: unknown[] = [];
    if (context) {
      try {
        await context.close();
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await fixture.close();
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length) {
      await testInfo.attach('refund-identity-cleanup-errors', {
        body: cleanup.map(String).join('\n'),
        contentType: 'text/plain',
      });
      if (primaryFailure === undefined)
        cleanupFailure = new AggregateError(cleanup, 'Refund identity cleanup failed');
    }
  }
  if (cleanupFailure) throw cleanupFailure;
});
