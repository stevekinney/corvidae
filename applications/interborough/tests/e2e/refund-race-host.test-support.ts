import type { WorkspaceMembership } from '@lostgradient/bureau';
import {
  createAdmittedRefundTool,
  createFakeProcessor,
  createRefundLedger,
  recoverRefund,
} from '@lostgradient/plugin-demo/refunds';
import inspectors from '@lostgradient/plugin-inspectors';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createToolbox } from 'armorer';
import * as client from 'openid-client';
import { processEnvironment } from '../../src/host/environment-configuration.ts';
import { startHost } from '../../src/host/host.ts';
import { reviewedRefundContribution } from '../../src/host/refund-operations.ts';
import { durableApprovalStore } from '../../src/host/server-integration/refund.test-support.ts';

type Configuration = {
  environment: Record<string, string>;
  workspaceId: string;
  issuer: string;
  ledgerPath: string;
  providerPath: string;
  origin: string;
  buildDirectory?: string;
  regate?: boolean;
  distinctOwners?: boolean;
  revokedActors?: string[];
};
const input = JSON.parse(
  processEnvironment()['REFUND_RACE_CONFIG'] ?? 'null',
) as Configuration | null;
if (!input) throw new Error('Missing host configuration');
const ledgerStorage = new BunSQLiteStorage(input.ledgerPath);
const providerStorage = new BunSQLiteStorage(input.providerPath);
const ledger = createRefundLedger(ledgerStorage);
let providerArmed = false;
let providerSubmitArrived = false;
let providerAccepted = false;
let providerSubmitCalls = 0;
let recoveryEligibilityChecks = 0;
let recoveryAttempts = 0;
const providerSendRelease = Promise.withResolvers<void>();
const providerReplyRelease = Promise.withResolvers<void>();
const actualProcessor = createFakeProcessor(providerStorage, async () => {
  if (providerArmed) {
    providerAccepted = true;
    await providerReplyRelease.promise;
  }
});
const processor = {
  ...actualProcessor,
  async submit(refund: Parameters<typeof actualProcessor.submit>[0]) {
    providerSubmitCalls++;
    if (providerArmed) {
      providerSubmitArrived = true;
      await providerSendRelease.promise;
    }
    return actualProcessor.submit(refund);
  },
};
const approvalStateStore = durableApprovalStore(ledgerStorage);
const tool = createAdmittedRefundTool(ledger, processor, () => 100);
const toolbox = createToolbox([tool], {
  approvalSecret: 'fixture-secret',
  approvalStateStore,
  ...(input.regate ? { approvalPolicy: { mode: 'always' as const } } : {}),
});
const requestContext = () => ({
  authority: {
    principalId: 'api-key-caller',
    tenantId: input.workspaceId,
    ownerId: 'owner:admin',
    capabilities: [],
    authorizationRevision: 'bureau:1',
  },
});
const contribution = reviewedRefundContribution({
  ledger,
  toolbox,
  toolId: tool.id,
  approvalStateStore,
  requestContext,
  async recoverAccepted(refund) {
    const accepted = await recoverRefund(ledger, processor, refund.id, Date.now(), true, false);
    return accepted ? ledger.get(refund.id) : undefined;
  },
  access: {
    request: async (principal) =>
      principal.method !== 'unauthenticated' && principal.workspace?.actorId === 'api-key-caller'
        ? { merchant: 'merchant', owner: principal.workspace.owner }
        : undefined,
    read: async (principal, refund) =>
      principal.method !== 'unauthenticated' && principal.workspace?.owner === refund.owner,
    isRequester: async (principal) =>
      principal.method !== 'unauthenticated' && principal.workspace?.actorId === 'api-key-caller',
    decide: async (principal, refund) => {
      if (principal.method !== 'browser-session' || !principal.workspace) return false;
      const signed = principal.workspace;
      let current: WorkspaceMembership | null;
      try {
        current = await resolveMembership({ subject: principal.subject });
      } catch {
        return false;
      }
      return (
        current !== null &&
        current.workspaceId === input.workspaceId &&
        current.workspaceId === signed.workspaceId &&
        current.actorId === signed.actorId &&
        current.owner === signed.owner &&
        current.membershipRevision === signed.membershipRevision &&
        current.actorKind === 'user' &&
        signed.actorKind === 'user' &&
        current.capabilities.includes('workspace:use') &&
        current.capabilities.includes('workspace:manage') &&
        signed.capabilities.includes('workspace:manage') &&
        refund.merchant === 'merchant' &&
        (signed.actorId === 'alice' || signed.actorId === 'bob')
      );
    },
  },
});
const members = new Map<string, WorkspaceMembership>();
async function resolveMembership(credential: { subject?: string | undefined }) {
  return members.get(credential.subject ?? '') ?? null;
}
members.set('api-key-caller', {
  version: 1,
  workspaceId: input.workspaceId,
  actorId: 'api-key-caller',
  actorKind: 'service',
  owner: 'owner:admin',
  membershipRevision: 'revision-1',
  capabilities: ['workspace:use'],
});
for (const actorId of ['alice', 'bob'])
  members.set(actorId, {
    version: 1,
    workspaceId: input.workspaceId,
    actorId,
    actorKind: 'user',
    owner: input.distinctOwners ? `owner:refund-reviewer-${actorId}` : 'owner:admin',
    membershipRevision: 'revision-1',
    capabilities: ['workspace:use', 'workspace:manage'],
  });
