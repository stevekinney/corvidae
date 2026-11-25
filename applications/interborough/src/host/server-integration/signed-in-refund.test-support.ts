import { openBungalow } from '@lostgradient/bungalow';
import type { WorkspaceMembership } from '@lostgradient/bureau';
import {
  createAdmittedRefundTool,
  createFakeProcessor,
  createRefundLedger,
  reviewedRefundContribution,
} from '@lostgradient/plugin-demo/refunds';
import inspectors from '@lostgradient/plugin-inspectors';
import { MemoryStorage } from '@lostgradient/storage';
import { createProcessLocalApprovalStateStore, createToolbox } from 'armorer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from 'openid-client';
import { recoverRefund } from '../../../../../plugins/demo/src/refund-processor.ts';
import { startHost } from '../host.ts';
import { createSyntheticIssuer } from './synthetic-issuer.test-support.ts';

/** Separate model and signed-in reviewer on the real panel listener. */
export async function startSignedInRefundFixture() {
  const syntheticIssuer = await createSyntheticIssuer();
  const { issuer, provider } = syntheticIssuer;
  const home = await mkdtemp(join(tmpdir(), 'interborough-sign-in-'));
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  const workspaceId = bungalow.workspaceId;
  await bungalow.close();
  const members = new Map<string, WorkspaceMembership>();
  members.set('api-key-caller', {
    version: 1,
    workspaceId,
    actorId: 'api-key-caller',
    actorKind: 'service',
    owner: 'owner:admin',
    membershipRevision: 'revision-1',
    capabilities: ['workspace:use'],
  });
  for (const actorId of ['admin', 'member'])
    members.set(actorId, {
      version: 1,
      workspaceId,
      actorId,
      actorKind: 'user',
      owner: `owner:${actorId}`,
      membershipRevision: 'revision-1',
      capabilities: actorId === 'admin' ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
    });
  const configuration = await client.discovery(
    new URL(issuer),
    'interborough',
    { client_secret: 'secret' },
    undefined,
    { execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks] },
  );
  const refundStorage = new MemoryStorage();
  const ledger = createRefundLedger(refundStorage);
  await ledger.addCharge({
    merchant: 'merchant',
    order: 'order',
    amount: 10000,
    currency: 'USD',
    paymentReference: 'charge',
    providerAccount: 'account',
  });
  const approvalStateStore = createProcessLocalApprovalStateStore();
  const processor = createFakeProcessor(refundStorage);
  const refundTool = createAdmittedRefundTool(ledger, processor, () => 100);
  const toolbox = createToolbox([refundTool], {
    approvalSecret: 'fixture-secret',
    approvalStateStore,
    approvalPolicy: { mode: 'always' },
  });
  const refundContext = () => ({
    authority: {
      principalId: 'api-key-caller',
      tenantId: workspaceId,
      ownerId: 'owner:admin',
      capabilities: [],
      authorizationRevision: 'bureau:1',
    },
  });
  const refund = reviewedRefundContribution({
    ledger,
    toolbox,
    toolId: refundTool.id,
    approvalStateStore,
    requestContext: refundContext,
    access: {
      async request(principal) {
        return principal.method !== 'unauthenticated' &&
          principal.workspace?.actorId === 'api-key-caller'
          ? { merchant: 'merchant', owner: principal.workspace.owner }
          : undefined;
      },
      async read(principal, entry) {
        return principal.method !== 'unauthenticated' && principal.workspace?.owner === entry.owner;
      },
      async isRequester(principal) {
        return (
          principal.method !== 'unauthenticated' &&
          principal.workspace?.actorId === 'api-key-caller'
        );
      },
      async decide(principal) {
        return (
          principal.method !== 'unauthenticated' &&
          principal.workspace?.actorId === 'admin' &&
          principal.workspace.capabilities.includes('workspace:manage')
        );
      },
    },
  });
  let refundWorker: Awaited<ReturnType<typeof refund.attachWorker>> | undefined;
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    workspaceId,
    port: 0,
    plugins: [
      { descriptor: inspectors, source: 'package', location: '@lostgradient/plugin-inspectors' },
    ],
    reviewedOperations: {
      agents: refund.agents,
      reviewPolicy: refund.reviewPolicy,
      operations: refund.operations,
      reviewEffects: refund.reviewEffects,
      releasePlugin: {
        descriptor: refund.releasePlugin,
        source: 'package',
        location: '@lostgradient/plugin-demo',
      },
      async attach(bureau) {
        refundWorker = await refund.attachWorker(
          {
            tasks: bureau.tasks,
            internals: bureau.internals,
            reviews: bureau.reviews,
            events: bureau,
            requestContext: async () => refundContext(),
          },
          (error) => {
            throw error;
          },
        );
        return refundWorker;
      },
    },
    workspaceAuthentication: {
      authentication: { apiKeys: ['machine'] },
      workspace: {
        workspaceId,
        resolveMembership: async ({ subject }) => members.get(subject ?? '') ?? null,
        resolveOwnerMembership: async (owner) =>
          [...members.values()].find((member) => member.owner === owner) ?? null,
      },
    },
    sharedBrowserSignIn: {
      origin: 'https://settings.example',
      provider: Promise.resolve(configuration),
      resolveAccount: async (identity) => (identity.issuer === issuer ? identity.subject : null),
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
  const send = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, host.url), {
      ...init,
      redirect: 'manual',
      headers: { ...Object.fromEntries(new Headers(init.headers)), host: 'settings.example' },
    });
  async function signIn() {
    syntheticIssuer.setSubject('admin');
    const started = await send('/auth/sign-in');
    const temporaryCookie = started.headers.getSetCookie()[0]!.split(';')[0]!;
    const authorized = await fetch(started.headers.get('location')!, { redirect: 'manual' });
    const callback = new URL(authorized.headers.get('location')!);
    const result = await send(callback.pathname + callback.search, {
      headers: { cookie: temporaryCookie },
    });
    if (result.status !== 303) throw new Error('Synthetic reviewer sign-in failed');
    return result.headers.getSetCookie()[0]!.split(';')[0]!;
  }
  let refundId: string | undefined;
  async function requestRefund() {
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'x-api-key': 'machine', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'demo.refunds.request',
        params: { commandId: 'panel-browser', orderId: 'order', cents: 4200 },
      }),
    });
    const answer = (await response.json()) as { result?: { refundId: string } };
    if (!answer.result) throw new Error('Synthetic refund request failed');
    refundId = answer.result.refundId;
    await refundWorker?.idle();
    const entry = await ledger.get(answer.result.refundId);
    if (!entry?.reviewId) throw new Error('Synthetic refund review missing');
    return entry.reviewId;
  }
  return {
    host,
    send,
    signIn,
    requestRefund,
    async refundStatus() {
      const entry = refundId ? await ledger.get(refundId) : undefined;
      return entry?.status;
    },
    async settleRefund() {
      if (!refundId) throw new Error('No synthetic refund was requested');
      const entry = await ledger.get(refundId);
      if (entry?.status !== 'provider-pending')
        throw new Error('Synthetic refund is not provider-pending');
      await processor.update(entry.providerKey, 'succeeded');
      if (!(await recoverRefund(ledger, processor, refundId, 10)))
        throw new Error('Synthetic refund did not settle');
    },
    async close() {
      await host.close();
      provider.stop(true);
      await rm(home, { recursive: true, force: true });
    },
  };
}
