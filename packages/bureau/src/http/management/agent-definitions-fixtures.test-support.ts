/**
 * Shared setup for the agent definition operation tests (COR-1526): a Bureau over an agent
 * directory, served three ways (API-key callers, the owner with no scope, and the local caller
 * with every scope), and the helpers that call and read it.
 */
import { join } from 'node:path';

import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  createOperationHandler,
  unauthenticatedLocalAuthContext,
  type AuthenticatedPrincipal,
} from '@lostgradient/weft';

import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import {
  type FileBureauHarness,
  startFileBureau,
} from '../../testing/agent-file-bureau.test-support.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import {
  buildBureauHandlerHost,
  BUREAU_HANDLER_OPERATIONS,
  createBureauHandler,
} from '../create-bureau-handler.ts';
import { authentication, type Handler, type RpcBody } from './management-fixtures.test-support.ts';
import { runTask } from '../../test';

const harnesses: FileBureauHarness[] = [];
/** Disposes every Bureau `serve` opened, newest first. Call it from `afterEach`. */
export async function disposeServed(): Promise<void> {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
}

export const RESEARCHER = agentFileText(
  { name: 'Researcher', model: KNOWN_MODEL, tools: '[lookup-order]' },
  'You are careful.\n',
);

/** The definition a caller sends to create or update an agent. */
export const DEFINITION = {
  name: 'Writer',
  description: 'Writes things',
  model: KNOWN_MODEL,
  tools: ['lookup-order'],
  instructions: 'Write well.\n',
};

export interface Served extends FileBureauHarness {
  /** Serves API-key callers, by the key the management fixtures define. */
  readonly keyed: Handler;
  /** Serves one `unauthenticated-local` caller who holds no Bureau scope: the owner, with no operator scope. */
  readonly owner: Handler;
  /** Serves one `unauthenticated-local` caller who holds every Bureau scope. */
  readonly local: Handler;
  /** The hash of an agent's file as the catalog has it. */
  hashOf(id: string): string;
}

export async function serve(options: Parameters<typeof startFileBureau>[0] = {}): Promise<Served> {
  const harness = await startFileBureau({
    ...options,
    overrides: { id: 'agents-bureau', ...options.overrides },
  });
  harnesses.push(harness);
  const { bureau } = harness;
  const keyed = createBureauHandler(bureau, { authentication, a2aAgents: ['alpha'] });
  const local = createBureauHandler(bureau, {
    unauthenticatedAccess: 'allow',
    a2aAgents: ['alpha'],
  });
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
    host: buildBureauHandlerHost(bureau, ['alpha']),
    authenticate: async () => ({
      method: 'unauthenticated-local' as const,
      principal: ownerPrincipal,
    }),
    publicPaths: [],
  });
  return {
    ...harness,
    keyed,
    owner,
    local,
    hashOf(id) {
      const hash = bureau.agents.list().find((listing) => listing.id === id)?.definitionHash;
      if (hash === undefined) throw new Error(`Expected a file for "${id}".`);
      return hash;
    },
  };
}

export async function callAs(handler: Handler, method: string, params: unknown): Promise<RpcBody> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as RpcBody;
}

/** The array an operation's result holds under `key`, empty when it holds none. */
export function listOf(response: RpcBody, key: string): Array<Record<string, unknown>> {
  const value = response.result?.[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Writes the researcher file by hand, runs it once, and waits for the catalog to reflect it. */
export async function seed(served: Served): Promise<string> {
  await served.put('researcher.md', RESEARCHER);
  await served.bureau.agents.refresh();
  await runTask(served.bureau, 'researcher', 'hello');
  return served.hashOf('researcher');
}

export const ownerPath = (served: Served, id = 'researcher') => join(served.directory, `${id}.md`);
