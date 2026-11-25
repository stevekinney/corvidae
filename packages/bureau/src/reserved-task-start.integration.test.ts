import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '@lostgradient/operative';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createBureau } from './create-bureau.ts';

for (const boundary of ['task', 'workflow', 'prepared', 'receipt'] as const) {
  const outcome = await (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-reserved-'));
    const path = join(directory, 'bureau.sqlite');
    const child = spawnWithHangGuard(
      [
        process.execPath,
        '-e',
        `
      import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
      import { createAgent } from '@lostgradient/operative';
      import { createDefaultRuntimeServices, HookRegistry } from '@lostgradient/lifecycle';
      import { createBureau } from './src/create-bureau.ts';
      const storage = new BunSQLiteStorage(process.argv[1]);
      const hookStarted = Promise.withResolvers();
      let receiptPaused = false;
      const wrapped = new Proxy(storage, { get(target, property) {
        if (property === 'conditionalBatch') return async (conditions, operations) => {
          const matched = operations.some((op) => op.type === 'put' && (process.argv[2] === 'task' ? op.key.startsWith('bureau-task:v1:') : process.argv[2] === 'receipt' ? !receiptPaused && op.key.startsWith('command-ledger:v1:entry:') && JSON.parse(new TextDecoder().decode(op.value)).state === 'completed' : op.key === 'wf:reserved-run'));
          if (matched && (process.argv[2] === 'prepared' || process.argv[2] === 'receipt')) {
            const result = await target.conditionalBatch(conditions, operations);
            if (result) {
              if (process.argv[2] === 'receipt') { receiptPaused = true; await hookStarted.promise; }
              console.log(process.argv[2] === 'receipt' ? 'boundary-reached hook-started' : 'boundary-reached');
              await Bun.stdin.text();
            }
            return result;
          }
          if (matched) {
            console.log('boundary-reached');
            await Bun.stdin.text();
          }
          return target.conditionalBatch(conditions, operations);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      const initialNow = 1000000;
      const runtime = { ...createDefaultRuntimeServices(), clock: { now: () => initialNow, nowISO: () => new Date(initialNow).toISOString() } };
      const hooks = new HookRegistry();
      if (process.argv[2] === 'receipt') hooks.on('onRunStart', async () => { hookStarted.resolve(); await new Promise(() => {}); });
      const bureau = await createBureau({ storage: wrapped, durable: true, maintenance: 'manual', runtime, durableOwnership: { ownership: 'workflow-lease', workflowClaimTtlMs: 60000, workflowClaimRenewIntervalMs: 5000 }, requestAuthorityValidator: () => true, agents: { assistant: createAgent({ hooks, generate: async () => ({ content: 'done', toolCalls: [] }) }) } });
      await bureau.tasks.start('assistant', 'hello', { principal: 'alice', commandId: 'command', reservation: { runId: 'reserved-run', sessionId: 'reserved-session', fence: 1 }, requestContext: { authority: { principalId: 'alice', tenantId: 'tenant', ownerId: 'alice', capabilities: [], authorizationRevision: 'v1' } } });
    `,
        path,
        boundary,
      ],
      { cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const output = await child.stdout.getReader().read();
      if (!output.value)
        throw new Error(
          `Child exited before the session commit: ${await new Response(child.stderr).text()}`,
        );
      expect(new TextDecoder().decode(output.value)).toContain('boundary-reached');
      if (boundary === 'receipt')
        expect(new TextDecoder().decode(output.value)).toContain('hook-started');
      child.kill('SIGKILL');
      await child.exited;
      const storage = new BunSQLiteStorage(path);
      let authorized = false;
      const bureau = await createBureau({
        storage,
        durable: true,
        maintenance: 'manual',
        runtime: {
          ...createDefaultRuntimeServices(),
          clock: { now: () => 1120000, nowISO: () => new Date(1120000).toISOString() },
        },
        durableOwnership: {
          ownership: 'workflow-lease',
          workflowClaimTtlMs: 60000,
          workflowClaimRenewIntervalMs: 5000,
        },
        requestAuthorityValidator: () => authorized,
        agents: {
          assistant: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
        },
      });
      try {
        if (boundary === 'prepared' || boundary === 'receipt')
          expect(await bureau.tasks.workflow('reserved-run')).toMatchObject({
            status: 'pending',
          });
        const options = {
          principal: 'alice',
          commandId: 'command',
          reservation: { runId: 'reserved-run', sessionId: 'reserved-session', fence: 2 },
          requestContext: {
            authority: {
              principalId: 'alice',
              tenantId: 'tenant',
              ownerId: 'alice',
              capabilities: [],
              authorizationRevision: 'v2',
            },
          },
        };
        expect(
          await bureau.tasks.start('assistant', 'hello', options).then(
            () => false,
            () => true,
          ),
        ).toBe(true);
        if (boundary === 'prepared' || boundary === 'receipt')
          expect(await bureau.tasks.workflow('reserved-run')).toMatchObject({
            status: 'pending',
          });
        else expect(await bureau.tasks.workflow('reserved-run')).toBeNull();
        authorized = true;
        const task = await bureau.tasks.start('assistant', 'hello', options);
        expect(task.id).toBe('reserved-run');
        expect(task.contextId).toBe('reserved-session');
        expect(await task.result().then((value) => value.error)).toBeUndefined();
        expect(await bureau.tasks.get('reserved-run')).toMatchObject({
          id: 'reserved-run',
          contextId: 'reserved-session',
        });
      } finally {
        await bureau.dispose();
        storage[Symbol.dispose]();
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  })().then(
    () => null,
    (error: unknown) => error,
  );
  it(`adopts the same reservation after death at ${boundary} admission`, () => {
    expect(outcome).toBeNull();
  });
}
