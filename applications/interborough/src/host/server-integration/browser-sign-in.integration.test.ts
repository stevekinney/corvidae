import { openBungalow } from '@lostgradient/bungalow';
import { createBureauCatalogSnapshot, type WorkspaceMembership } from '@lostgradient/bureau';
import { createAgent } from '@lostgradient/operative';
import {
  createAdmittedRefundTool,
  createFakeProcessor,
  createRefundLedger,
} from '@lostgradient/plugin-demo/refunds';
import inspectors, { pendingReview } from '@lostgradient/plugin-inspectors';
import { MemoryStorage } from '@lostgradient/storage';
import { createRemoteClient } from '@lostgradient/velveteen/remote/client';
import { defineRemote } from '@lostgradient/velveteen/remote/server';
import { createApplication } from '@lostgradient/velveteen/server';
import { createProcessLocalApprovalStateStore, createToolbox } from 'armorer';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from 'openid-client';
import { startHost } from '../host.ts';
import { buildPanelPage } from '../panel-build.ts';
import { PANEL_PREBUILT_DIRECTORY_VARIABLE, prebuiltPanelFile } from '../panel-mounts.ts';
import { reviewedRefundContribution } from '../refund-operations.ts';
import { loadDeploymentOptions } from '../serve.ts';
import { createSyntheticIssuer } from './synthetic-issuer.test-support.ts';

const privateRemotes = {
  member: defineRemote({
    kind: 'command',
    validate: () => null,
    handle: (_input, event) =>
      (event.locals['interboroughWorkspace'] as WorkspaceMembership).actorId,
  }),
};
const clientScript = 'export const loaded = true;';

