import {
  createOperationHandler,
  defineOperation,
  type OperationHandlerAuthenticate,
  type Principal,
} from '@lostgradient/backchannel';
import { readRestBodyBounded } from '@lostgradient/backchannel/internals';
import type { ApiKeyMetadata, createApiKeys } from '@lostgradient/credentials/api-keys';
import { z } from 'zod';

type KeyService = ReturnType<typeof createApiKeys<Principal>>;
type Target = { subject: string; scopes: string[] };

/** Host policy is consulted again for every request, including each command. */
export type ApiKeyManagementHost = {
  keys: KeyService;
  currentManager: (principal: Principal) => Promise<boolean>;
  targets: (principal: Principal) => Promise<Target[]>;
  allowedActions: (principal: Principal, key: ApiKeyMetadata) => Promise<('rotate' | 'revoke')[]>;
  overlapCutoff: () => number;
};

const keyMetadata = z.object({
  id: z.string(),
  label: z.string(),
  workspaceId: z.string(),
  subject: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number().optional(),
  revokedAt: z.number().optional(),
  retiresAt: z.number().optional(),
});
const empty = z.object({});
const idInput = z.object({ id: z.string().min(1) });
const issueInput = z.object({
  label: z.string().min(1),
  subject: z.string().min(1),
  scopes: z.array(z.string().min(1)),
  expiresAt: z.number().optional(),
});
const issueOutput = z.object({ id: z.string(), secret: z.string() });
const rotateOutput = issueOutput.extend({ retiresAt: z.number() });
const revokeOutput = z.object({ id: z.string(), revoked: z.boolean() });
const common = {
  mcpExposable: false,
  tags: ['API keys'],
  access: { kind: 'authenticated' as const },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
};

async function admitted(principal: Principal, host: ApiKeyManagementHost) {
  return (
    principal.method !== 'unauthenticated' &&
    principal.method !== 'api-key' &&
    principal.workspace !== undefined &&
    principal.workspace.actorKind !== 'service' &&
    principal.workspace.capabilities.includes('workspace:use') &&
    principal.workspace.capabilities.includes('workspace:manage') &&
    (await host.currentManager(principal))
  );
}

async function authority(principal: Principal, host: ApiKeyManagementHost) {
  const workspaceId =
    principal.method === 'unauthenticated' ? undefined : principal.workspace?.workspaceId;
  if (!workspaceId || !(await admitted(principal, host))) throw new Error('Forbidden');
  return { workspaceId, targets: await host.targets(principal) };
}

async function visible(principal: Principal, host: ApiKeyManagementHost) {
  const context = await authority(principal, host);
  const entries = await Promise.all(
    context.targets.map(async ({ subject }) =>
      host.keys.list(principal, { workspaceId: context.workspaceId, subject }),
    ),
  );
  return { ...context, keys: entries.flat() };
}

async function findKey(principal: Principal, host: ApiKeyManagementHost, id: string) {
  const context = await visible(principal, host);
  const key = context.keys.find((entry) => entry.id === id);
  if (!key) throw new Error('Credential unavailable');
  return { ...context, key };
}

const authorize = async ({
  principal,
  host,
}: {
  principal: Principal;
  host: ApiKeyManagementHost;
}) =>
  (await admitted(principal, host))
    ? { allowed: true as const }
    : { allowed: false as const, classification: 'forbidden' as const, reason: 'Forbidden' };

