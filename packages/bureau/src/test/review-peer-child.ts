import { createAgent, stopWhen, type Toolbox } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { createBureau } from '../create-bureau';
import { createBureauHandler } from '../http/create-bureau-handler';
import { createMemoryAssetStorage } from '../assets/storage';
import { principalFromApiKey } from '@lostgradient/backchannel';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createSqliteStorageFixture } from './storage-fixtures';

const database = createSqliteStorageFixture({ path: process.argv[2]! });
let clockOffset = 0;
const services = createDefaultRuntimeServices();
let originalSession: { key: string; value: Uint8Array } | undefined;
const workspaceId = process.argv[3] ?? 'workspace-a';
const membership = {
  version: 1 as const,
  workspaceId,
  actorId: 'alice',
  actorKind: 'user' as const,
  owner: `${workspaceId}:alice`,
  membershipRevision: '1',
  capabilities: ['workspace:use' as const],
};
const workspace = {
  workspaceId,
  resolveMembership: async () => membership,
  resolveOwnerMembership: async (owner: string) => (owner === membership.owner ? membership : null),
};
const toolbox = createToolbox(
  [
    createTool({
      name: 'charge-card',
      version: '1.0.0',
      description: 'Charge',
      input: z.object({ cents: z.number() }),
      execute: async () => {
        appendFileSync(`${process.argv[2]!}.effects`, 'charged\n');
        return 'charged';
      },
    }),
  ],
  {
    approvalSecret: 'review-peer-secret',
    policy: {
      beforeExecute: () => ({
        allow: false,
        status: 'needs_approval',
        reason: 'Approval required',
        action: { message: 'Approve' },
      }),
    },
  },
) as unknown as Toolbox;
const bureau = await createBureau({
  id: 'review-peer-visibility',
  durable: true,
  storage: database.storage,
  assets: { storage: createMemoryAssetStorage() },
  workspace,
  runtime: {
    ...services,
    clock: {
      now: () => Date.now() + clockOffset,
      nowISO: () => new Date(Date.now() + clockOffset).toISOString(),
    },
  },
  agents: {
    default: createAgent({
      generate: async ({ step }) =>
        step === 0
          ? {
              content: '',
              toolCalls: [{ id: 'charge', name: 'charge-card', arguments: { cents: 500 } }],
            }
          : { content: 'charged', toolCalls: [] },
      toolbox,
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    }),
  },
});
const handler = createBureauHandler(bureau, {
  workspace,
  authentication: {
    resolveApiKeyPrincipal: async () => principalFromApiKey({ subject: 'alice', scopes: [] }),
    auditSink: () => undefined,
  },
});
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === '/jsonrpc') return handler(request);
    const input = (await request.json()) as {
      action: string;
      runId?: string;
      sessionId?: string;
      mode?: string;
      offset?: number;
    };
    if (input.action === 'start') {
      const run = await bureau.tasks.start('default', 'Charge', { principal: membership.owner });
      await bureau.tasks.wait(run.id);
      await waitUntil(async () => {
        const session = await bureau.contexts.get(run.contextId);
        return session?.metadata['lastRunStatus'] !== 'running';
      });
      return Response.json({
        runId: run.id,
        sessionId: run.contextId,
        reviews: bureau.reviews.list(),
      });
    }
    if (input.action === 'pending')
      return Response.json(await bureau.reviews.pendingOf(input.runId!));
    if (input.action === 'clock') {
      clockOffset = input.offset ?? 0;
      return Response.json({});
    }
    if (input.action === 'mutate') {
      if (input.mode === 'restore') {
        if (!originalSession) throw new Error('No saved session');
        await database.storage.put(originalSession.key, originalSession.value);
      } else {
        for await (const [key, value] of database.storage.scan('agent-session-v2:body:')) {
          const session = JSON.parse(new TextDecoder().decode(value));
          if (session.id !== input.sessionId) continue;
          originalSession = { key, value };
          if (input.mode === 'owner') delete session.metadata.lastRunOwningPrincipals[input.runId!];
          if (input.mode === 'authority')
            delete session.metadata.lastRequestAuthorities[input.runId!];
          if (input.mode === 'capabilities')
            session.metadata.lastRequestAuthorities[input.runId!].capabilities = [];
          if (input.mode === 'binding') {
            const approval = Object.values(session.metadata.pendingApprovalOverrides)[0] as {
              approvalBinding?: unknown;
            };
            delete approval.approvalBinding;
          }
          if (input.mode === 'token') {
            const approval = Object.values(session.metadata.pendingApprovalOverrides)[0] as {
              approvalToken: string;
            };
            approval.approvalToken = 'invalid';
          }
          await database.storage.put(key, new TextEncoder().encode(JSON.stringify(session)));
          break;
        }
      }
      return Response.json({});
    }
    if (input.action === 'inspect') {
      const session = await bureau.contexts.get(input.sessionId!);
      return Response.json({
        resolved: session?.metadata['resolvedReviewIds'],
        local: bureau.reviews.list().map((review) => ({
          id: review.id,
          round: review.kind === 'tool-approval' ? review.round : undefined,
        })),
      });
    }
    if (input.action === 'counts') {
      let decisions = 0;
      for await (const _entry of database.storage.scan('review-decision:v1')) decisions++;
      const path = `${process.argv[2]!}.effects`;
      const effects = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
      return Response.json({ decisions, effects });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  },
});
console.log(JSON.stringify({ pid: process.pid, port: server.port }));
process.on('SIGTERM', async () => {
  server.stop();
  await bureau.dispose();
  await database.dispose();
  process.exit(0);
});
