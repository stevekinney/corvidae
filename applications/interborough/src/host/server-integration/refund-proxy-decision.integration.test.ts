import { rethrow } from '@lostgradient/testing/module-scope-scenario';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect, it } from 'bun:test';
import { format } from 'node:util';
import { startRefundRace } from '../../../tests/e2e/refund-race.test-support.ts';
import { refundScenario, releaseRefundOnHang } from './refund-scenario.test-support.ts';

for (const row of ['reviews', 'panel', 'deny', 'regate'] as const) {
  const winner = row;
  const scenario1 = await refundScenario(async (onHang) => {
    const fixture = await startRefundRace('build', { regate: winner === 'regate', onHang });
    releaseRefundOnHang(onHang, fixture);
    try {
      const refund = await fixture.requestRefund();
      const cookies = [
        await fixture.signIn(fixture.hosts[0], 'alice'),
        await fixture.signIn(fixture.hosts[1], 'bob'),
      ];
      const csrf = await Promise.all(
        fixture.hosts.map(async (host, index) => {
          const response = await fixture.send(host, '/auth/session', {
            headers: { cookie: cookies[index]! },
          });
          return ((await response.json()) as { csrfToken: string }).csrfToken;
        }),
      );
      for (const host of fixture.hosts) {
        const response = await fetch(`${host.control}/arm`);
        expect(response.ok).toBe(true);
      }
      if (winner === 'reviews' || winner === 'panel')
        for (const host of fixture.hosts) {
          const response = await fetch(`${host.control}/arm-provider`);
          expect(response.ok).toBe(true);
        }
      const results = ([0, 1] as const).map(async (index) => {
        const input = {
          id: refund.reviewId,
          round: 0,
          decision: winner === 'deny' && index === 0 ? 'deny' : 'approve',
          ...(index === 0 ? { decisionSurface: 'reviews' } : {}),
        };
        const panel = index === 1;
        const response = await fetch(
          `${fixture.origin}${panel ? '/host/plugins/inspectors/apps/pending-review/tool-calls' : '/bureau/jsonrpc'}`,
          {
            method: 'POST',
            headers: {
              cookie: cookies[index]!,
              origin: fixture.origin,
              'x-csrf-token': csrf[index]!,
              'x-refund-fixture-host': String(index),
              'content-type': 'application/json',
            },
            body: JSON.stringify(
              panel
                ? { name: 'bureau.reviews.resolve', arguments: input }
                : { jsonrpc: '2.0', id: 1, method: 'bureau.reviews.resolve', params: input },
            ),
            tls: { rejectUnauthorized: false },
          },
        );
        return { status: response.status, body: await response.json() };
      });
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
      await waitUntil(
        async () => {
          const states = await Promise.all([status(0), status(1)]);
          return states.every((state) => state.claimArrived);
        },
        { message: 'both decision claims' },
      );
      const first = winner === 'panel' ? 1 : 0;
      const second = first === 0 ? 1 : 0;
      await fetch(`${fixture.hosts[first].control}/claim`);
      await waitUntil(
        async () => {
          const state = await status(first);
          return state.claimCommitted;
        },
        {
          message: 'winning decision claim',
        },
      );
      if (winner === 'regate') {
        await fetch(`${fixture.hosts[first].control}/resume`);
        const superseded = await results[first]!;
        expect(superseded.status).toBe(200);
        expect(superseded.body).toMatchObject({
          result: { id: refund.reviewId, decision: 'approve', receipt: 'superseded' },
        });
      }
      await fetch(`${fixture.hosts[second].control}/claim`);
      if (winner === 'regate') {
        await waitUntil(
          async () => {
            const state = await status(second);
            return state.claimCommitted;
          },
          {
            message: 'stale decision claim',
          },
        );
        await fetch(`${fixture.hosts[second].control}/resume`);
      }
      const losing = await results[second]!;
      expect(losing.status).toBe(200);
      if (second === 0)
        expect(losing.body).toMatchObject({ error: { data: { weftCode: 'Conflict' } } });
      else
        expect(losing.body).toMatchObject({
          isError: true,
          structuredContent: { code: 'Conflict' },
        });
      const reread = await fetch(`${fixture.origin}/bureau/jsonrpc`, {
        method: 'POST',
        headers: {
          cookie: cookies[second]!,
          origin: fixture.origin,
          'x-refund-fixture-host': String(second),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'bureau.reviews.get',
          params: { id: refund.reviewId },
        }),
        tls: { rejectUnauthorized: false },
      });
      expect(await reread.json()).toMatchObject({
        result: { id: refund.reviewId, round: winner === 'regate' ? 1 : 0 },
      });
      expect(await fixture.provider.refunds()).toEqual([]);
      await fetch(`${fixture.hosts[first].control}/resume`);
      if (winner === 'reviews' || winner === 'panel') {
        await waitUntil(
          async () => {
            const state = await status(first);
            return state.providerSubmitArrived;
          },
          {
            message: 'provider submit reached before send',
          },
        );
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
        await waitUntil(
          async () => {
            const state = await status(first);
            return state.providerAccepted;
          },
          {
            message: 'provider accepted before reply',
          },
        );
        expect(await fixture.provider.refunds()).toHaveLength(1);
        expect(await fixture.provider.submissions()).toBe(1);
        expect(await fixture.ledger.get(refund.refundId)).toMatchObject({ status: 'submitting' });
        expect(fixture.proxy.calls.find((call) => call.host === first)?.finished).toBeUndefined();
        const reply = await fetch(`${fixture.hosts[first].control}/provider-reply`);
        expect(reply.ok).toBe(true);
      }
      const accepted = await results[first]!;
      expect(accepted.status).toBe(200);
      if (first === 0)
        expect(accepted.body).toMatchObject({
          result: {
            id: refund.reviewId,
            decision: winner === 'deny' ? 'deny' : 'approve',
            receipt: winner === 'regate' ? 'superseded' : 'applied',
          },
        });
      else
        expect(accepted.body).toMatchObject({
          structuredContent: { id: refund.reviewId, decision: 'approve', receipt: 'applied' },
        });
      if (winner !== 'regate')
        await waitUntil(
          async () => {
            const value = await fixture.ledger.get(refund.refundId);
            return value?.status === (winner === 'deny' ? 'failed' : 'provider-pending');
          },
          { message: 'refund decision settled' },
        );
      const saved = await fixture.ledger.get(refund.refundId);
      if (winner === 'deny' || winner === 'regate')
        expect(await fixture.provider.refunds()).toEqual([]);
      else
        expect(await fixture.provider.refunds()).toMatchObject([
          { amount: 4200, receipt: saved?.receipt },
        ]);
      if (winner === 'reviews' || winner === 'panel')
        expect(await fixture.provider.submissions()).toBe(1);
      expect(fixture.proxy.calls).toHaveLength(2);
      expect(fixture.proxy.calls.every((call) => call.response !== undefined)).toBe(true);
      const evidence = await fixture.durableEvidence(refund.reviewId);
      expect(evidence.claims).toHaveLength(winner === 'regate' ? 0 : 1);
      expect(evidence.tasks).toHaveLength(1);
      expect(evidence.starts).toHaveLength(1);
      expect(evidence.decisions).toHaveLength(winner === 'regate' ? 0 : 1);
      if (winner !== 'regate')
        expect(evidence.decisions[0]).toMatchObject({
          decision: winner === 'deny' ? 'deny' : 'approve',
          decidedBy: 'owner:admin',
          ...(winner !== 'panel' ? { decisionSurface: 'reviews' } : {}),
        });
      if (winner === 'panel') expect(evidence.decisions[0]).not.toHaveProperty('decisionSurface');
      if (winner === 'regate') expect(saved?.status).toBe('admitted');
    } finally {
      for (const host of fixture.hosts) {
        await fetch(`${host.control}/claim`);
        await fetch(`${host.control}/resume`);
        await fetch(`${host.control}/provider-send`);
        await fetch(`${host.control}/provider-reply`);
      }
      await fixture.close();
    }
  });
  it(format('forwards both decisions when %s claims first', winner), () => rethrow(scenario1));
}

