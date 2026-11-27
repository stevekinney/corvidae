import { rethrow } from '@lostgradient/testing/module-scope-scenario';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect, it } from 'bun:test';
import { format } from 'node:util';
import { startRefundRace } from '../../../tests/e2e/refund-race.test-support.ts';
import { refundScenario, releaseRefundOnHang } from './refund-scenario.test-support.ts';

const scenario1 = await refundScenario(async (onHang) => {
  const fixture = await startRefundRace('build', { onHang, distinctOwners: true });
  releaseRefundOnHang(onHang, fixture);
  try {
    const host = fixture.hosts[0];
    const refund = await fixture.requestRefund();
    const machine = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
        method: 'POST',
        headers: { 'x-api-key': 'machine', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await response.json()) as { result?: unknown; error?: unknown };
    };
    const replay = await machine('demo.refunds.request', {
      commandId: refund.commandId,
      orderId: 'order',
      cents: 4200,
    });
    const status = await machine('demo.refunds.get', { refundId: refund.refundId });
    const requesterList = await machine('bureau.reviews.list', { status: 'pending' });
    const requesterRead = await machine('bureau.reviews.get', { id: refund.reviewId });
    const requesterDecision = await machine('bureau.reviews.resolve', {
      id: refund.reviewId,
      round: 0,
      decision: 'approve',
    });
    const panel = async (
      cookie: string,
      csrfToken: string,
      name: string,
      arguments_: Record<string, unknown>,
    ) => {
      const response = await fixture.send(
        host,
        '/host/plugins/inspectors/apps/pending-review/tool-calls',
        {
          method: 'POST',
          headers: {
            cookie,
            origin: fixture.origin,
            'x-csrf-token': csrfToken,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name, arguments: arguments_ }),
        },
      );
      const body = response.ok
        ? ((await response.json()) as { isError?: boolean; structuredContent?: { id?: string } })
        : undefined;
      const refusalText = response.ok ? undefined : await response.text();
      return {
        status: response.status,
        isError: body?.isError,
        id: body?.structuredContent?.id,
        body,
        refusalText,
      };
    };
    const foreignCookie = await fixture.signIn(host, 'other-merchant');
    const csrfFor = async (cookie: string) => {
      const response = await fixture.send(host, '/auth/session', { headers: { cookie } });
      expect(response.status).toBe(200);
      const session = (await response.json()) as { csrfToken: string };
      expect(session.csrfToken).toBeTruthy();
      return session.csrfToken;
    };
    const foreignCsrf = await csrfFor(foreignCookie);
    const foreignRead = await panel(foreignCookie, foreignCsrf, 'bureau.reviews.get', {
      id: refund.reviewId,
    });
    const foreignDecision = await panel(foreignCookie, foreignCsrf, 'bureau.reviews.resolve', {
      id: refund.reviewId,
      round: 0,
      decision: 'approve',
    });
    const unentitledCookie = await fixture.signIn(host, 'unentitled');
    const unentitledCsrf = await csrfFor(unentitledCookie);
    const unentitledList = await panel(unentitledCookie, unentitledCsrf, 'bureau.reviews.list', {
      status: 'pending',
    });
    const unentitledRead = await panel(unentitledCookie, unentitledCsrf, 'bureau.reviews.get', {
      id: refund.reviewId,
    });
    const unentitledDecision = await panel(
      unentitledCookie,
      unentitledCsrf,
      'bureau.reviews.resolve',
      {
        id: refund.reviewId,
        round: 0,
        decision: 'approve',
      },
    );
    const forgedSurface = await panel(unentitledCookie, unentitledCsrf, 'bureau.reviews.resolve', {
      id: refund.reviewId,
      round: 0,
      decision: 'approve',
      decisionSurface: 'reviews',
    });
    const reviewerCookie = await fixture.signIn(host, 'bob');
    const reviewerCsrf = await csrfFor(reviewerCookie);
    const reviewerRead = await panel(reviewerCookie, reviewerCsrf, 'bureau.reviews.get', {
      id: refund.reviewId,
    });
    await fetch(`${host.control}/revoke`);
    const revoked = await panel(reviewerCookie, reviewerCsrf, 'bureau.reviews.get', {
      id: refund.reviewId,
    });
    const revokedDecision = await panel(reviewerCookie, reviewerCsrf, 'bureau.reviews.resolve', {
      id: refund.reviewId,
      round: 0,
      decision: 'approve',
    });
    expect(replay.result).toMatchObject({ refundId: refund.refundId });
    expect(status.result).toMatchObject({ refundId: refund.refundId, status: 'awaiting-approval' });
    expect(requesterList.result).toMatchObject({ reviews: [] });
    expect(requesterRead.result).toBeUndefined();
    expect(requesterDecision.result).toBeUndefined();
    expect(foreignRead.isError).toBe(true);
    expect(foreignDecision.status).toBe(403);
    expect(foreignDecision.refusalText).toBe(
      JSON.stringify({ error: 'forbidden', message: 'This panel may not decide that review.' }),
    );
    expect(JSON.stringify(unentitledList.body)).not.toContain(refund.reviewId);
    expect(unentitledRead.isError).toBe(true);
    expect(unentitledDecision.status).toBe(403);
    expect(forgedSurface.status).toBe(403);
    expect(reviewerRead.id).toBe(refund.reviewId);
    expect(revoked.status !== 200 || revoked.isError === true).toBe(true);
    expect(revokedDecision.status !== 200 || revokedDecision.isError === true).toBe(true);
    const evidence = await fixture.durableEvidence(refund.reviewId);
    expect(evidence.claims).toEqual([]);
    expect(evidence.decisions).toEqual([]);
    expect(await fixture.provider.refunds()).toEqual([]);
  } finally {
    await fixture.close();
  }
});
it('separates requester receipt access from protected reviewer access', () => rethrow(scenario1));

