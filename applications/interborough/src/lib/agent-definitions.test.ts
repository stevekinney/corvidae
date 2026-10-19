/**
 * The agent definition client: each operation sends the method and params the Bureau expects and
 * parses what it answers, and {@link agentFaultOf} sorts a thrown fault by the wire fault code.
 * `Conflict` and `StaleRevision` share HTTP status 409, so the code, not the status, tells them
 * apart, and the literal envelopes below are what the Bureau handler puts on the wire.
 */
import { HttpClientError } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  agentFaultOf,
  createAgent,
  deleteAgent,
  getAgentCatalog,
  getAgentDefinition,
  listAgentRevisions,
  publishAgent,
  updateAgent,
  withdrawAgent,
  type AgentDefinitionInput,
} from './agent-definitions.ts';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  revisionFixture,
  type BureauStub,
} from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const definition: AgentDefinitionInput = {
  name: 'Researcher',
  description: null,
  model: 'anthropic/sonnet',
  tools: ['lookup-order'],
  skills: [],
  instructions: 'Be careful.',
};

describe('the operations', () => {
  test('get asks for one agent by identifier and parses its detail', async () => {
    stub = installBureauStub({ 'bureau.agents.definitions.get': () => readyAgent() });
    const detail = await getAgentDefinition('researcher');
    expect(stub.calls).toEqual([
      { method: 'bureau.agents.definitions.get', params: { id: 'researcher' } },
    ]);
    expect(detail.hash).toBe('hash-1');
    expect(detail.definition?.skills[0]?.id).toBe('cite');
  });

  test('get refuses an answer that is not an agent', async () => {
    stub = installBureauStub({ 'bureau.agents.definitions.get': () => ({ items: [] }) });
    const failure = await getAgentDefinition('researcher').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
  });

  test('revisions lists the versions that have run', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.revisions': () => ({
        revisions: [revisionFixture('aaaaaaaa11', '2026-10-19T10:00:00.000Z')],
      }),
    });
    const revisions = await listAgentRevisions('researcher');
    expect(revisions).toEqual([revisionFixture('aaaaaaaa11', '2026-10-19T10:00:00.000Z')]);
    expect(stub.calls[0]?.params).toEqual({ id: 'researcher' });
  });

  test('catalog lists the models and tools', async () => {
    stub = installBureauStub({ 'bureau.agents.catalog': () => catalogFixture() });
    const catalog = await getAgentCatalog();
    expect(catalog.models.map((model) => model.model)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-5',
    ]);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['lookup-order']);
    expect(stub.calls[0]?.params).toEqual({});
  });

  test('create names the identifier and the definition, and answers the hash', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.create': () => ({ id: 'researcher', hash: 'new-hash' }),
    });
    expect(await createAgent('researcher', definition)).toEqual({
      id: 'researcher',
      hash: 'new-hash',
    });
    expect(stub.calls[0]?.params).toEqual({ id: 'researcher', definition });
  });

  test('update names the hash the caller read, and the definition has no published key', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
    });
    await updateAgent('researcher', 'hash-1', definition);
    expect(stub.calls[0]?.params).toEqual({ id: 'researcher', expectedHash: 'hash-1', definition });
    expect(Object.keys(definition)).not.toContain('published');
  });

  test('publish, withdraw, and delete each name the hash', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.publish': () => ({ id: 'researcher', hash: 'h-published' }),
      'bureau.agents.definitions.withdraw': () => ({ id: 'researcher', hash: 'h-withdrawn' }),
      'bureau.agents.definitions.delete': () => ({ id: 'researcher', hash: 'h-deleted' }),
    });
    const published = await publishAgent('researcher', 'hash-1');
    const withdrawn = await withdrawAgent('researcher', 'h-published');
    const deleted = await deleteAgent('researcher', 'h-withdrawn');
    expect([published.hash, withdrawn.hash, deleted.hash]).toEqual([
      'h-published',
      'h-withdrawn',
      'h-deleted',
    ]);
    expect(stub.calls).toEqual([
      {
        method: 'bureau.agents.definitions.publish',
        params: { id: 'researcher', expectedHash: 'hash-1' },
      },
      {
        method: 'bureau.agents.definitions.withdraw',
        params: { id: 'researcher', expectedHash: 'h-published' },
      },
      {
        method: 'bureau.agents.definitions.delete',
        params: { id: 'researcher', expectedHash: 'h-withdrawn' },
      },
    ]);
  });
});