for (const row of ['reviews', 'panel'] as const) {
  const surface = row;
  const scenario2 = await refundScenario(async (onHang) => {
    const fixture = await startRefundRace('build', { onHang });
    releaseRefundOnHang(onHang, fixture);
    try {
      const index = surface === 'reviews' ? 0 : 1;
      const host = fixture.hosts[index];
      const refund = await fixture.requestRefund();
      const cookie = await fixture.signIn(host, index === 0 ? 'alice' : 'bob');
      const session = await fixture.send(host, '/auth/session', { headers: { cookie } });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
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
      const input = {
        id: refund.reviewId,
        round: 0,
        decision: 'approve',
        ...(index === 0 ? { decisionSurface: 'reviews' } : {}),
      };
      const response = await fixture.send(
        host,
        index === 0 ? '/bureau/jsonrpc' : '/host/plugins/inspectors/apps/pending-review/tool-calls',
        {
          method: 'POST',
          headers: {
            cookie,
            origin: fixture.origin,
            'x-csrf-token': csrfToken,
            'content-type': 'application/json',
          },
          body: JSON.stringify(
            index === 0
              ? { jsonrpc: '2.0', id: 2, method: 'bureau.reviews.resolve', params: input }
              : { name: 'bureau.reviews.resolve', arguments: input },
          ),
        },
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as { result?: unknown; structuredContent?: unknown };
      expect(result.result ?? result.structuredContent).toMatchObject({
        id: refund.reviewId,
        decision: 'approve',
        receipt: 'applied',
        warning: 'APPROVAL_OUTCOME_NOT_WRITTEN',
      });
      const faultResponse = await fetch(`${host.control}/status`);
      const faultStatus = (await faultResponse.json()) as {
        outcomeFailures: number;
        metadataPasses: number;
      };
      expect(faultStatus.outcomeFailures).toBeGreaterThan(0);
      expect(faultStatus.metadataPasses).toBe(1);
      const finalRead = await read();
      expect(await finalRead.json()).toMatchObject({
        result: { id: refund.reviewId, status: 'approved', effect: { status: 'provider-pending' } },
      });
      expect(await fixture.provider.refunds()).toHaveLength(1);
      const evidence = await fixture.durableEvidence(refund.reviewId);
      expect(evidence.decisions).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
  it(format('returns the real outcome-write warning through %s after one refund', surface), () =>
    rethrow(scenario2),
  );
}
