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
  listAgentDefinitions,
  listAgentRevisions,
  updateAgent,
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
  skillDescriptors: [],
  instructions: 'Be careful.',
};

describe('the models list', () => {
  test('get reads the models a file lists, and null for a file that lists none', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.get': () => ({
        ...readyAgent(),
        definition: { ...readyAgent().definition, models: ['anthropic/sonnet', 'openai/gpt-4.1'] },
      }),
    });

    const detail = await getAgentDefinition('researcher');

    expect(detail.definition?.models).toEqual(['anthropic/sonnet', 'openai/gpt-4.1']);
    stub.restore();
    stub = installBureauStub({ 'bureau.agents.definitions.get': () => readyAgent() });
    const plain = await getAgentDefinition('researcher');
    expect(plain.definition?.models).toBeNull();
  });

  test('update sends the models it is given, and sends none when the definition has none', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
    });

    await updateAgent('researcher', 'hash-1', {
      ...definition,
      models: ['anthropic/sonnet', 'openai/gpt-4.1'],
    });
    await updateAgent('researcher', 'hash-1', definition);

    expect(stub.calls[0]?.params).toMatchObject({
      definition: { models: ['anthropic/sonnet', 'openai/gpt-4.1'] },
    });
    expect(stub.calls[1]?.params).not.toHaveProperty('definition.models');
  });
});

describe('the operations', () => {
  test('get asks for one agent by identifier and parses its detail', async () => {
    stub = installBureauStub({ 'bureau.agents.definitions.get': () => readyAgent() });
    const detail = await getAgentDefinition('researcher');
    expect(stub.calls).toEqual([
      { method: 'bureau.agents.definitions.get', params: { id: 'researcher' } },
    ]);
    expect(detail.hash).toBe('hash-1');
    expect(detail.definition?.skillDescriptors[0]?.id).toBe('cite');
  });

  test('get refuses an answer that is not an agent', async () => {
    stub = installBureauStub({ 'bureau.agents.definitions.get': () => ({ items: [] }) });
    const failure = await getAgentDefinition('researcher').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
  });

  test('get keeps a key of a skill that this client does not know', async () => {
    const skill = { id: 'cite', name: 'Cite', description: 'Cites', tags: [], futureKey: [1, 2] };
    const agent = readyAgent();
    stub = installBureauStub({
      'bureau.agents.definitions.get': () => ({
        ...agent,
        definition: agent.definition && { ...agent.definition, skillDescriptors: [skill] },
      }),
    });
    const detail = await getAgentDefinition('researcher');
    expect(detail.definition?.skillDescriptors).toEqual([skill]);
  });

  test('list follows the pages to the last, and asks for the largest page', async () => {
    const first = { ...readyAgent(), id: 'one', problem: null };
    stub = installBureauStub({
      'bureau.agents.definitions.list': (params) =>
        params['offset'] === 0
          ? { agents: [first], nextOffset: 100 }
          : { agents: [{ ...first, id: 'two' }], nextOffset: null },
    });
    const listings = await listAgentDefinitions();
    expect(listings.map((listing) => listing.id)).toEqual(['one', 'two']);
    expect(stub.calls.map((call) => call.params)).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
    ]);
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

  test('catalog keeps the abilities and standing of each model, and drops what it does not read', async () => {
    // A row as Bureau's `modelSchema` leaves it: the keys the editor reads, and others it does not.
    const row = {
      descriptorVersion: 1,
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
      aliases: [{ alias: 'sonnet', resolvesTo: 'claude-sonnet-5' }],
      lifecycle: 'stable',
      modalities: {
        text: { input: true, output: true, sourceForms: [] },
        image: { input: true, output: false, sourceForms: ['base64'] },
      },
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      structuredOutput: true,
      availability: 'unavailable',
      health: 'healthy',
    };
    stub = installBureauStub({
      'bureau.agents.catalog': () => ({ models: [row], tools: [] }),
    });
    const catalog = await getAgentCatalog();
    expect(catalog.models).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        aliases: [{ alias: 'sonnet', resolvesTo: 'claude-sonnet-5' }],
        lifecycle: 'stable',
        availability: 'unavailable',
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 64_000,
        streaming: true,
        tools: true,
        structuredOutput: true,
        modalities: { text: { input: true }, image: { input: true } },
      },
    ]);
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

  test('update names the hash the caller read, and carries the A2A opt-in the definition states', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
    });
    await updateAgent('researcher', 'hash-1', { ...definition, a2a: true });
    expect(stub.calls[0]?.params).toEqual({
      id: 'researcher',
      expectedHash: 'hash-1',
      definition: { ...definition, a2a: true },
    });
  });

  test('delete names the hash', async () => {
    stub = installBureauStub({
      'bureau.agents.definitions.delete': () => ({ id: 'researcher', hash: 'h-deleted' }),
    });
    const deleted = await deleteAgent('researcher', 'hash-1');
    expect(deleted.hash).toBe('h-deleted');
    expect(stub.calls).toEqual([
      {
        method: 'bureau.agents.definitions.delete',
        params: { id: 'researcher', expectedHash: 'hash-1' },
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

  test('names each issue of an InvalidParams fault after the fault’s own message', () => {
    expect(
      agentFaultOf(
        wireFault(
          {
            weftCode: 'InvalidParams',
            httpStatus: 400,
            issues: [
              {
                code: 'unrecognized_keys',
                path: ['definition'],
                message: 'Unrecognized key: "retries"',
              },
            ],
          },
          'invalid params',
        ),
      ),
    ).toEqual({
      kind: 'rejected',
      message: 'invalid params: definition: Unrecognized key: "retries"',
    });
  });

  test('joins several issues with semicolons, a path with dots, and gives an empty path the message alone', () => {
    expect(
      agentFaultOf(
        wireFault(
          {
            weftCode: 'InvalidParams',
            httpStatus: 400,
            issues: [
              { path: ['definition', 'steps', 0, 'name'], message: 'Required' },
              { path: [], message: 'Unrecognized key: "owner"' },
              { path: ['id'], message: 'Too long' },
            ],
          },
          'invalid params',
        ),
      ),
    ).toEqual({
      kind: 'rejected',
      message:
        'invalid params: definition.steps.0.name: Required; Unrecognized key: "owner"; id: Too long',
    });
  });

  test('keeps the fault’s message alone when an InvalidParams fault carries no issues', () => {
    for (const issues of [undefined, [], 'nope']) {
      expect(
        agentFaultOf(
          wireFault(
            {
              weftCode: 'InvalidParams',
              httpStatus: 400,
              ...(issues === undefined ? {} : { issues }),
            },
            'invalid params',
          ),
        ),
      ).toEqual({ kind: 'rejected', message: 'invalid params' });
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
    expect(agentFaultOf('nope')).toEqual({ kind: 'other', message: 'The server did not answer.' });
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
