import { rethrow } from '@lostgradient/testing/module-scope-scenario';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, it } from 'bun:test';
import { startRefundRace } from '../../../tests/e2e/refund-race.test-support.ts';
import { refundScenario, releaseRefundOnHang } from './refund-scenario.test-support.ts';

type ObservationResult = {
  workspace?: { actorId?: string; owner?: string; capabilities?: string[] };
  status?: string;
  id?: string;
  reviews?: { id: string }[];
};

const scenario1 = await refundScenario(async (onHang) => {
  let phase = 'opening fixture';
  let reported = false;
  const reportHang = () => {
    if (!reported) console.error(`Refund peer visibility hang during ${phase}`);
    reported = true;
  };
  onHang(reportHang);
  const fixture = await startRefundRace('build', { onHang });
  releaseRefundOnHang(onHang, fixture);
  onHang(reportHang);
  try {
    phase = 'admitting refund';
    const refund = await fixture.requestRefund();
    const saved = await fixture.ledger.get(refund.refundId);
    const runId = saved?.existingRunId;
    if (!runId) throw new Error('Missing admitted run');
    phase = 'signing in reviewer';
    const cookie = await fixture.signIn(fixture.hosts[1], 'bob');
    for (const index of [0, 1]) {
      phase = `reading review from host ${String(index)}`;
      const response = await fetch(`${fixture.origin}/bureau/jsonrpc`, {
        method: 'POST',
        headers: {
          cookie,
          origin: fixture.origin,
          'content-type': 'application/json',
          'x-refund-fixture-host': String(index),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.reviews.get',
          params: { id: refund.reviewId },
        }),
        tls: { rejectUnauthorized: false },
      });
      const answer = (await response.json()) as { result?: { id?: string } };
      expect(answer.result?.id).toBe(refund.reviewId);
    }
    phase = 'opening later peer';
    const restartedPeer = await fixture.startPeer();
    const observations = [];
    for (const host of [...fixture.hosts, restartedPeer]) {
      phase = `reading RPC and panel from host ${String(host.pid)}`;
      const rpc = async (method: string, params: Record<string, unknown>) => {
        const response = await fixture.send(host, '/bureau/jsonrpc', {
          method: 'POST',
          headers: {
            cookie,
            origin: fixture.origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        return (await response.json()) as {
          result?: ObservationResult;
          error?: { code?: unknown; message?: string };
        };
      };
      const panel = async (name: string, arguments_: Record<string, unknown>) => {
        const response = await fixture.send(
          host,
          '/host/plugins/inspectors/apps/pending-review/tool-calls',
          {
            method: 'POST',
            headers: {
              cookie,
              origin: fixture.origin,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name, arguments: arguments_ }),
          },
        );
        return (await response.json()) as {
          structuredContent?: ObservationResult;
          isError?: boolean;
          content?: { text?: string }[];
        };
      };
      const principal = await rpc('weft.system.principal', {});
      const task = await rpc('bureau.tasks.get', { taskId: runId });
      const list = await rpc('bureau.reviews.list', { status: 'pending', limit: 50 });
      const detail = await rpc('bureau.reviews.get', { id: refund.reviewId });
      const panelList = await panel('bureau.reviews.list', { status: 'pending', limit: 50 });
      const panelDetail = await panel('bureau.reviews.get', { id: refund.reviewId });
      observations.push({
        actor: principal.result?.workspace?.actorId,
        owner: principal.result?.workspace?.owner,
        capabilities: principal.result?.workspace?.capabilities,
        taskStatus: task.result?.status,
        taskError: task.error?.message,
        listIds: list.result?.reviews?.map((entry: { id: string }) => entry.id),
        detailId: detail.result?.id,
        detailError: detail.error?.message,
        panelIds: panelList.structuredContent?.reviews?.map((entry: { id: string }) => entry.id),
        panelDetailId: panelDetail.structuredContent?.id,
        panelError: panelDetail.isError ? panelDetail.content?.[0]?.text : undefined,
      });
    }
    phase = 'reading durable metadata';
    const persisted = await fixture.approvalMetadata(runId);
    console.log(JSON.stringify({ runId, reviewId: refund.reviewId, persisted, observations }));
    expect(persisted?.reviewIds).toContain(refund.reviewId);
    for (const observation of observations) {
      expect(observation.actor).toBe('bob');
      expect(observation.detailId).toBe(refund.reviewId);
      expect(observation.panelDetailId).toBe(refund.reviewId);
      expect(observation.listIds).toContain(refund.reviewId);
      expect(observation.panelIds).toContain(refund.reviewId);
    }
  } finally {
    phase = 'closing fixture';
    await fixture.close();
  }
});
it('exposes one admitted review to the same reviewer on both hosts and transports', () =>
  rethrow(scenario1));

const scenario2 = await refundScenario(async (onHang) => {
  let stop: (() => Promise<void>) | undefined;
  const starting = startRefundRace('build', {
    onHang: (release) => {
      stop = release;
    },
  });
  const outcome = rejectionOf(starting);
  if (!stop) throw new Error('Fixture did not register setup cleanup');
  onHang(stop);
  await stop();
  const failure = await outcome;
  expect(failure).toMatchObject({ message: 'Refund fixture setup was stopped' });
});
it('closes a real delayed fixture acquisition after setup is stopped', () => rethrow(scenario2));
