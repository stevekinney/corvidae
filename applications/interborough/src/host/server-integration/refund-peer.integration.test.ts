import { createFakeProcessor } from '@lostgradient/plugin-demo/refunds';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { rethrow } from '@lostgradient/testing/module-scope-scenario';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { format } from 'node:util';
import { refundScenario } from './refund-scenario.test-support.ts';

for (const row of ['approve', 'deny', 'regate'] as const) {
  const winner = row;
  const scenario1 = await refundScenario(async (onHang) => {
    const directory = createTemporaryDirectory('refund-peer');
    onHang(() => removeTemporaryPath(directory));
    const childPath = new URL('./refund-peer.test-support.ts', import.meta.url).pathname;
    const database = join(directory, 'bureau.sqlite');
    const provider = join(directory, 'provider.sqlite');
    const spawn = (role: string, reviewId?: string) =>
      spawnWithHangGuard(
        [process.execPath, childPath, database, provider, role, ...(reviewId ? [reviewId] : [])],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
    let owner: ReturnType<typeof spawn>;
    try {
      owner = spawn('owner');
    } catch (error) {
      removeTemporaryPath(directory);
      throw error;
    }
    const peers: ReturnType<typeof spawn>[] = [];
    onHang(async () => {
      for (const child of [owner, ...peers]) if (child.exitCode === null) child.kill();
      await Promise.all([owner, ...peers].map((child) => child.exited));
      removeTemporaryPath(directory);
    });
    try {
      const reader = owner.stdout.getReader();
      const first = await reader.read();
      if (!first.value) throw new Error(await new Response(owner.stderr).text());
      const opened = JSON.parse(new TextDecoder().decode(first.value)) as {
        pid: number;
        refundId: string;
        reviewId: string;
      };
      peers.push(
        spawn(
          winner === 'deny' ? 'denier' : winner === 'regate' ? 'regater' : 'reviewer',
          opened.reviewId,
        ),
      );
      peers.push(spawn('reviewer', opened.reviewId));
      const readers = peers.map((peer) => peer.stdout.getReader());
      const arrivals = await Promise.all(readers.map((stream) => stream.read()));
      for (const [index, arrival] of arrivals.entries()) {
        if (!arrival.value) throw new Error(await new Response(peers[index]!.stderr).text());
      }
      const processes = arrivals.map(
        (arrival) =>
          JSON.parse(new TextDecoder().decode(arrival.value)) as { pid: number; ready: boolean },
      );
      expect(new Set([opened.pid, ...processes.map((process) => process.pid)]).size).toBe(3);
      expect(processes.every((process) => process.ready)).toBe(true);
      const release = (index: number) => {
        peers[index]!.stdin.write('go');
        peers[index]!.stdin.flush();
      };
      release(0);
      release(1);
      const claims = await Promise.all(readers.map((stream) => stream.read()));
      expect(
        claims.map((claim) => JSON.parse(new TextDecoder().decode(claim.value)).claim),
      ).toEqual(['arrived', 'arrived']);
      release(0);
      const committedOutput = await readers[0]!.read();
      const committed = JSON.parse(new TextDecoder().decode(committedOutput.value)) as {
        claim: string;
      };
      expect(committed.claim).toBe('committed');
      let winningAnswer: { result?: unknown; conflict?: boolean } | undefined;
      if (winner === 'regate') {
        release(0);
        const winningOutput = await readers[0]!.read();
        winningAnswer = JSON.parse(new TextDecoder().decode(winningOutput.value)) as {
          result?: unknown;
          conflict?: boolean;
        };
        expect(winningAnswer.result).toMatchObject({ superseded: true });
      }
      release(1);
      const losingOutput = await readers[1]!.read();
      let losingAnswer = JSON.parse(new TextDecoder().decode(losingOutput.value)) as {
        conflict?: boolean;
        claim?: string;
        review?: { round: number; status: string };
      };
      if (winner === 'regate') {
        expect(losingAnswer.claim).toBe('committed');
        release(1);
        const staleOutput = await readers[1]!.read();
        losingAnswer = JSON.parse(new TextDecoder().decode(staleOutput.value)) as {
          conflict?: boolean;
          claim?: string;
          review?: { round: number; status: string };
        };
        expect(losingAnswer.review).toMatchObject({ round: 1, status: 'pending' });
      }
      expect(losingAnswer.conflict).toBe(true);
      const providerStorage = new BunSQLiteStorage(provider);
      try {
        expect(await createFakeProcessor(providerStorage).refunds()).toEqual([]);
      } finally {
        providerStorage[Symbol.dispose]();
      }
      if (winner !== 'regate') release(0);
      for (const peer of peers) peer.stdin.end();
      const answers = await Promise.all(
        peers.map(async (peer, index) => {
          const output =
            index === 0 && winningAnswer === undefined ? await readers[index]!.read() : undefined;
          const errors = await new Response(peer.stderr).text();
          expect({ exit: await peer.exited, errors }).toEqual({ exit: 0, errors: '' });
          return output === undefined
            ? index === 0
              ? winningAnswer
              : losingAnswer
            : (JSON.parse(new TextDecoder().decode(output.value)) as {
                result?: unknown;
                conflict?: boolean;
              });
        }),
      );
      expect(
        answers.filter((answer) => answer && 'result' in answer && answer.result),
      ).toHaveLength(1);
      expect(answers.filter((answer) => answer?.conflict)).toHaveLength(1);
      owner.stdin.end();
      const result = await reader.read();
      const evidence = JSON.parse(new TextDecoder().decode(result.value)) as {
        refund: { status: string; receipt: string };
        provider: { receipt: string; amount: number; paymentReference: string }[];
        decisions: string[];
        tasks: string[];
        starts: string[];
        replayId: string;
        changedAmountConflict: boolean;
      };
      if (winner === 'approve') {
        expect(evidence.refund.status).toBe('provider-pending');
        expect(evidence.provider).toHaveLength(1);
        expect(evidence.provider[0]).toMatchObject({
          amount: 4200,
          paymentReference: 'charge',
          receipt: evidence.refund.receipt,
        });
      } else if (winner === 'deny') {
        expect(evidence.refund.status).toBe('failed');
        expect(evidence.provider).toEqual([]);
      } else {
        expect(evidence.refund.status).toBe('admitted');
        expect(evidence.provider).toEqual([]);
      }
      expect(evidence.decisions).toHaveLength(winner === 'regate' ? 0 : 1);
      expect(evidence.tasks).toHaveLength(1);
      expect(evidence.starts).toHaveLength(1);
      expect(evidence.replayId).toBe(opened.refundId);
      expect(evidence.changedAmountConflict).toBe(true);
      expect(await owner.exited).toBe(0);
    } finally {
      for (const process of [owner, ...peers]) {
        if (process.exitCode === null) process.kill();
        await process.exited;
      }
      removeTemporaryPath(directory);
    }
  });
  it(format('records one durable decision when %s wins the claim', winner), () =>
    rethrow(scenario1),
  );
}