for (const row of ['reviews', 'panel'] as const) {
  const surface = row;
  const scenario2 = await refundScenario(async (onHang) => {
    const fixture = await startRefundRace('build', { onHang });
    releaseRefundOnHang(onHang, fixture);
    const host = fixture.hosts[0];
    try {
      const refund = await fixture.requestRefund();
      const start = await fixture.ledger.getStart(refund.refundId);
      expect(start).toBeDefined();
      const metadata = await fixture.approvalMetadata(start!.runId);
      expect(metadata?.authority).toMatchObject({
        workspace: { actorId: 'api-key-caller', authorizingOwner: 'owner:admin' },
      });
      const cookie = await fixture.signIn(host, 'alice');
      const session = await fixture.send(host, '/auth/session', { headers: { cookie } });
      expect(session.status).toBe(200);
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      expect(csrfToken).toBeTruthy();
      const call = async (name: string, arguments_: Record<string, unknown>) => {
        const response = await fixture.send(
          host,
          surface === 'reviews'
            ? '/bureau/jsonrpc'
            : '/host/plugins/inspectors/apps/pending-review/tool-calls',
          {
            method: 'POST',
            headers: {
              cookie,
              origin: fixture.origin,
              'x-csrf-token': csrfToken,
              'content-type': 'application/json',
            },
            body: JSON.stringify(
              surface === 'reviews'
                ? { jsonrpc: '2.0', id: 1, method: name, params: arguments_ }
                : { name, arguments: arguments_ },
            ),
          },
        );
        return { status: response.status, body: await response.json() };
      };
      const before = await call('bureau.reviews.get', { id: refund.reviewId });
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject(
        surface === 'reviews'
          ? { result: { id: refund.reviewId, round: 0, status: 'pending' } }
          : { structuredContent: { id: refund.reviewId, round: 0, status: 'pending' } },
      );
      const arm = await fetch(`${host.control}/arm`);
      expect(arm.ok).toBe(true);
      const decision = call('bureau.reviews.resolve', {
        id: refund.reviewId,
        round: 0,
        decision: 'approve',
      });
      const status = async () => {
        const response = await fetch(`${host.control}/status`);
        return (await response.json()) as {
          claimArrived: boolean;
          claimCommitted: boolean;
          providerSubmitCalls: number;
        };
      };
      await waitUntil(
        async () => {
          const state = await status();
          return state.claimArrived;
        },
        {
          message: 'review decision arrived',
        },
      );
      const claim = await fetch(`${host.control}/claim`);
      expect(claim.ok).toBe(true);
      await waitUntil(
        async () => {
          const state = await status();
          return state.claimCommitted;
        },
        {
          message: 'review decision claimed',
        },
      );
      const revoke = await fetch(`${host.control}/revoke-requester`);
      expect(revoke.ok).toBe(true);
      const currentSession = await fixture.send(host, '/auth/session', { headers: { cookie } });
      expect(currentSession.status).toBe(200);
      const current = await call('bureau.reviews.get', { id: refund.reviewId });
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject(
        surface === 'reviews'
          ? { result: { id: refund.reviewId, status: 'pending' } }
          : { structuredContent: { id: refund.reviewId, status: 'pending' } },
      );
      const resume = await fetch(`${host.control}/resume`);
      expect(resume.ok).toBe(true);
      const outcome = await decision;
      const evidence = await fixture.durableEvidence(refund.reviewId);
      const provider = await fixture.provider.refunds();
      expect(outcome.status).toBe(200);
      if (surface === 'reviews')
        expect(outcome.body).toMatchObject({
          error: {
            data: {
              weftCode: 'Conflict',
              reason: 'Cannot approve: the request authority is no longer current.',
            },
          },
        });
      else
        expect(outcome.body).toMatchObject({
          isError: true,
          structuredContent: {
            code: 'Conflict',
            message: 'Cannot approve: the request authority is no longer current.',
          },
        });
      expect(evidence.claims).toEqual([]);
      expect(evidence.decisions).toEqual([]);
      expect(provider).toEqual([]);
      expect(await fixture.provider.submissions()).toBe(0);
      expect(await fixture.ledger.get(refund.refundId)).toMatchObject({ status: 'admitted' });
      const finalStatus = await status();
      expect(finalStatus.providerSubmitCalls).toBe(0);
    } finally {
      await fetch(`${host.control}/claim`);
      await fetch(`${host.control}/resume`);
      await fixture.close();
    }
  });
  it(format('revalidates original requester after the %s reviewer claims', surface), () =>
    rethrow(scenario2),
  );
}

