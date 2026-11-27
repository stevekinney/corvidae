import { recoverRefund } from '@lostgradient/plugin-demo/refunds';
import { rethrow } from '@lostgradient/testing/module-scope-scenario';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect, it } from 'bun:test';
import { startRefundRace } from '../../../tests/e2e/refund-race.test-support.ts';
import { refundScenario, releaseRefundOnHang } from './refund-scenario.test-support.ts';

for (const distinctOwners of [false, true]) {
  const scenario1 = await refundScenario(async (onHang) => {
    const fixture = await startRefundRace('build', { onHang, distinctOwners });
    releaseRefundOnHang(onHang, fixture);
    try {
      const host = fixture.hosts[0];
      for (const surface of ['reviews', 'panel'] as const) {
        const refund = await fixture.requestRefund();
        const cookie = await fixture.signIn(host, surface === 'reviews' ? 'alice' : 'bob');
        const session = await fixture.send(host, '/auth/session', { headers: { cookie } });
        const { csrfToken } = (await session.json()) as { csrfToken: string };
        const input = {
          id: refund.reviewId,
          round: 0,
          decision: 'approve',
          ...(surface === 'reviews' ? { decisionSurface: 'reviews' } : {}),
        };
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
                ? { name: 'bureau.reviews.resolve', arguments: input }
                : { jsonrpc: '2.0', id: 1, method: 'bureau.reviews.resolve', params: input },
            ),
          },
        );
        expect(response.status).toBe(200);
        const answer = (await response.json()) as {
          result?: { receipt?: string };
          structuredContent?: { receipt?: string };
        };
        expect((panel ? answer.structuredContent : answer.result)?.receipt).toBe('applied');
        await waitUntil(
          async () => {
            const value = await fixture.ledger.get(refund.refundId);
            return value?.status === 'provider-pending';
          },
          { message: 'provider accepted refund' },
        );
        const saved = await fixture.ledger.get(refund.refundId);
        const payments = await fixture.provider.refunds();
        expect(payments.filter((payment) => payment.receipt === saved?.receipt)).toHaveLength(1);
        const detail = await fixture.send(host, '/bureau/jsonrpc', {
          method: 'POST',
          headers: { cookie, origin: fixture.origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'bureau.reviews.get',
            params: { id: refund.reviewId },
          }),
        });
        const resolved = (await detail.json()) as {
          result?: {
            status?: string;
            resolution?: { decision?: string; decisionSurface?: string; decidedBy?: string };
          };
        };
        expect(resolved.result).toMatchObject({
          status: 'approved',
          resolution: { decision: 'approve' },
        });
        const actor = surface === 'reviews' ? 'alice' : 'bob';
        expect(resolved.result?.resolution?.decidedBy).toBe(
          distinctOwners ? `owner:refund-reviewer-${actor}` : 'owner:admin',
        );
        expect(resolved.result?.resolution?.decisionSurface).toBe(
          surface === 'reviews' ? 'reviews' : undefined,
        );
        const evidence = await fixture.durableEvidence(refund.reviewId);
        expect(evidence.decisions).toMatchObject([
          {
            reviewerProvenance: {
              actorId: actor,
              transport: panel ? 'mcp' : 'jsonRpcHttp',
              ...(panel ? { panelUri: 'ui://inspectors/pending-review/v1' } : {}),
            },
          },
        ]);
      }
      expect(await fixture.provider.refunds()).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
  it(`approves separate refunds through JSON-RPC and the mounted MCP bridge (${distinctOwners ? 'distinct' : 'same'} owners)`, () =>
    rethrow(scenario1));
}