/** The error `callBureau` throws for a fault envelope's `error.data`. */
function wireFault(data: Record<string, unknown>, message = 'It failed.'): HttpClientError {
  const status = typeof data['httpStatus'] === 'number' ? data['httpStatus'] : 500;
  return new HttpClientError(status, message, { data });
}

describe('agentFaultOf', () => {
  test('tells StaleRevision from Conflict although both answer 409', () => {
    const stale = wireFault({ weftCode: 'StaleRevision', httpStatus: 409, currentRevision: 'abc' });
    const taken = wireFault({ weftCode: 'Conflict', httpStatus: 409, reason: 'agent-file-exists' });
    expect(stale.status).toBe(taken.status);
    expect(agentFaultOf(stale)).toEqual({ kind: 'stale', currentHash: 'abc' });
    expect(agentFaultOf(taken)).toEqual({
      kind: 'identifier-taken',
      reason: 'agent-file-exists',
    });
  });

  test('keeps the hash null when a stale answer carries none', () => {
    expect(agentFaultOf(wireFault({ weftCode: 'StaleRevision', httpStatus: 409 }))).toEqual({
      kind: 'stale',
      currentHash: null,
    });
  });

  test('names an identifier that shadows a code-defined agent', () => {
    expect(
      agentFaultOf(
        wireFault({ weftCode: 'Conflict', httpStatus: 409, reason: 'shadows-code-agent' }),
      ),
    ).toEqual({ kind: 'identifier-taken', reason: 'shadows-code-agent' });
  });

  test('treats a Conflict with another reason as an ordinary failure, in the Bureau’s words', () => {
    expect(
      agentFaultOf(wireFault({ weftCode: 'Conflict', httpStatus: 409, reason: 'other' }, 'Busy.')),
    ).toEqual({ kind: 'other', message: 'Busy.' });
  });

  test('sorts NotFound, Forbidden, and a definition that would not load', () => {
    expect(agentFaultOf(wireFault({ weftCode: 'NotFound', httpStatus: 404 }))).toEqual({
      kind: 'not-found',
    });
    expect(agentFaultOf(wireFault({ weftCode: 'Forbidden', httpStatus: 403 }))).toEqual({
      kind: 'forbidden',
    });
    for (const weftCode of ['Unprocessable', 'InvalidParams', 'UnsupportedCapability']) {
      expect(agentFaultOf(wireFault({ weftCode, httpStatus: 422 }, 'Not valid.'))).toEqual({
        kind: 'rejected',
        message: 'Not valid.',
      });
    }
  });

  test('sorts an HTTP error with no wire fault code, and an error that is not an HTTP answer', () => {
    expect(agentFaultOf(new HttpClientError(502, 'Bad gateway'))).toEqual({
      kind: 'other',
      message: 'Bad gateway',
    });
    expect(agentFaultOf(new TypeError('Failed to fetch'))).toEqual({
      kind: 'other',
      message: 'Failed to fetch',
    });
    expect(agentFaultOf('nope')).toEqual({ kind: 'other', message: 'The Bureau did not answer.' });
  });

  test('reads the faults the stub puts on the wire, end to end through the client', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.update': () => {
        throw faults.stale('current-hash');
      },
      'bureau.agents.definitions.create': () => {
        throw faults.taken('shadows-code-agent');
      },
      'bureau.agents.definitions.delete': () => {
        throw faults.notFound('researcher');
      },
    });
    const caught = async (call: Promise<unknown>) =>
      agentFaultOf(
        await call.then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
    expect(await caught(updateAgent('researcher', 'hash-1', definition))).toEqual({
      kind: 'stale',
      currentHash: 'current-hash',
    });
    expect(await caught(createAgent('assistant', definition))).toEqual({
      kind: 'identifier-taken',
      reason: 'shadows-code-agent',
    });
    expect(await caught(deleteAgent('researcher', 'hash-1'))).toEqual({ kind: 'not-found' });
  });
});
