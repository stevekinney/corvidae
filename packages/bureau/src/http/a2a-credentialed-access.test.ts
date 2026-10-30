/**
 * COR-1904 — who reaches what on a handler that serves its own pages anonymously and A2A with a
 * key: `authentication` beside `unauthenticatedAccess: 'allow'`. A request without a credential is
 * the local caller (the owner) everywhere but A2A, whose JSON-RPC routes need a key the card
 * advertises; a wrong key is refused, never served as the owner; and the A2A credential, which
 * holds no `bureau.agents:read`, sees only the agents that opt into A2A.
 *
 * One table, one row per caller, credential, and operation, run against that handler and against
 * one with `authentication` alone, which refuses every request without a credential: the rows that
 * read the local caller apply to the first only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { createAgent } from '@lostgradient/operative';

import { answering, call, message, PUBLIC_URL, send, taskOf } from './a2a-mount.test-support.ts';
import { type OpenedBureau, openBureau } from './management/management-fixtures.test-support.ts';

/** No header at all: the local caller. */
const NONE = undefined;
/** A key no principal stands for. */
const UNKNOWN_KEY = 'not-a-key';
/** A prefix of the A2A key, which must be refused like any other wrong key. */
const PREFIX_KEY = 'a2a-ke';
/** The credential a host hands A2A clients: asset scopes and no operator scope. */
const A2A_KEY = 'a2a-key';
/** A credential holding every Bureau scope. */
const OPERATOR_KEY = 'operator-key';

type Credential = string | undefined;

type Outcome =
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'task'; readonly owner: string }
  | { readonly kind: 'agents'; readonly names: readonly string[] }
  | { readonly kind: 'models' }
  | { readonly kind: 'deployment'; readonly agents: readonly string[] }
  | { readonly kind: 'card'; readonly schemes: readonly string[] };

type Operation =
  | { readonly kind: 'send'; readonly agent: string }
  | { readonly kind: 'get-task' }
  | { readonly kind: 'card'; readonly agent: string }
  | { readonly kind: 'rpc'; readonly method: string; readonly params: unknown };

type Row = {
  readonly caller: string;
  readonly credential: Credential;
  readonly operation: Operation;
  readonly expected: Outcome;
  /** The row reads the local caller, which only a handler with `unauthenticatedAccess` serves. */
  readonly localCaller?: true;
};

const EVERY_AGENT = ['closed', 'default', 'open'];

const ROWS: readonly Row[] = [
  // No credential: the owner on the management plane, refused by A2A.
  {
    caller: 'anonymous',
    credential: NONE,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'anonymous',
    credential: NONE,
    operation: { kind: 'get-task' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'anonymous',
    credential: NONE,
    operation: { kind: 'send', agent: 'closed' },
    expected: { kind: 'not-found' },
    // Without local access the handler refuses it before the mount reads the opt-in.
    localCaller: true,
  },
  {
    caller: 'anonymous',
    credential: NONE,
    operation: { kind: 'card', agent: 'open' },
    expected: { kind: 'card', schemes: ['apiKeyHeader', 'bearer'] },
  },
  {
    caller: 'owner (local)',
    credential: NONE,
    operation: { kind: 'rpc', method: 'bureau.agents.list', params: {} },
    localCaller: true,
    expected: { kind: 'agents', names: EVERY_AGENT },
  },
  {
    caller: 'owner (local)',
    credential: NONE,
    operation: { kind: 'rpc', method: 'bureau.deployment.get', params: {} },
    localCaller: true,
    expected: { kind: 'deployment', agents: EVERY_AGENT },
  },
  // A wrong key is refused everywhere, a prefix of the right one included.
  {
    caller: 'unknown key',
    credential: UNKNOWN_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'prefix of the A2A key',
    credential: PREFIX_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'unknown key',
    credential: UNKNOWN_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.list', params: {} },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'empty key',
    credential: '',
    operation: { kind: 'rpc', method: 'bureau.agents.list', params: {} },
    expected: { kind: 'unauthenticated' },
  },
  // The A2A credential: its own tasks on opted-in agents, and nothing else of the deployment.
  {
    caller: 'A2A credential',
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'task', owner: 'api-key:a2a' },
  },
  {
    caller: 'A2A credential',
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'closed' },
    expected: { kind: 'not-found' },
  },
  {
    caller: 'A2A credential',
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.list', params: {} },
    expected: { kind: 'agents', names: ['open'] },
  },
  {
    caller: 'A2A credential',
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.models', params: { agentName: 'open' } },
    expected: { kind: 'models' },
  },
  {
    caller: 'A2A credential',
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.models', params: { agentName: 'closed' } },
    expected: { kind: 'not-found' },
  },
  {
    caller: 'A2A credential',
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.deployment.get', params: {} },
    expected: { kind: 'forbidden' },
  },
  // A credential holding `bureau.agents:read` keeps the wide view.
  {
    caller: 'operator credential',
    credential: OPERATOR_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.list', params: {} },
    expected: { kind: 'agents', names: EVERY_AGENT },
  },
  {
    caller: 'operator credential',
    credential: OPERATOR_KEY,
    operation: { kind: 'rpc', method: 'bureau.deployment.get', params: {} },
    expected: { kind: 'deployment', agents: EVERY_AGENT },
  },
];