test('listener binds verified browser identities, revokes private access and resumes consent', async () => {
  const syntheticIssuer = await createSyntheticIssuer();
  const { issuer, provider } = syntheticIssuer;
  let acceptedIssuer = issuer;
  let allowA2a = false;
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
  const streamStarted = Promise.withResolvers<void>();
  const releaseStream = Promise.withResolvers<void>();
  const loadStarted = Promise.withResolvers<void>();
  const releaseLoad = Promise.withResolvers<void>();
  const keyTargetsStarted = Promise.withResolvers<void>();
  const releaseKeyTargets = Promise.withResolvers<void>();
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
  const catalog = createBureauCatalogSnapshot(refund.operations);
  for (const name of ['demo.refunds.request', 'demo.refunds.get'])
    expect(catalog.operations.find((operation) => operation.name === name)).toMatchObject({
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: false },
      mcpExposable: true,
    });
  let refundWorker: Awaited<ReturnType<typeof refund.attachWorker>> | undefined;
  let holdLoad = false;
  let holdKeyTargets = false;
  // Exercise the installed panel's listener without putting source compilation on its startup clock.
  const panelDirectory = join(home, 'prebuilt-panels');
  await mkdir(panelDirectory, { recursive: true });
  const panelPage = await buildPanelPage({
    entry: pendingReview.entry.href,
    title: pendingReview.title,
    styles: pendingReview.styles ?? '',
  });
  await writeFile(
    join(panelDirectory, `${pendingReview.name}.json`),
    prebuiltPanelFile(pendingReview.uri, panelPage),
  );
  const host = await startHost({
    environment: {
      INTERBOROUGH_HOME: home,
      [PANEL_PREBUILT_DIRECTORY_VARIABLE]: panelDirectory,
    },
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
    extraAgents: {
      agents: {
        fixture: createAgent({
          name: 'fixture',
          generate: async () => ({ content: 'PRIVATE-LISTENER-SENTINEL', toolCalls: [] }),
        }),
        waiting: createAgent({
          name: 'waiting',
          generate: async () => {
            streamStarted.resolve();
            await releaseStream.promise;
            return { content: 'PRIVATE-STREAM-SENTINEL', toolCalls: [] };
          },
        }),
      },
    },
    workspaceAuthentication: {
      authentication: { apiKeys: ['machine'] },
      workspace: {
        workspaceId,
        resolveMembership: async ({ subject: identity }) => members.get(identity ?? '') ?? null,
        resolveOwnerMembership: async (owner) => {
          const requester = members.get('api-key-caller');
          return requester?.owner === owner
            ? requester
            : ([...members.values()].find((member) => member.owner === owner) ?? null);
        },
      },
    },
    sharedBrowserSignIn: {
      origin: 'https://settings.example',
      provider: Promise.resolve(configuration),
      resolveAccount: async (identity) =>
        identity.issuer === acceptedIssuer &&
        ['admin', 'member', 'removed'].includes(identity.subject)
          ? identity.subject
          : null,
      scopes: async () => [
        'system:read',
        'reviews:read',
        ...(allowA2a ? ['bureau.assets:read'] : []),
      ],
      createPrivateServer: async (hooks) => {
        const routing = {
          version: 1,
          nodes: [
            {
              id: '/settings/api-keys',
              directory: '',
              parentId: null,
              params: [],
              page: { component: 'page.svelte' },
            },
          ],
          routes: [
            {
              id: '/settings/api-keys',
              pattern: '^/settings/api-keys$',
              params: [],
              node: 0,
              leaf: 0,
              ancestors: [0],
              layouts: [],
              errors: [null],
            },
          ],
        };
        await mkdir(join(home, 'browser'), { recursive: true });
        await writeFile(join(home, 'browser/client.js'), clientScript);
        const generation = {
          directory: home,
          manifest: {
            version: 1,
            basePath: '',
            routing,
            client: {
              file: 'browser/client.js',
              url: '/_assets/client.js',
              stylesheets: [],
              nodes: {},
            },
            server: { file: 'server.js', nodes: {} },
            routes: {},
            assets: [
              {
                file: 'browser/client.js',
                url: '/_assets/client.js',
                target: 'browser',
                contentType: 'text/javascript',
                bytes: clientScript.length,
                sha256: createHash('sha256').update(clientScript).digest('hex'),
                immutable: true,
              },
            ],
            outputs: [],
          },
        };
        const registry = {
          manifest: routing,
          nodes: [
            {
              page: async () => ({ default: {} }),
              pageServer: async () => ({
                actions: {
                  default: (event: { locals: Record<string, unknown> }) => ({
                    actor: (event.locals['interboroughWorkspace'] as WorkspaceMembership).actorId,
                  }),
                },
                load: async (event: { fetch: typeof fetch }) => {
                  const response = await event.fetch('/api/v1/principal');
                  const identity = await response.json();
                  if (holdLoad) {
                    loadStarted.resolve();
                    await releaseLoad.promise;
                  }
                  return { identity };
                },
              }),
            },
          ],
          Root: {},
          render: (_component: unknown, input: { props: unknown }) => ({
            body: JSON.stringify(input.props),
            head: '',
          }),
        };
        return createApplication({
          generation: generation as never,
          registry: registry as never,
          hooks,
          remotes: privateRemotes,
        });
      },
      keyManagement: {
        targets: async () => {
          if (holdKeyTargets) {
            keyTargetsStarted.resolve();
            await releaseKeyTargets.promise;
          }
          return [
            { subject: 'service', scopes: ['reviews:read'] },
            ...(allowA2a ? [{ subject: 'a2a', scopes: ['bureau.assets:read'] }] : []),
          ];
        },
        allowedActions: async () => ['rotate', 'revoke'],
        overlapCutoff: () => Date.now() + 60_000,
      },
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
  const signIn = async (identity: string, path = '/auth/sign-in') => {
    syntheticIssuer.setSubject(identity);
    const started = await send(path);
    const cookie = started.headers.getSetCookie()[0]!.split(';')[0]!;
    const authorized = await fetch(started.headers.get('location')!, { redirect: 'manual' });
    const callback = new URL(authorized.headers.get('location')!);
    const result = await send(callback.pathname + callback.search, { headers: { cookie } });
    return { result, cookie: result.headers.getSetCookie()[0]?.split(';')[0] };
  };
  const openSocket = async (cookie: string, machine = false) => {
    const url = new URL('/bureau/jsonrpc', host.url);
    url.protocol = 'ws:';
    const socket: WebSocket = Reflect.construct(WebSocket, [
      url.toString(),
      {
        headers: machine
          ? { 'x-api-key': cookie }
          : { host: 'settings.example', origin: 'https://settings.example', cookie },
      },
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Socket refused')), { once: true });
    });
    return socket;
  };
  const socketPrincipal = (socket: WebSocket) =>
    new Promise<{ result: { workspace: { actorId: string } } }>((resolve) => {
      socket.addEventListener(
        'message',
        (event) =>
          resolve(JSON.parse(String(event.data)) as { result: { workspace: { actorId: string } } }),
        { once: true },
      );
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.system.principal', params: {} }),
      );
    });
  const socketAfterRevocation = (socket: WebSocket) =>
    new Promise<string>((resolve) => {
      socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener('close', () => resolve('closed'), { once: true });
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'weft.system.principal', params: {} }),
      );
    });
  try {
    const run = await host.bureau.tasks.start('fixture', 'PRIVATE-LISTENER-SENTINEL', {
      principal: 'owner:admin',
    });
    await run.result();
    const readPrivate = (cookie?: string) =>
      send('/bureau/jsonrpc', {
        method: 'POST',
        headers: {
          origin: 'https://settings.example',
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.tasks.get',
          params: { taskId: run.id },
        }),
      });
    const anonymous = await send('/api/v1/principal');
    expect(anonymous.status).toBe(401);
    const administrator = await signIn('admin');
    expect(administrator.result.status).toBe(303);
    const member = await signIn('member');
    expect(member.result.status).toBe(303);
    const memberSession = await send('/auth/session', { headers: { cookie: member.cookie! } });
    const memberSessionData = (await memberSession.json()) as { csrfToken: string };
    const memberHeaders = { cookie: member.cookie!, 'x-csrf-token': memberSessionData.csrfToken };
    const refundRpc = async (method: string, params: unknown, headers: Record<string, string>) => {
      const response = await (headers['x-api-key']
        ? fetch(new URL('/bureau/jsonrpc', host.url), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
        : send('/bureau/jsonrpc', {
            method: 'POST',
            headers: {
              origin: 'https://settings.example',
              'content-type': 'application/json',
              ...headers,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          }));
      return (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
    };
    const machine = { 'x-api-key': 'machine' };
    const refundRequest = { commandId: 'signed-in-refund', orderId: 'order', cents: 4200 };
    const accepted = await refundRpc('demo.refunds.request', refundRequest, machine);
    const refundId = accepted.result?.['refundId'];
    expect(typeof refundId).toBe('string');
    expect(await refundRpc('demo.refunds.request', refundRequest, machine)).toEqual(accepted);
    const machineRefund = await refundRpc('demo.refunds.get', { refundId }, machine);
    expect(machineRefund.result).toMatchObject({ refundId });
    const forbiddenRequest = await refundRpc('demo.refunds.request', refundRequest, memberHeaders);
    expect(forbiddenRequest.error).toBeDefined();
    await refundWorker?.idle();
    const storedRefund = await ledger.get(refundId as string);
    expect(storedRefund?.reviewId).toBeDefined();
    const session = await send('/auth/session', { headers: { cookie: administrator.cookie! } });
    const sessionData = (await session.json()) as { csrfToken: string };
    const reviewer = { cookie: administrator.cookie!, 'x-csrf-token': sessionData.csrfToken };
    const detail = await refundRpc('bureau.reviews.get', { id: storedRefund!.reviewId }, reviewer);
    expect(detail.result).toMatchObject({
      effect: { kind: 'refund', refundId, cents: 4200, currency: 'USD' },
    });
    expect(JSON.stringify(detail)).not.toContain('approvalToken');
    const forbiddenRefund = await refundRpc(
      'demo.refunds.get',
      { refundId },
      { cookie: member.cookie! },
    );
    expect(forbiddenRefund.error).toBeDefined();
    const requesterDecision = await refundRpc(
      'bureau.reviews.resolve',
      { id: storedRefund!.reviewId, decision: 'deny', round: 0 },
      machine,
    );
    expect(requesterDecision.error).toBeDefined();
    const mcp = async (name: string, argumentsValue: object, headers: Record<string, string>) => {
      const request = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2024-11-05',
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: argumentsValue },
        }),
      };
      const response = headers['x-api-key']
        ? await fetch(new URL('/bureau/mcp', host.url), request)
        : await send('/bureau/mcp', {
            ...request,
            headers: { ...request.headers, origin: 'https://settings.example' },
          });
      return await response.text();
    };
    expect(await mcp('demo.refunds.get', { refundId }, machine)).toContain(refundId as string);
    expect(await mcp('demo.refunds.request', refundRequest, machine)).toContain(refundId as string);
    expect(await mcp('demo.refunds.request', refundRequest, memberHeaders)).toContain('isError');
    expect(
      await mcp(
        'bureau.reviews.resolve',
        { id: storedRefund!.reviewId, decision: 'deny', round: 0 },
        machine,
      ),
    ).toContain('isError');
    expect(await mcp('demo.refunds.get', { refundId }, { cookie: member.cookie! })).toContain(
      'isError',
    );
    const refundSocket = await openSocket(member.cookie!);
    const socketCall = (socket: WebSocket, method: string, params: object) => {
      const response = new Promise<string>((resolve) =>
        socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }),
      );
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      return response;
    };
    expect(await socketCall(refundSocket, 'demo.refunds.get', { refundId })).toContain('error');
    expect(await socketCall(refundSocket, 'demo.refunds.request', refundRequest)).toContain(
      'error',
    );
    refundSocket.close();
    const machineSocket = await openSocket('machine', true);
    expect(await socketCall(machineSocket, 'demo.refunds.get', { refundId })).toContain(
      refundId as string,
    );
    expect(await socketCall(machineSocket, 'demo.refunds.request', refundRequest)).toContain(
      refundId as string,
    );
    machineSocket.close();
    const panelCall = (name: string, argumentsValue: object, headers: Record<string, string>) =>
      send('/host/plugins/inspectors/apps/pending-review/tool-calls', {
        method: 'POST',
        headers: {
          origin: 'https://settings.example',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ name, arguments: argumentsValue }),
      });
    const decision = { id: storedRefund!.reviewId, decision: 'deny', round: 0 };
    const listed = await panelCall('bureau.reviews.list', {}, reviewer);
    expect(listed.status).toBe(200);
    const listing = (await listed.json()) as { _meta: Record<string, unknown> };
    expect(listing._meta['interborough.reviewEligibility']).toContainEqual({
      id: storedRefund!.reviewId,
      round: 0,
    });
    const noProof = await panelCall('bureau.reviews.resolve', decision, {
      cookie: administrator.cookie!,
    });
    const wrongProof = await panelCall('bureau.reviews.resolve', decision, {
      ...reviewer,
      'x-csrf-token': 'wrong',
    });
    const mixedCredentials = await panelCall('bureau.reviews.resolve', decision, {
      ...reviewer,
      'x-api-key': 'machine',
    });
    expect(noProof.status).toBe(403);
    expect(wrongProof.status).toBe(403);
    expect(mixedCredentials.status).toBe(403);
    const reviewerDecision = await panelCall('bureau.reviews.resolve', decision, reviewer);
    expect((await reviewerDecision.json()) as object).toMatchObject({
      structuredContent: { decision: 'deny', receipt: 'applied' },
    });
    const remainingBalance = await ledger.balance('merchant', 'order');
    expect(remainingBalance?.reserved).toBe(0);
    const next = await refundRpc(
      'demo.refunds.request',
      { ...refundRequest, commandId: 'mcp-approval' },
      machine,
    );
    const nextId = next.result?.['refundId'];
    await refundWorker?.idle();
    const nextRefund = await ledger.get(nextId as string);
    expect(nextRefund?.reviewId).toBeDefined();
    const nextReview = nextRefund!.reviewId!;
    expect(
      await mcp(
        'bureau.reviews.resolve',
        { id: nextReview, decision: 'reject', round: 0 },
        reviewer,
      ),
    ).toContain('isError');
    expect(
      await mcp('bureau.reviews.resolve', { id: nextReview, decision: 'deny', round: 1 }, reviewer),
    ).toContain('isError');
    const requesterMembership = members.get('api-key-caller')!;
    members.delete('api-key-caller');
    expect(
      await mcp(
        'bureau.reviews.resolve',
        { id: nextReview, decision: 'approve', round: 0 },
        reviewer,
      ),
    ).toContain('isError');
    expect(await processor.submissions()).toBe(0);
    members.set('api-key-caller', requesterMembership);
    expect(
      await mcp(
        'bureau.reviews.resolve',
        { id: nextReview, decision: 'approve', round: 0 },
        reviewer,
      ),
    ).toContain('superseded');
    expect(
      await mcp(
        'bureau.reviews.resolve',
        { id: nextReview, decision: 'approve', round: 0 },
        reviewer,
      ),
    ).toContain('isError');
    expect(
      await mcp(
        'bureau.reviews.resolve',
        { id: nextReview, decision: 'approve', round: 1 },
        reviewer,
      ),
    ).toContain('applied');
    expect(await processor.submissions()).toBe(1);
    const rejected = await refundRpc(
      'demo.refunds.request',
      { ...refundRequest, commandId: 'mcp-rejection', cents: 1000 },
      machine,
    );
    await refundWorker?.idle();
    const rejectedRefund = await ledger.get(rejected.result?.['refundId'] as string);
    expect(rejectedRefund?.reviewId).toBeDefined();
    expect(
      await mcp(
        'bureau.reviews.resolve',
        { id: rejectedRefund!.reviewId, decision: 'reject', reason: 'Wrong order', round: 0 },
        reviewer,
      ),
    ).toContain('Wrong order');
    await refundWorker?.idle();
    const rejectedFinal = await ledger.get(rejectedRefund!.id);
    expect(rejectedFinal?.status).toBe('failed');
    for (const [cookie, expected] of [
      [administrator.cookie!, 'admin'],
      [member.cookie!, 'member'],
    ] as const) {
      const response = await send('/api/v1/principal', { headers: { cookie } });
      expect(await response.json()).toMatchObject({
        method: 'browser-session',
        subject: expected,
        scopes: ['system:read', 'reviews:read'],
        workspace: { workspaceId, actorId: expected },
      });
    }
    const administratorSocket = await openSocket(administrator.cookie!);
    const memberSocket = await openSocket(member.cookie!);
    const administratorSocketIdentity = await socketPrincipal(administratorSocket);
    const memberSocketIdentity = await socketPrincipal(memberSocket);
    expect(administratorSocketIdentity.result.workspace.actorId).toBe('admin');
    expect(memberSocketIdentity.result.workspace.actorId).toBe('member');
    const adminPage = await send('/settings/api-keys', {
      headers: { cookie: administrator.cookie! },
    });
    const memberPage = await send('/settings/api-keys', { headers: { cookie: member.cookie! } });
    expect(adminPage.headers.get('cache-control')).toBe('private, no-store');
    const adminPageText = await adminPage.text();
    const memberPageText = await memberPage.text();
    expect(adminPageText).toContain('owner:admin');
    expect(adminPageText).not.toContain('owner:member');
    expect(memberPageText).toContain('owner:member');
    expect(memberPageText).not.toContain('owner:admin');
    const browserAsset = await send('/_assets/client.js', {});
    expect(browserAsset.status).toBe(200);
    expect(await browserAsset.text()).toBe(clientScript);
    const assetHead = await send('/_assets/client.js', { method: 'HEAD' });
    expect(assetHead.status).toBe(200);
    expect(await assetHead.text()).toBe('');
    const pageAction = (origin: string, cookie?: string) =>
      send('/settings/api-keys', {
        method: 'POST',
        headers: {
          origin,
          ...(cookie ? { cookie } : {}),
          'content-type': 'application/x-www-form-urlencoded',
          'x-velveteen-action': 'true',
        },
        body: '',
      });
    const anonymousAction = await pageAction('https://settings.example');
    expect(anonymousAction.status).toBe(401);
    const foreignAction = await pageAction('https://outside.example', member.cookie);
    expect(foreignAction.status).toBe(403);
    const ownAction = await pageAction('https://settings.example', member.cookie);
    expect(ownAction.status).toBe(200);
    expect(await ownAction.text()).toContain('member');

    const remote = createRemoteClient<typeof privateRemotes>({
      baseURL: 'https://settings.example',
      invalidate: () => {},
      fetch: (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set('origin', 'https://settings.example');
        headers.set('cookie', administrator.cookie!);
        return send(new URL(request.url).pathname, {
          method: request.method,
          body: request.body,
          headers: Object.fromEntries(headers),
        });
      },
    });
    expect(await remote.call('member', null)).toBe('admin');

    const listKeys = (cookie: string) =>
      send('/host/api-keys/jsonrpc', {
        method: 'POST',
        headers: { cookie, origin: 'https://settings.example', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.keys.list', params: {} }),
      });
    const adminKeysResponse = await listKeys(administrator.cookie!);
    const adminKeys = await adminKeysResponse.json();
    expect(adminKeys.result.targets).toEqual([{ subject: 'service', scopes: ['reviews:read'] }]);
    const memberKeys = await listKeys(member.cookie!);
    expect(memberKeys.status).toBe(403);
    expect(await memberKeys.text()).not.toContain('service');
    const managementSession = await send('/auth/session', {
      headers: { cookie: administrator.cookie! },
    });
    const managementCsrf = await managementSession.json();
    holdKeyTargets = true;
    const pendingIssue = send('/host/api-keys/jsonrpc', {
      method: 'POST',
      headers: {
        cookie: administrator.cookie!,
        origin: 'https://settings.example',
        'x-csrf-token': managementCsrf.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'api.keys.issue',
        params: { label: 'revoked while issuing', subject: 'service', scopes: ['reviews:read'] },
      }),
    });
    await keyTargetsStarted.promise;
    const administratorMembership = members.get('admin')!;
    members.delete('admin');
    releaseKeyTargets.resolve();
    const refusedIssue = await pendingIssue;
    expect(refusedIssue.status).toBe(403);
    expect(await refusedIssue.text()).not.toContain('secret');
    holdKeyTargets = false;
    members.set('admin', administratorMembership);
    const keysAfterRefusal = await listKeys(administrator.cookie!);
    const keysAfterRefusalBody = await keysAfterRefusal.json();
    expect(keysAfterRefusalBody.result.keys).toEqual([]);
    for (const headers of [
      { 'x-api-key': 'machine-api-key' },
      { authorization: 'Bearer connector-token' },
      { 'x-api-key': 'model-provider-key' },
      { 'x-api-key': 'engine-relay-key' },
      { authorization: 'Bearer deployment-operator' },
    ]) {
      const response = await send('/host/api-keys/jsonrpc', {
        method: 'POST',
        headers: {
          ...headers,
          cookie: administrator.cookie!,
          origin: 'https://settings.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.keys.list', params: {} }),
      });
      expect(response.status).toBe(403);
    }
    const administratorPrivate = await readPrivate(administrator.cookie);
    const memberPrivate = await readPrivate(member.cookie);
    expect(await administratorPrivate.text()).toContain(run.id);
    expect(await memberPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    const live = await host.bureau.tasks.start('waiting', 'ordinary input', {
      principal: 'owner:admin',
    });
    await streamStarted.promise;
    const streamPath = `/bureau/ag-ui/runs/${encodeURIComponent(live.id)}`;
    const stream = await send(streamPath, {
      headers: {
        cookie: administrator.cookie!,
        accept: 'text/event-stream',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read();
    const strangerStream = await send(streamPath, {
      headers: {
        cookie: member.cookie!,
        accept: 'text/event-stream',
        'sec-fetch-site': 'same-origin',
      },
    });
    const strangerStreamText = await strangerStream.text();
    expect(strangerStreamText).toContain('RUN_NOT_FOUND');
    expect(strangerStreamText).not.toContain('PRIVATE-STREAM-SENTINEL');
    for (const unadmitted of ['stranger', 'removed']) {
      const denied = await signIn(unadmitted);
      const deniedPrivate = await readPrivate();
      expect(denied.result.status).toBe(400);
      expect(await deniedPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    }
    acceptedIssuer = 'https://wrong.example';
    const wrongIssuer = await signIn('admin');
    const wrongIssuerPrivate = await readPrivate();
    expect(wrongIssuer.result.status).toBe(400);
    expect(await wrongIssuerPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    acceptedIssuer = issuer;
    const csrfResponse = await send('/auth/session', {
      headers: { cookie: administrator.cookie! },
    });
    const csrf = await csrfResponse.json();
    holdLoad = true;
    const stalePage = send('/settings/api-keys', { headers: { cookie: administrator.cookie! } });
    await loadStarted.promise;
    for (const headers of [
      { origin: 'https://evil.example', 'x-csrf-token': csrf.csrfToken },
      { origin: 'https://settings.example' },
    ]) {
      const deniedSignOut = await send('/auth/sign-out', {
        method: 'POST',
        headers: { ...headers, cookie: administrator.cookie! },
      });
      expect(deniedSignOut.status).toBe(403);
    }
    const signedOut = await send('/auth/sign-out', {
      method: 'POST',
      headers: {
        origin: 'https://settings.example',
        'x-csrf-token': csrf.csrfToken,
        cookie: administrator.cookie!,
      },
    });
    expect(signedOut.status).toBe(303);
    releaseLoad.resolve();
    const stalePageResponse = await stalePage;
    expect(stalePageResponse.status).toBe(403);
    expect(await stalePageResponse.text()).not.toContain('admin');
    holdLoad = false;
    expect(await socketAfterRevocation(administratorSocket)).not.toContain('admin');
    releaseStream.resolve();
    let streamed = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    expect(streamed).not.toContain('PRIVATE-STREAM-SENTINEL');
    await live.result();
    const signedOutPrincipal = await send('/api/v1/principal', {
      headers: { cookie: administrator.cookie! },
    });
    expect(signedOutPrincipal.status).toBe(401);
    const signedOutPrivate = await readPrivate(administrator.cookie);
    expect(await signedOutPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    members.delete('member');
    expect(await socketAfterRevocation(memberSocket)).not.toContain('member');
    const removedPrincipal = await send('/api/v1/principal', {
      headers: { cookie: member.cookie! },
    });
    expect(removedPrincipal.status).toBe(401);
    const removedPage = await send('/settings/api-keys', { headers: { cookie: member.cookie! } });
    expect(await removedPage.text()).not.toContain('member');
    const removedPrivate = await readPrivate(member.cookie);
    expect(await removedPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    const registration = await send('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Listener fixture',
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json();
    const authorization = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge('a'.repeat(64)),
      code_challenge_method: 'S256',
      scope: 'reviews:read',
      resource: 'https://settings.example/bureau/mcp',
      state: 'original-state',
    });
    const continuation = await signIn('admin', `/oauth/authorize?${authorization}`);
    expect(continuation.result.status).toBe(303);
    const returned = new URL(continuation.result.headers.get('location')!);
    expect(returned.origin).toBe('https://settings.example');
    expect(returned.pathname).toBe('/oauth/authorize');
    expect(returned.searchParams.get('client_id')).toBe(registered.client_id);
    expect(returned.searchParams.get('scope')).toBe('reviews:read');
    expect(returned.searchParams.get('resource')).toBe('https://settings.example/bureau/mcp');
    const consent = await send(returned.pathname + returned.search, {
      headers: { cookie: continuation.cookie! },
    });
    expect(consent.status).toBe(200);
    const form = await consent.text();
    const approval = await send('/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie: continuation.cookie!,
        origin: 'https://settings.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        transaction: /name="transaction" value="([^"]+)"/.exec(form)![1]!,
        csrf: /name="csrf" value="([^"]+)"/.exec(form)![1]!,
        client_id: registered.client_id,
        decision: 'approve',
      }),
    });
    expect(approval.status).toBe(302);
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    const exchange = await send('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'a'.repeat(64),
        resource: 'https://settings.example/bureau/mcp',
      }),
    });
    expect(exchange.status).toBe(200);
    const token = await exchange.json();
    const discovery = await send('/bureau/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    const tools = await discovery.text();
    expect(tools).toContain('bureau.tasks.get');
    expect(tools).not.toContain('bureau.tasks.cancel');
    expect(tools).not.toContain('bureau.reviews.list');
    const connector = (name: string, argumentsValue: object) =>
      send('/bureau/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: argumentsValue },
        }),
      });
    const allowedRead = await connector('bureau.tasks.get', { taskId: run.id });
    expect(await allowedRead.text()).toContain(run.id);
    const deniedWrite = await connector('bureau.tasks.cancel', { taskId: run.id });
    expect(await deniedWrite.text()).toContain('error');
    const deniedRead = await connector('bureau.reviews.list', {});
    expect(await deniedRead.text()).toContain('error');
    const connectorKeys = await send('/host/api-keys/jsonrpc', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.keys.list', params: {} }),
    });
    expect(connectorKeys.status).toBe(403);
    const wrongSurface = await send('/api/v1/principal', {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(wrongSurface.status).toBe(401);
    const resourceCall = await send('/bureau/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'ui://private' },
      }),
    });
    expect(resourceCall.status).toBe(403);
    const connectedHeaders = {
      cookie: continuation.cookie!,
      origin: 'https://settings.example',
      'content-type': 'application/json',
    };
    const connections = (
      method: string,
      params: object,
      headers: Record<string, string> = connectedHeaders,
    ) =>
      send('/host/connected-apps/jsonrpc', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    const list = await connections('connected.apps.list', {});
    expect(list.headers.get('cache-control')).toBe('private, no-store');
    const connectionInventory = await list.json();
    expect(connectionInventory.result.grants).toEqual([
      expect.objectContaining({
        clientId: registered.client_id,
        clientName: 'Listener fixture',
        resource: 'https://settings.example/bureau/mcp',
        workspace: workspaceId,
        permissions: [{ scope: 'reviews:read', description: expect.any(String), available: true }],
      }),
    ]);
    const selected = connectionInventory.result.grants[0].grantId;
    const unverified = await connections('connected.apps.revoke', { grantId: selected });
    expect(unverified.status).toBe(403);
    const currentSession = await send('/auth/session', {
      headers: { cookie: continuation.cookie! },
    });
    const { csrfToken } = await currentSession.json();
    const revoked = await connections(
      'connected.apps.revoke',
      { grantId: selected },
      {
        ...connectedHeaders,
        'x-csrf-token': csrfToken,
      },
    );
    const revokedBody = await revoked.json();
    expect(revokedBody.result).toEqual({ grantId: selected, status: 'revoked' });
    const disconnected = await connector('bureau.tasks.get', { taskId: run.id });
    expect(disconnected.status).toBe(401);
    const refresh = await send('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: registered.client_id,
        refresh_token: token.refresh_token,
        resource: 'https://settings.example/bureau/mcp',
      }),
    });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: 'invalid_grant' });
    const afterList = await connections('connected.apps.list', {});
    const after = await afterList.json();
    expect(after.result.grants).toEqual([]);
    allowA2a = true;
    const firstA2aKey = await send('/host/api-keys/jsonrpc', {
      method: 'POST',
      headers: { ...connectedHeaders, 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'api.keys.issue',
        params: { label: 'Live service', subject: 'a2a', scopes: ['bureau.assets:read'] },
      }),
    });
    const minted = await firstA2aKey.json();
    if (typeof minted.result?.secret !== 'string')
      throw new Error('First managed A2A key was refused');
    const admittedAsset = await host.bureau.assets!.admit(
      {
        source: { kind: 'inline', bytes: new TextEncoder().encode('service-owned content') },
        declaredMediaType: 'text/plain',
      },
      { id: 'api-key:a2a' },
    );
    await admittedAsset.work.result();
    const serviceHeaders = { 'x-api-key': minted.result.secret };
    const credentialedAsset = await fetch(
      new URL(`/bureau/assets/${admittedAsset.assetId}/content`, host.url),
      {
        headers: serviceHeaders,
      },
    );
    expect(credentialedAsset.status).toBe(200);
    expect(await credentialedAsset.text()).toBe('service-owned content');
    members.delete('admin');
    const removedGrant = await connector('bureau.tasks.get', { taskId: run.id });
    expect(removedGrant.status).toBe(401);
  } finally {
    releaseStream.resolve();
    releaseLoad.resolve();
    releaseKeyTargets.resolve();
    await host.close();
    provider.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

test('loads only explicitly configured local deployment modules', async () => {
  expect(await loadDeploymentOptions({})).toEqual({});
  const scratchDirectory = await mkdtemp(join(tmpdir(), 'interborough-host-configuration-'));
  try {
    const module = join(scratchDirectory, 'configuration.mjs');
    await Bun.write(
      module,
      `export default (factories) => {
      if (!Object.isFrozen(factories)) throw new Error('Expected immutable factory table');
      for (const name of ['oidc', 'reviewedToolOperations', 'createTool', 'createToolbox',
        'approvalOnlyPolicy', 'validateApprovalBinding']) {
        if (typeof factories[name] !== 'function') throw new Error('Missing factory ' + name);
      }
      return {};
    }`,
    );
    expect(await loadDeploymentOptions({ INTERBOROUGH_HOST_CONFIGURATION: module })).toEqual({});
    expect(
      await loadDeploymentOptions({ INTERBOROUGH_HOST_CONFIGURATION: 'relative.mjs' }).catch(
        (error: unknown) => error,
      ),
    ).toMatchObject({ message: expect.stringContaining('absolute local file') });

    const disallowed = join(scratchDirectory, 'disallowed.mjs');
    await Bun.write(disallowed, 'export default () => ({ port: 80 });');
    expect(
      await loadDeploymentOptions({ INTERBOROUGH_HOST_CONFIGURATION: disallowed }).catch(
        (error: unknown) => error,
      ),
    ).toMatchObject({ message: expect.stringContaining('unsupported options') });
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
});
