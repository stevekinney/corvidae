import { expect, test } from 'bun:test';
import { BUREAU_HANDLER_OPERATIONS, createBureauHandler } from './create-bureau-handler.ts';
import { workspaceWebSocketLedger } from './workspace-conformance-ledger.test-support.ts';
import { waitForCondition } from '../test';
import { as } from './management/management-fixtures.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  workspacePrivacyAuthentication,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

type Frame = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { data?: { httpStatus?: number } };
};

test('authenticated WebSocket reads and run subscriptions preserve the six-actor private boundary', async () => {
  const witnesses = workspaceWebSocketLedger();
  const opened = await openWorkspacePrivacyBureau({ durableHistory: true });
  const handler = createBureauHandler(opened.bureau, {
    workspace: opened.bureau.workspaceBinding!,
    authentication: workspacePrivacyAuthentication,
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      if (
        request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
        (await handler.upgrade(request, server))
      )
        return undefined;
      return handler(request);
    },
    websocket: handler.websocket,
  });
  try {
    const task = await opened.bureau.tasks.start('default', 'PRIVATE-WEBSOCKET-INPUT-fd83', {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    await waitForCondition(
      () => opened.bureau.internals.runEventFeeds.get(task.id) !== undefined,
      'owned run feed exists',
    );
    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      const headers = as(WORKSPACE_PRIVACY_ACTORS[actor].key);
      if (actor === 'foreign' || actor === 'removed') {
        let upgrades = 0;
        const accepted = await handler.upgrade(
          new Request('http://localhost/jsonrpc', { headers }),
          {
            upgrade: () => {
              upgrades++;
              return true;
            },
          },
        );
        expect(accepted).toBe(false);
        expect(upgrades).toBe(0);
        const membership = await workspacePrivacyCall(opened, actor, 'weft.system.principal', {});
        witnesses.rejectedUpgrade(actor, accepted, membership);
        continue;
      }
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/jsonrpc`, { headers } as never);
      const frames: Frame[] = [];
      socket.addEventListener('message', (event) => {
        frames.push(JSON.parse(String(event.data)) as Frame);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve(), { once: true });
          socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
            once: true,
          });
        });
        let nextId = 0;
        const call = async (method: string, params: unknown) => {
          const id = ++nextId;
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          await waitForCondition(
            () => frames.some((frame) => frame.id === id),
            'WebSocket RPC settles',
          );
          return frames.find((frame) => frame.id === id)!;
        };
        const cases = [
          { method: 'weft.system.principal', parameters: {} },
          { method: 'bureau.tasks.events', parameters: { taskId: task.id } },
          { method: 'bureau.events', parameters: { bureauId: 'management-bureau' } },
          { method: 'operative.runs.events', parameters: { runId: task.id } },
          { method: 'bureau.settings.events', parameters: {} },
        ] as const;
        const caseNames: string[] = cases.map((entry) => entry.method).toSorted();
        expect(caseNames).toEqual(
          BUREAU_HANDLER_OPERATIONS.filter((entry) => entry.transports.jsonRpcWebSocket)
            .map((entry) => entry.name)
            .toSorted(),
        );
        for (const { method, parameters } of cases) {
          const result = await call(method, parameters);
          witnesses.observe(method, actor, result);
          if (method === 'weft.system.principal') {
            expect(result.error).toBeUndefined();
            expect(result.result).toMatchObject({
              workspace: { owner: WORKSPACE_PRIVACY_ACTORS[actor].owner },
            });
          } else if (method === 'bureau.events') expect(result.error?.data?.httpStatus).toBe(403);
          else if (method === 'bureau.settings.events') {
            if (actor === 'administrator') {
              expect(result.error).toBeUndefined();
              await opened.bureau.settings.update(
                { 'tools.wakeup': false },
                { expectedRevision: 0 },
              );
              await waitForCondition(
                () => frames.some((frame) => frame.method === 'weft.events.deliver'),
                'administrator receives settings event',
              );
            } else expect(result.error?.data?.httpStatus).toBe(403);
          } else if (actor === 'owner') expect(result.error).toBeUndefined();
          else {
            expect(result.error?.data?.httpStatus).toBe(404);
            const missing = await call(
              method,
              method === 'bureau.tasks.events'
                ? { taskId: 'unknown-run' }
                : { runId: 'unknown-run' },
            );
            expect(JSON.stringify(result.error).replaceAll(task.id, '<id>')).toBe(
              JSON.stringify(missing.error).replaceAll('unknown-run', '<id>'),
            );
          }
        }
        if (actor === 'owner') {
          await waitForCondition(
            () => frames.some((frame) => frame.method === 'weft.events.deliver'),
            'owner receives run event',
          );
          expect(JSON.stringify(frames)).toContain(task.id);
        } else {
          if (actor !== 'administrator')
            expect(frames.some((frame) => frame.method === 'weft.events.deliver')).toBe(false);
          expect(JSON.stringify(frames)).not.toContain('PRIVATE-WEBSOCKET-INPUT-fd83');
        }
      } finally {
        socket.close();
      }
    }
    witnesses.verify();
  } finally {
    await server.stop(true);
    await opened.dispose();
  }
});