function headersOf(credential: Credential): Record<string, string> {
  return credential === undefined ? {} : { 'X-API-Key': credential };
}

function sortedNames(names: readonly string[]): string[] {
  return names.toSorted((left, right) => left.localeCompare(right));
}

/** What a JSON-RPC answer from the management plane means for the table. */
function managementOutcome(status: number, body: any): Outcome {
  if (status === 401) return { kind: 'unauthenticated' };
  const error = body.error;
  if (error !== undefined) {
    const httpStatus = error.data?.httpStatus;
    if (httpStatus === 404) return { kind: 'not-found' };
    if (httpStatus === 403) return { kind: 'forbidden' };
    throw new Error(`unexpected error ${JSON.stringify(error)}`);
  }
  const result = body.result;
  if (Array.isArray(result.agents) && result.id !== undefined) {
    return { kind: 'deployment', agents: sortedNames(result.agents) };
  }
  if (Array.isArray(result.agents)) {
    return { kind: 'agents', names: sortedNames(result.agents.map((agent: any) => agent.name)) };
  }
  if (typeof result.selectable === 'boolean') return { kind: 'models' };
  throw new Error(`unexpected result ${JSON.stringify(result)}`);
}

async function outcomeOf(opened: OpenedBureau, row: Row): Promise<Outcome> {
  const { operation, credential } = row;
  if (operation.kind === 'card') {
    const response = await opened.handler(
      new Request(`${PUBLIC_URL}/a2a/${operation.agent}/.well-known/agent-card.json`),
    );
    expect(response.status).toBe(200);
    const card: any = await response.json();
    expect(card.securityRequirements.length).toBeGreaterThan(0);
    return { kind: 'card', schemes: sortedNames(Object.keys(card.securitySchemes)) };
  }
  if (operation.kind === 'rpc') {
    const response = await opened.handler(
      new Request(`${PUBLIC_URL}/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headersOf(credential) },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: operation.method,
          params: operation.params,
        }),
      }),
    );
    return managementOutcome(response.status, await response.json());
  }
  const answer =
    operation.kind === 'send'
      ? await send(opened, operation.agent, { message: message('Hello') }, { key: credential })
      : await call(opened, 'open', 'GetTask', { id: 'no-such-task' }, { key: credential });
  if (answer.status === 401) {
    // The refusal is Weft's own: a client cannot tell which layer refused it.
    expect(answer.headers.get('www-authenticate')).toBe('Bearer');
    return { kind: 'unauthenticated' };
  }
  if (answer.status === 404) return { kind: 'not-found' };
  const task = taskOf(answer.body);
  expect(typeof task?.id).toBe('string');
  return { kind: 'task', owner: (await opened.bureau.ownerOf({ kind: 'run', id: task.id }))! };
}

const VARIANTS = [
  { name: 'A2A behind a key, beside an anonymous local caller (COR-1904)', localAccess: true },
  { name: 'A2A and the management plane behind a key (COR-1904)', localAccess: false },
] as const;

for (const variant of VARIANTS)
  describe(variant.name, () => {
    let opened: OpenedBureau;
    beforeAll(async () => {
      opened = await openBureau({
        agents: {
          open: createAgent({ name: 'open', generate: answering('Hi') }),
          closed: createAgent({ name: 'closed', generate: answering('Hi') }),
        },
        a2aAgents: ['open'],
        localAccess: variant.localAccess,
        handlerOptions: { publicUrl: PUBLIC_URL },
      });
    });
    afterAll(async () => {
      await opened.dispose();
    });

    for (const row of ROWS.filter((entry) => variant.localAccess || entry.localCaller !== true)) {
      const name = row.operation.kind === 'rpc' ? row.operation.method : row.operation.kind;
      const target = 'agent' in row.operation ? ` ${row.operation.agent}` : '';
      it(`${row.caller}: ${name}${target} → ${row.expected.kind}`, async () => {
        expect(await outcomeOf(opened, row)).toEqual(row.expected);
      });
    }
  });