const crashScenario = await refundScenario(async (onHang) => {
  const fixture = await startRefundRace('build', { onHang, distinctOwners: true });
  releaseRefundOnHang(onHang, fixture);
  try {
    for (const surface of ['reviews', 'panel'] as const) {
      const host = fixture.hosts[0];
      const panel = surface === 'panel';
      const actor = panel ? 'bob' : 'alice';
      const refund = await fixture.requestRefund();
      const cookie = await fixture.signIn(host, actor);
      const session = await fixture.send(host, '/auth/session', { headers: { cookie } });
      expect(session.status).toBe(200);
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const armed = await fetch(`${host.control}/arm-provider`);
      expect(armed.ok).toBe(true);
      const input = {
        id: refund.reviewId,
        round: 0,
        decision: 'approve',
        ...(panel ? {} : { decisionSurface: 'reviews' }),
      };
      const decision = fixture
        .send(
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
                ? { name: 'bureau.reviews.resolve', arguments: input }
                : { jsonrpc: '2.0', id: 1, method: 'bureau.reviews.resolve', params: input },
            ),
          },
        )
        .then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
      const status = async () => {
        const response = await fetch(`${host.control}/status`);
        return (await response.json()) as {
          providerSubmitArrived: boolean;
          providerAccepted: boolean;
        };
      };
      await waitUntil(
        async () => {
          const state = await status();
          return state.providerSubmitArrived;
        },
        {
          message: 'provider submission reached',
        },
      );
      const send = await fetch(`${host.control}/provider-send`);
      expect(send.ok).toBe(true);
      await waitUntil(
        async () => {
          const state = await status();
          return state.providerAccepted;
        },
        {
          message: 'provider accepted refund',
        },
      );
      expect(await fixture.provider.refunds()).toHaveLength(panel ? 2 : 1);
      const heldRefund = await fixture.ledger.get(refund.refundId);
      expect(heldRefund?.status).toBe('submitting');
      const start = await fixture.ledger.getStart(refund.refundId);
      if (!start) throw new Error('Missing refund start');
      const beforeCrash = await fixture.approvalMetadata(start.runId);
      expect(beforeCrash?.started).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: refund.reviewId,
            reviewedRecovery: expect.objectContaining({
              reviewerProvenance: expect.objectContaining({ actorId: actor }),
            }),
          }),
        ]),
      );
      const revoked = await fetch(`${host.control}/${panel ? 'revoke' : 'revoke-alice'}`);
      expect(revoked.ok).toBe(true);
      await fixture.crashHost(0);
      const interrupted = await decision;
      expect(interrupted).toHaveProperty('error');
      const restarted = await fixture.restartHost(0, [actor]);
      let evidence = await fixture.durableEvidence(refund.reviewId);
      if (evidence.decisions.length === 0 && evidence.pendingOutbox.length === 0)
        evidence = await fixture.durableEvidence(refund.reviewId);
      if (evidence.decisions.length === 0 && evidence.pendingOutbox.length === 0) {
        const response = await fetch(`${restarted.control}/status`);
        const restartStatus = await response.json();
        throw new Error(
          `Reviewed recovery did not commit: ${JSON.stringify({ beforeCrash, afterRestart: await fixture.approvalMetadata(start.runId), restartStatus, evidence, refund: await fixture.ledger.get(refund.refundId) })}`,
        );
      }
      if (evidence.pendingOutbox.length > 0) {
        await waitUntil(
          async () => {
            const current = await fixture.durableEvidence(refund.reviewId);
            return current.decisions.length === 1;
          },
          { message: 'recovered review outbox projection' },
        );
        evidence = await fixture.durableEvidence(refund.reviewId);
      }
      expect(
        evidence.claims.filter((key) => key.includes(encodeURIComponent(refund.reviewId))),
      ).toHaveLength(1);
      expect(evidence.tasks.filter((key) => key.endsWith(start.runId))).toHaveLength(1);
      expect(evidence.decisions).toMatchObject([
        {
          decision: 'approve',
          reviewerProvenance: {
            actorId: actor,
            transport: panel ? 'mcp' : 'jsonRpcHttp',
            ...(panel ? { panelUri: 'ui://inspectors/pending-review/v1' } : {}),
          },
          ...(panel ? {} : { decisionSurface: 'reviews' }),
        },
      ]);
      const recovered = await fixture.ledger.get(refund.refundId);
      const payments = await fixture.provider.refunds();
      const matching = payments.filter((payment) => payment.key === recovered?.providerKey);
      expect(matching).toMatchObject([
        { receipt: recovered?.receipt, paymentReference: 'charge', amount: 4200, currency: 'USD' },
      ]);
      expect(await fixture.provider.refunds()).toHaveLength(panel ? 2 : 1);
      expect(await fixture.provider.submissions()).toBe(panel ? 2 : 1);
      await recoverRefund(
        fixture.ledger,
        fixture.provider,
        refund.refundId,
        Date.now(),
        true,
        false,
      );
      await recoverRefund(
        fixture.ledger,
        fixture.provider,
        refund.refundId,
        Date.now(),
        true,
        false,
      );
      const afterReconciliation = await fixture.durableEvidence(refund.reviewId);
      expect(afterReconciliation.decisions).toHaveLength(1);
    }
  } finally {
    await fixture.close();
  }
});
it('retains the authenticated decision after resolver death following provider acceptance', () =>
  rethrow(crashScenario));
