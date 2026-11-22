import { AUTHORIZATION_SCOPES, WEFT_SCOPE_VOCABULARY } from '@lostgradient/weft';
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
  type AuthConfig,
  type AuthorizationScope,
  createOperationHandler,
  unauthenticatedLocalAuthContext,
  type AuthenticatedPrincipal,
} from '@lostgradient/backchannel';

import type { AgentDefinitions } from '../../agent-catalog.ts';
import { createBureau } from '../../create-bureau.ts';
import type { Bureau } from '../../bureau-types/facade.ts';
import type { BureauOptions } from '../../bureau-types/options.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import {
  buildBureauHandlerHost,
  BUREAU_HANDLER_OPERATIONS,
  createBureauHandler,
} from '../create-bureau-handler.ts';
import { authentication, type Handler, type RpcBody } from './management-fixtures.test-support.ts';
import { createMemoryAssetStorage } from '../../assets/storage';
import { workflowFileDirectory } from '../../sources/workflow-file-directory';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import type { WorkspaceMembershipOptions } from '../workspace-principal.ts';

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
  /** Build a durable Bureau with no `workflowSource`, so it has no workflow directory. */
  readonly withoutDirectory?: boolean;
  /** Shared immutable workspace binding for the Bureau and both test handlers. */
  readonly workspace?: WorkspaceMembershipOptions;
  readonly authentication?: AuthConfig;
  /** Plugins the Bureau loads, for a test that lists a plugin's code workflow. */
  readonly plugins?: BureauOptions<AgentDefinitions>['plugins'];
  /**
   * The runtime services the Bureau runs on: a manual one keeps a retry's timer from firing
   * between two reads of a failed trigger's listener.
   */
  readonly runtime?: BureauOptions<AgentDefinitions>['runtime'];
  /** `manual` leaves the engine's maintenance to the test, as a host that runs it on its own does. */
  readonly maintenance?: 'manual';
  /**
   * The store the Bureau keeps its state in, for a test that reads what it holds. A test that
   * serves a second Bureau over the first's store, as a restart does, passes the same one to both.
   * Defaults to a fresh one.
   */
  readonly storage?: Storage;
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
    ...(options.withoutDirectory === true
      ? {}
      : { workflowSource: workflowFileDirectory(directory) }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
    storage: options.storage ?? new MemoryStorage(),
    durable: true,
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
  cleanups.push(async () => {
    await bureau.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const keyed = createBureauHandler(bureau, {
    authentication: options.authentication ?? authentication,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
  const noBureauScopes = new Set<AuthorizationScope>(
    [
      ...(unauthenticatedLocalAuthContext(WEFT_SCOPE_VOCABULARY).principal?.scopes ??
        AUTHORIZATION_SCOPES),
    ].filter((scope) => !(BUREAU_SCOPES as readonly string[]).includes(scope)),
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