for (const surface of ['reviews', 'panel'] as const) {
  for (const change of ['revoke-alice', 'replace-alice'] as const) {
    const scenario = await refundScenario(async (onHang) => {
      const fixture = await startRefundRace('build', { onHang, distinctOwners: true });
      releaseRefundOnHang(onHang, fixture);
      const host = fixture.hosts[0];
      try {
        const refund = await fixture.requestRefund();
        const cookie = await fixture.signIn(host, 'alice');
        const session = await fixture.send(host, '/auth/session', { headers: { cookie } });
        expect(session.status).toBe(200);
        const { csrfToken } = (await session.json()) as { csrfToken: string };
        const call = async (name: string, arguments_: Record<string, unknown>) => {
          const panel = surface === 'panel';
          const response = await fixture.send(
            host,
            panel ? '/host/plugins/inspectors/apps/pending-review/tool-calls' : '/bureau/jsonrpc',
            {
              method: 'POST',
              headers: {
                cookie,
                origin: fixture.origin,
                'x-csrf-token': csrfToken,
                'content-type': 'application/json',
              },
              body: JSON.stringify(
                panel
                  ? { name, arguments: arguments_ }
                  : { jsonrpc: '2.0', id: 1, method: name, params: arguments_ },
              ),
            },
          );
          const text = await response.text();
          return {
            status: response.status,
            body: response.ok ? (JSON.parse(text) as unknown) : text,
          };
        };
        const before = await call('bureau.reviews.get', { id: refund.reviewId });
        expect(before.status).toBe(200);
        expect(before.body).toMatchObject(
          surface === 'panel'
            ? { structuredContent: { id: refund.reviewId, status: 'pending' } }
            : { result: { id: refund.reviewId, status: 'pending' } },
        );
        const armed = await fetch(`${host.control}/arm`);
        expect(armed.ok).toBe(true);
        const decision = call('bureau.reviews.resolve', {
          id: refund.reviewId,
          round: 0,
          decision: 'approve',
        });
        const status = async () => {
          const response = await fetch(`${host.control}/status`);
          return (await response.json()) as {
            claimArrived: boolean;
            claimCommitted: boolean;
            providerSubmitCalls: number;
          };
        };
        await waitUntil(
          async () => {
            const state = await status();
            return state.claimArrived;
          },
          {
            message: 'review decision arrived',
          },
        );
        const claim = await fetch(`${host.control}/claim`);
        expect(claim.ok).toBe(true);
        await waitUntil(
          async () => {
            const state = await status();
            return state.claimCommitted;
          },
          {
            message: 'review decision claimed',
          },
        );
        const held = await fixture.durableEvidence(refund.reviewId);
        expect(held.claims).toHaveLength(1);
        const changed = await fetch(`${host.control}/${change}`);
        expect(changed.ok).toBe(true);
        const resume = await fetch(`${host.control}/resume`);
        expect(resume.ok).toBe(true);
        const outcome = await decision;
        expect(outcome).toEqual({ status: 403, body: 'Workspace membership required' });
        const evidence = await fixture.durableEvidence(refund.reviewId);
        expect(evidence.claims).toEqual([]);
        expect(evidence.decisions).toEqual([]);
        expect(await fixture.provider.refunds()).toEqual([]);
        expect(await fixture.provider.submissions()).toBe(0);
        expect(await fixture.ledger.get(refund.refundId)).toMatchObject({ status: 'admitted' });
        const finalStatus = await status();
        expect(finalStatus.providerSubmitCalls).toBe(0);
      } finally {
        await fetch(`${host.control}/claim`);
        await fetch(`${host.control}/resume`);
        await fixture.close();
      }
    });
    it(format('revalidates %s reviewer after claim on %s', change, surface), () =>
      rethrow(scenario),
    );
  }
}
