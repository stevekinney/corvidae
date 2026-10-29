/**
 * A Bureau over a temporary workflow directory, served as the handler serves it to an API-key
 * caller and to the deployment's owner (COR-1527, COR-1528). The tests share it so the owner
 * predicate is exercised the same way everywhere.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent } from '@lostgradient/operative';
import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  createOperationHandler,
  unauthenticatedLocalAuthContext,
  type AuthenticatedPrincipal,
} from '@lostgradient/weft';

import type { AgentDefinitions } from '../../agent-catalog.ts';
import { createBureau } from '../../create-bureau.ts';
import type { Bureau } from '../../types.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import {
  buildBureauHandlerHost,
  BUREAU_HANDLER_OPERATIONS,
  createBureauHandler,
} from '../create-bureau-handler.ts';
import { authentication, type Handler, type RpcBody } from './management-fixtures.test-support.ts';
import { createMemoryAssetStorage } from '../../assets/storage';
import { workflowFileDirectory } from '../../sources/workflow-file-directory';
import { MemoryStorage } from '@lostgradient/storage';

export interface Served {
  readonly bureau: Bureau;
  readonly directory: string;
  /** Serves API-key callers, by the key the management fixtures define. */
  readonly keyed: Handler;
  /** Serves one `unauthenticated-local` caller who holds no Bureau scope: the owner, with no operator scope. */
  readonly owner: Handler;
}

const agents: AgentDefinitions = {
  writer: createAgent({
    name: 'writer',
    generate: async () => ({ content: 'written', toolCalls: [] }),
  }),
};

export interface ServeOptions {
  readonly onDiagnostic?: (event: { level: string; message: string }) => void;
  /** The code-defined agents. Defaults to `writer`, which answers "written". */
  readonly agents?: AgentDefinitions;
}

export async function serveWorkflows(
  cleanups: Array<() => Promise<void>>,
  options: ServeOptions = {},
): Promise<Served> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-workflow-operations-'));
  const bureau = await createBureau<AgentDefinitions>({
    assets: { storage: createMemoryAssetStorage() },
    id: 'workflows-bureau',
    agents: {
      ...(options.agents ?? agents),
    },
    workflowSource: workflowFileDirectory(directory),
    storage: new MemoryStorage(),
    durable: true,
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
  cleanups.push(async () => {
    await bureau.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const keyed = createBureauHandler(bureau, { authentication });
  const noBureauScopes = new Set<AuthorizationScope>(
    [...(unauthenticatedLocalAuthContext().principal?.scopes ?? AUTHORIZATION_SCOPES)].filter(
      (scope) => !(BUREAU_SCOPES as readonly string[]).includes(scope),
    ),
  );
  const ownerPrincipal: AuthenticatedPrincipal = Object.freeze({
    method: 'unauthenticated-local',
    scopes: noBureauScopes,
    claims: undefined,
    subject: undefined,
    hasScope: (scope: AuthorizationScope) => noBureauScopes.has(scope),
  });
  const owner = createOperationHandler({
    operations: BUREAU_HANDLER_OPERATIONS,
    host: buildBureauHandlerHost(bureau, []),
    authenticate: async () => ({
      method: 'unauthenticated-local' as const,
      principal: ownerPrincipal,
    }),
    publicPaths: [],
  });
  return { bureau, directory, keyed, owner };
}

export async function ownerRpc(
  handler: Handler,
  method: string,
  params: unknown,
): Promise<RpcBody> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as RpcBody;
}