members.set('other-merchant', {
  version: 1,
  workspaceId: input.workspaceId,
  actorId: 'other-merchant',
  actorKind: 'user',
  owner: 'owner:other-merchant',
  membershipRevision: 'revision-1',
  capabilities: ['workspace:use', 'workspace:manage'],
});
members.set('unentitled', {
  version: 1,
  workspaceId: input.workspaceId,
  actorId: 'unentitled',
  actorKind: 'user',
  owner: 'owner:refund-unentitled',
  membershipRevision: 'revision-1',
  capabilities: ['workspace:use', 'workspace:manage'],
});
for (const actor of input.revokedActors ?? []) members.delete(actor);
const configuration = await client.discovery(
  new URL(input.issuer),
  'interborough',
  { client_secret: 'secret' },
  undefined,
  { execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks] },
);
let arm = false;
let claimArrived = false;
let claimCommitted = false;
let outcomeSession: string | undefined;
let outcomeFailures = 0;
let metadataPasses = 0;
let probeMetadata: ((id: string) => Promise<void>) | undefined;
const claimRelease = Promise.withResolvers<void>();
const resumeRelease = Promise.withResolvers<void>();
const controls = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/arm':
        arm = true;
        break;
      case '/claim':
        claimRelease.resolve();
        break;
      case '/resume':
        resumeRelease.resolve();
        break;
      case '/status':
        return Response.json({
          claimArrived,
          claimCommitted,
          outcomeFailures,
          metadataPasses,
          providerSubmitArrived,
          providerAccepted,
          providerSubmitCalls,
          recoveryEligibilityChecks,
          recoveryAttempts,
        });
      case '/arm-provider':
        providerArmed = true;
        break;
      case '/provider-send':
        providerSendRelease.resolve();
        break;
      case '/provider-reply':
        providerReplyRelease.resolve();
        break;
      case '/arm-outcome':
        outcomeSession = url.searchParams.get('session') ?? undefined;
        if (!outcomeSession) return new Response('Missing session', { status: 400 });
        break;
      case '/probe-metadata':
        if (!outcomeSession || !probeMetadata) return new Response('Not armed', { status: 400 });
        await probeMetadata(outcomeSession);
        break;
      case '/revoke':
        members.delete('bob');
        break;
      case '/revoke-alice':
        members.delete('alice');
        break;
      case '/replace-alice': {
        const alice = members.get('alice');
        if (!alice) return new Response('Missing membership', { status: 409 });
        members.set('alice', { ...alice, membershipRevision: 'revision-2' });
        break;
      }
      case '/revoke-requester':
        members.delete('api-key-caller');
        break;
      default:
        return new Response('Not found', { status: 404 });
    }
    return new Response('ok');
  },
});
let worker: Awaited<ReturnType<typeof contribution.attachWorker>> | undefined;
const host = await startHost({
  environment: input.environment,
  workspaceId: input.workspaceId,
  port: 0,
  log: (message) => console.error(message),
  ...(input.buildDirectory ? { buildDirectory: input.buildDirectory } : {}),
  plugins: [
    { descriptor: inspectors, source: 'package', location: '@lostgradient/plugin-inspectors' },
  ],
  decorateStorageForTesting(storage) {
    const conditionalBatch = storage.conditionalBatch?.bind(storage);
    if (!conditionalBatch) throw new Error('Refund race requires conditional storage');
    return new Proxy(storage, {
      get(target, property) {
        if (property === 'conditionalBatch')
          return async (...args: Parameters<typeof conditionalBatch>) => {
            const claim =
              arm &&
              args[1].some(
                (operation) =>
                  operation.type === 'put' && operation.key.startsWith('review-decision:'),
              );
            if (claim) {
              arm = false;
              claimArrived = true;
              await claimRelease.promise;
            }
            const result = await conditionalBatch(...args);
            if (claim && result) {
              claimCommitted = true;
              await resumeRelease.promise;
            }
            return result;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
  reviewedOperations: {
    agents: contribution.agents,
    reviewPolicy: {
      ...contribution.reviewPolicy,
      mayRecover(review) {
        recoveryEligibilityChecks++;
        return contribution.reviewPolicy.mayRecover?.(review) ?? false;
      },
      async recover(review) {
        recoveryAttempts++;
        return contribution.reviewPolicy.recover?.(review);
      },
    },
    operations: contribution.operations,
    reviewEffects: contribution.reviewEffects,
    releasePlugin: {
      descriptor: contribution.releasePlugin,
      source: 'package',
      location: '@lostgradient/plugin-demo',
    },
    async attach(bureau) {
      worker = await contribution.attachWorker(
        {
          tasks: bureau.tasks,
          internals: bureau.internals,
          reviews: bureau.reviews,
          events: bureau,
          async requestContext() {
            return requestContext();
          },
        },
        (error) => {
          throw error;
        },
      );
      return worker;
    },
  },
  workspaceAuthentication: {
    authentication: { apiKeys: ['machine'] },
    workspace: {
      workspaceId: input.workspaceId,
      resolveMembership,
      resolveOwnerMembership: async (owner) =>
        [...members.values()].find((member) => member.owner === owner) ?? null,
    },
  },
  sharedBrowserSignIn: {
    origin: input.origin,
    provider: Promise.resolve(configuration),
    resolveAccount: async (identity) =>
      identity.issuer === input.issuer ? identity.subject : null,
    scopes: async () => ['system:read', 'reviews:read'],
    oauth: {
      resourcePath: '/bureau/mcp',
      scopes: ['reviews:read'],
      startingScopes: ['reviews:read'],
      scopeDescriptions: { 'reviews:read': 'Read reviews' },
      delegableScopes: async () => ['reviews:read'],
      operationScopes: { 'bureau.tasks.get': 'reviews:read' },
    },
  },
});
const sessionStore = host.bureau.internals.sessionStore;
if (!sessionStore) throw new Error('Refund fixture requires a session store');
const updateSession = sessionStore.update.bind(sessionStore);
sessionStore.update = (id, updater, options) =>
  updateSession(
    id,
    async (session) => {
      const next = await updater(session);
      if (
        id === outcomeSession &&
        session &&
        next &&
        next.conversationHistory !== session.conversationHistory
      ) {
        outcomeFailures++;
        throw new Error('Fixture conversation outcome write failed');
      }
      return next;
    },
    options,
  );
probeMetadata = async (id) => {
  await sessionStore.update(
    id,
    (session) => (session ? { ...session, metadata: { ...session.metadata } } : undefined),
    { refreshActivity: false },
  );
  metadataPasses++;
};
console.log(
  JSON.stringify({
    pid: process.pid,
    url: host.url.toString(),
    control: `http://127.0.0.1:${controls.port}`,
  }),
);
try {
  await Bun.stdin.text();
} finally {
  claimRelease.resolve();
  resumeRelease.resolve();
  providerSendRelease.resolve();
  providerReplyRelease.resolve();
  await host.close();
  await controls.stop(true);
  ledgerStorage[Symbol.dispose]();
  providerStorage[Symbol.dispose]();
}
