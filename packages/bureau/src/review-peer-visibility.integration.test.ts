import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expectScenarioPassed, settleScenario } from './test/hoisted-scenario';

const outcome = await settleScenario(async (scope) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-peer-'));
  const children: ReturnType<typeof spawnWithHangGuard>[] = [];
  const cleanup = async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await rm(directory, { recursive: true, force: true });
  };
  scope.onHang(cleanup);
  try {
    async function start(workspace = 'workspace-a') {
      const child = spawnWithHangGuard(
        [
          'bun',
          join(import.meta.dir, 'test', 'review-peer-child.ts'),
          join(directory, 'database.sqlite'),
          workspace,
        ],
        { stdout: 'pipe', stderr: 'inherit' },
      );
      children.push(child);
      const reader = child.stdout.getReader();
      const first = await reader.read();
      const info = JSON.parse(new TextDecoder().decode(first.value)) as {
        pid: number;
        port: number;
      };
      return {
        ...info,
        call: async (body: unknown) => {
          const response = await fetch(`http://127.0.0.1:${info.port}`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return response.json();
        },
        rpc: async (method: string, params: unknown) => {
          const response = await fetch(`http://127.0.0.1:${info.port}/jsonrpc`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-API-Key': 'alice' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          return response.json();
        },
      };
    }
    const a = await start();
    const b = await start();
    const foreign = await start('workspace-b');
    console.log(`Bureau child PIDs: ${a.pid}, ${b.pid}`);
    expect(a.pid).not.toBe(b.pid);
    const admitted = (await a.call({ action: 'start' })) as {
      runId: string;
      sessionId: string;
      reviews: Array<{ id: string }>;
    };
    expect(admitted.reviews).toHaveLength(1);
    const peer = (await b.call({ action: 'pending', runId: admitted.runId })) as Array<{
      id: string;
    }>;
    expect(peer.map((review) => review.id)).toEqual([admitted.reviews[0]!.id]);
    for (const host of [a, b]) {
      const list = (await host.rpc('bureau.reviews.list', {})) as {
        result: { reviews: Array<{ id: string }> };
      };
      if (!list.result) throw new Error(JSON.stringify(list));
      expect(list.result.reviews.map((review) => review.id)).toEqual([admitted.reviews[0]!.id]);
      expect(list.result.reviews[0]).toMatchObject({
        id: admitted.reviews[0]!.id,
        runId: admitted.runId,
        sessionId: admitted.sessionId,
        round: 0,
      });
      const detail = (await host.rpc('bureau.reviews.get', { id: admitted.reviews[0]!.id })) as {
        result: { id: string; runId: string; round: number; sessionId: string };
      };
      expect(detail.result).toMatchObject({
        id: admitted.reviews[0]!.id,
        runId: admitted.runId,
        sessionId: admitted.sessionId,
        round: 0,
      });
      const task = (await host.rpc('bureau.tasks.get', { taskId: admitted.runId })) as {
        result: { status: string };
      };
      expect(task.result.status).toBe('input-required');
    }
    expect(await b.call({ action: 'counts' })).toEqual({ decisions: 0, effects: 0 });
    const foreignList = (await foreign.rpc('bureau.reviews.list', {})) as {
      result: { reviews: unknown[] };
    };
    expect(foreignList.result.reviews).toEqual([]);
    const foreignDetail = (await foreign.rpc('bureau.reviews.get', {
      id: admitted.reviews[0]!.id,
    })) as { error: { data: { httpStatus: number } } };
    expect(foreignDetail.error.data.httpStatus).toBe(404);
    expect(await b.call({ action: 'counts' })).toEqual({ decisions: 0, effects: 0 });
    async function expectHidden() {
      const list = (await b.rpc('bureau.reviews.list', {})) as {
        result: { reviews: Array<{ id: string }> };
      };
      expect(list.result.reviews).toEqual([]);
      const detail = (await b.rpc('bureau.reviews.get', { id: admitted.reviews[0]!.id })) as {
        error: { data: { httpStatus: number } };
      };
      expect(detail.error.data.httpStatus).toBe(404);
      expect(await b.call({ action: 'counts' })).toEqual({ decisions: 0, effects: 0 });
    }
    for (const mode of ['owner', 'authority', 'capabilities', 'binding', 'token']) {
      await a.call({
        action: 'mutate',
        mode,
        runId: admitted.runId,
        sessionId: admitted.sessionId,
      });
      await expectHidden();
      await a.call({ action: 'mutate', mode: 'restore' });
    }
    await b.call({ action: 'clock', offset: 3_600_000 });
    await expectHidden();
    await b.call({ action: 'clock', offset: 0 });
    await Promise.all(
      [a, b].map((host) =>
        host.rpc('bureau.reviews.resolve', {
          id: admitted.reviews[0]!.id,
          decision: 'approve',
          round: 0,
        }),
      ),
    );
    expect(await b.call({ action: 'counts' })).toEqual({ decisions: 1, effects: 1 });
    const postSettlement = [];
    for (const host of [a, b]) {
      const list = (await host.rpc('bureau.reviews.list', {})) as {
        result: { reviews: Array<{ id: string }> };
      };
      const inspect = (await host.call({
        action: 'inspect',
        sessionId: admitted.sessionId,
      })) as { resolved: string[] };
      expect(inspect.resolved.filter((id) => id === admitted.reviews[0]!.id)).toHaveLength(1);
      console.log(
        JSON.stringify({ pid: host.pid, listed: list.result.reviews.map(({ id }) => id), inspect }),
      );
      postSettlement.push(list.result.reviews);
      const task = (await host.rpc('bureau.tasks.get', { taskId: admitted.runId })) as {
        result: { status: string };
      };
      expect(task.result.status).toBe('completed');
    }
    expect(postSettlement).toEqual([[], []]);
    await b.rpc('bureau.reviews.resolve', {
      id: admitted.reviews[0]!.id,
      decision: 'approve',
      round: 0,
    });
    expect(await b.call({ action: 'counts' })).toEqual({ decisions: 1, effects: 1 });
  } finally {
    await cleanup();
  }
}, 120_000);

test('a running peer discovers a signed approval admitted after boot', () => {
  expectScenarioPassed(outcome);
});