const listOutput = z.object({
  keys: z.array(keyMetadata.extend({ actions: z.array(z.string()) })),
  targets: z.array(z.object({ subject: z.string(), scopes: z.array(z.string()) })),
});
const list = defineOperation<typeof empty, typeof listOutput, ApiKeyManagementHost>({
  ...common,
  name: 'api.keys.list',
  summary: 'List API keys',
  destructive: false,
  inputSchema: empty,
  outputSchema: listOutput,
  behavior: { kind: 'read' },
  authorize,
  invoke: async ({ principal, host }) => {
    const result = await visible(principal, host);
    return {
      keys: await Promise.all(
        result.keys.map(async (key) => ({
          ...key,
          actions: await host.allowedActions(principal, key),
        })),
      ),
      targets: result.targets,
    };
  },
});
const issue = defineOperation<typeof issueInput, typeof issueOutput, ApiKeyManagementHost>({
  ...common,
  name: 'api.keys.issue',
  summary: 'Issue an API key',
  destructive: true,
  inputSchema: issueInput,
  outputSchema: issueOutput,
  behavior: { kind: 'command', responseDisposition: 'one-time', invalidates: ['api.keys.list'] },
  authorize,
  invoke: async ({ input, principal, host }) => {
    const { label, subject, expiresAt } = input;
    const scopes = [...input.scopes];
    const context = await authority(principal, host);
    const target = context.targets.find((entry) => entry.subject === subject);
    if (!target || scopes.some((scope) => !target.scopes.includes(scope)))
      throw new Error('Forbidden');
    const result = await host.keys.issue(principal, {
      label,
      subject,
      scopes,
      workspaceId: context.workspaceId,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return { id: result.id, secret: result.secret };
  },
});
const rotate = defineOperation<typeof idInput, typeof rotateOutput, ApiKeyManagementHost>({
  ...common,
  name: 'api.keys.rotate',
  summary: 'Rotate an API key',
  destructive: true,
  inputSchema: idInput,
  outputSchema: rotateOutput,
  behavior: { kind: 'command', responseDisposition: 'one-time', invalidates: ['api.keys.list'] },
  authorize,
  invoke: async ({ input, principal, host }) => {
    const { id } = input;
    const context = await findKey(principal, host, id);
    const actions = await host.allowedActions(principal, context.key);
    if (!actions.includes('rotate')) throw new Error('Forbidden');
    const retiresAt = host.overlapCutoff();
    const result = await host.keys.rotate(principal, {
      workspaceId: context.workspaceId,
      subject: context.key.subject,
      id,
      retiresAt,
    });
    return { id: result.id, secret: result.secret, retiresAt };
  },
});
const revoke = defineOperation<typeof idInput, typeof revokeOutput, ApiKeyManagementHost>({
  ...common,
  name: 'api.keys.revoke',
  summary: 'Revoke an API key',
  destructive: true,
  inputSchema: idInput,
  outputSchema: revokeOutput,
  behavior: { kind: 'command', invalidates: ['api.keys.list'] },
  authorize,
  invoke: async ({ input, principal, host }) => {
    const { id } = input;
    const context = await findKey(principal, host, id);
    const actions = await host.allowedActions(principal, context.key);
    if (!actions.includes('revoke')) throw new Error('Forbidden');
    await host.keys.revoke(principal, {
      workspaceId: context.workspaceId,
      subject: context.key.subject,
      id,
    });
    return { id, revoked: true };
  },
});

export const apiKeyManagementOperations = [list, issue, rotate, revoke] as const;

/** Serve the management catalog behind a session authenticator and browser write guard. */
export function createApiKeyManagementHandler(options: {
  host: ApiKeyManagementHost;
  authenticateSession: OperationHandlerAuthenticate;
  publicOrigin: string;
  guardWrite: (request: Request) => Promise<boolean>;
  guardTrustedOperatorWrite?: (request: Request) => Promise<boolean>;
}) {
  const origin = new URL(options.publicOrigin).origin;
  const handler = createOperationHandler({
    operations: apiKeyManagementOperations,
    host: options.host,
    authenticate: options.authenticateSession,
    publicPaths: [],
  });
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/key-admin/jsonrpc' || request.method !== 'POST')
      return new Response('Not found', {
        status: 404,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    let bytes: Uint8Array;
    try {
      bytes = await readRestBodyBounded(request);
    } catch (error) {
      const tooLarge =
        typeof error === 'object' &&
        error !== null &&
        Object.hasOwn(error, 'code') &&
        (error as { code: unknown }).code === 'PayloadTooLarge';
      return new Response(tooLarge ? 'Payload Too Large' : 'Bad Request', {
        status: tooLarge ? 413 : 400,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    const buffered = new Request(request, { method: 'POST', body: bytes.buffer as ArrayBuffer });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = undefined;
    }
    const calls = Array.isArray(body) ? body : [body];
    const writes = calls.some(
      (call) =>
        typeof call === 'object' &&
        call !== null &&
        'method' in call &&
        (call.method === 'api.keys.issue' ||
          call.method === 'api.keys.rotate' ||
          call.method === 'api.keys.revoke'),
    );
    if (writes) {
      const requestOrigin = request.headers.get('origin');
      let allowed = false;
      try {
        allowed =
          requestOrigin === origin
            ? await options.guardWrite(buffered.clone())
            : requestOrigin === null &&
              options.guardTrustedOperatorWrite !== undefined &&
              (await options.guardTrustedOperatorWrite(buffered.clone()));
      } catch {
        return new Response('Write guard unavailable', {
          status: 503,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
      if (!allowed)
        return new Response('Forbidden', {
          status: 403,
          headers: { 'Cache-Control': 'private, no-store' },
        });
    }
    url.pathname = '/jsonrpc';
    const response = await handler(new Request(url, buffered));
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
