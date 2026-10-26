/**
 * COR-1559 — `bureau.agents.models` lists the models an agent allows a session to be switched to,
 * and the model its next step would use with no override: for a code-defined agent by the kind of
 * generation profile it has, and for a file agent by its `model` and its optional `models` list.
 */
import {
  type BackendDescriptor,
  createAgent,
  createLazyAgent,
  createModelCatalog,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import { callAs, disposeServed, serve } from './agent-definitions-fixtures.test-support.ts';
import { rpc } from './management-fixtures.test-support.ts';

afterEach(disposeServed);

const catalogRows = createModelCatalog().descriptors;
const rowOf = (provider: string, model: string): BackendDescriptor => {
  const row = catalogRows.find((entry) => entry.provider === provider && entry.model === model);
  if (row === undefined) throw new Error(`The catalog has no ${provider}/${model}.`);
  return row;
};
const OPUS_5_5 = rowOf('anthropic', 'claude-opus-5-5');
const OPUS_5 = rowOf('anthropic', 'claude-opus-5');
const GPT = rowOf('openai', 'gpt-4.1');

const answer = async () => ({ content: 'a', toolCalls: [] as never[] });

function agents() {
  return {
    alpha: createAgent({ name: 'alpha', generate: answer }),
    // Names two candidates the catalog holds and one it does not.
    choosy: createAgent({
      name: 'choosy',
      generate: withBackendDescriptors(answer, [OPUS_5_5]),
      allowedCandidates: [
        { provider: 'anthropic', model: 'claude-opus-5-5' },
        { provider: 'openai', model: 'gpt-4.1' },
        { provider: 'openai', model: 'not-in-the-catalog' },
      ],
    }),
    fixed: createAgent({ name: 'fixed', generate: withBackendDescriptors(answer, [OPUS_5]) }),
    routed: createAgent({
      name: 'routed',
      generate: withBackendDescriptors(answer, [OPUS_5, GPT]),
    }),
  };
}

type ModelsResult = {
  selectable: boolean;
  models: Array<{ provider: string; model: string; displayName: string }>;
  default: { provider: string; model: string } | null;
};

async function modelsOf(served: Awaited<ReturnType<typeof serve>>, agentName: string) {
  const body = await callAs(served.local, 'bureau.agents.models', { agentName });
  return { body, result: body.result as unknown as ModelsResult };
}

describe('bureau.agents.models for a code-defined agent', () => {
  it('lists a selectable agent’s allowedCandidates that the catalog holds, with the default its generate attaches', async () => {
    const served = await serve({ agents: agents() });

    const { result } = await modelsOf(served, 'choosy');

    expect(result).toEqual({
      selectable: true,
      models: [
        { provider: 'anthropic', model: 'claude-opus-5-5', displayName: 'claude-opus-5-5' },
        { provider: 'openai', model: 'gpt-4.1', displayName: 'gpt-4.1' },
      ],
      default: { provider: 'anthropic', model: 'claude-opus-5-5' },
    });
  });

  it('lists the whole catalog for a selectable profile that names no candidates', async () => {
    const everything = createLazyAgent(
      async () => createAgent({ name: 'everything', generate: answer }),
      {
        label: 'everything',
        generationProfile: {
          mode: 'selectable',
          revision: 1,
          projection: 'privileged',
          descriptors: [],
          freshness: '2026-10-22T00:00:00.000Z',
          selector: 'unavailable',
        },
      },
    );
    const served = await serve({ agents: { ...agents(), everything } });

    const { result } = await modelsOf(served, 'everything');

    expect(result.selectable).toBe(true);
    expect(result.default).toBeNull();
    expect(result.models.map((choice) => `${choice.provider}/${choice.model}`).toSorted()).toEqual(
      catalogRows
        .filter((row) => row.lifecycle !== 'retired')
        .map((row) => `${row.provider}/${row.model}`)
        .toSorted(),
    );
  });

  it('reports a fixed agent as not selectable, with its one model as the model and the default', async () => {
    const served = await serve({ agents: agents() });

    const { result } = await modelsOf(served, 'fixed');

    expect(result).toEqual({
      selectable: false,
      models: [{ provider: 'anthropic', model: 'claude-opus-5', displayName: 'claude-opus-5' }],
      default: { provider: 'anthropic', model: 'claude-opus-5' },
    });
  });

  it('reports a routed agent as not selectable, with no models and no default', async () => {
    const served = await serve({ agents: agents() });

    const { result } = await modelsOf(served, 'routed');

    expect(result).toEqual({ selectable: false, models: [], default: null });
  });

  it('reports an opaque agent as not selectable, with no models and no default', async () => {
    const served = await serve({ agents: agents() });

    const { result } = await modelsOf(served, 'alpha');

    expect(result).toEqual({ selectable: false, models: [], default: null });
  });
});

describe('bureau.agents.models for a file agent', () => {
  it('is selectable with the whole catalog when the file lists no models, and defaults to its model', async () => {
    const served = await serve();
    await served.put('picker.md', agentFileText({ model: KNOWN_MODEL }));
    await served.bureau.agents.refresh();

    const { result } = await modelsOf(served, 'picker');

    expect(result.selectable).toBe(true);
    expect(result.default).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(result.models.map((choice) => `${choice.provider}/${choice.model}`).toSorted()).toEqual(
      served.bureau.models
        .catalog()
        .descriptors.filter((row) => row.lifecycle !== 'retired')
        .map((row) => `${row.provider}/${row.model}`)
        .toSorted(),
    );
  });

  it('lists the listed models the catalog holds, in the order the file lists them', async () => {
    const served = await serve();
    await served.put(
      'picker.md',
      agentFileText({
        model: KNOWN_MODEL,
        models: `[openai/gpt-4.1, ${KNOWN_MODEL}, openai/not-in-the-catalog]`,
      }),
    );
    await served.bureau.agents.refresh();

    const { result } = await modelsOf(served, 'picker');

    expect(result).toEqual({
      selectable: true,
      models: [
        { provider: 'openai', model: 'gpt-4.1', displayName: 'gpt-4.1' },
        { provider: 'anthropic', model: 'claude-opus-5-5', displayName: 'claude-opus-5-5' },
      ],
      default: { provider: 'anthropic', model: 'claude-opus-5-5' },
    });
  });

  it('reports the default as the catalog row an alias resolves to, not the frontmatter string', async () => {
    const served = await serve();
    await served.put(
      'picker.md',
      agentFileText({ model: 'anthropic/opus', models: '[anthropic/opus, openai/gpt-4.1]' }),
    );
    await served.bureau.agents.refresh();

    const { result } = await modelsOf(served, 'picker');

    expect(result.default).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(result.models[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      displayName: 'claude-opus-4-8',
    });
  });
});

describe('bureau.agents.models access', () => {
  it('answers an unknown agent as not found', async () => {
    const served = await serve();

    const body = await callAs(served.local, 'bureau.agents.models', { agentName: 'nobody' });

    expect(body.error?.data).toMatchObject({
      weftCode: 'NotFound',
      resource: 'agent',
      identifier: 'nobody',
    });
  });

  it('asks only that the caller be authenticated for a published agent: a caller with no scope reads it', async () => {
    const served = await serve({ agents: agents() });

    const body = await rpc(
      served.keyed,
      'bureau.agents.models',
      { agentName: 'alpha' },
      'alice-key',
    );

    expect(body.error).toBeUndefined();
    expect(body.result?.['selectable']).toBe(false);
  });

  it('answers an unpublished code agent as not found to a caller who may not see it, and describes it to one who may', async () => {
    const served = await serve({ agents: agents() });
    const asKey = (key: string) =>
      rpc(served.keyed, 'bureau.agents.models', { agentName: 'fixed' }, key);

    // `fixed` is not in the publish allowlist: no scope sees exactly what an unknown name sees.
    const hidden = await asKey('alice-key');
    const unknown = await rpc(
      served.keyed,
      'bureau.agents.models',
      { agentName: 'nobody' },
      'alice-key',
    );
    expect(hidden.error?.data).toMatchObject({
      weftCode: 'NotFound',
      resource: 'agent',
      identifier: 'fixed',
    });
    expect(hidden.result).toBeUndefined();
    expect(unknown.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'agent' });
    // The write scope alone does not read, as in `bureau.agents.list`.
    const writer = await asKey('agents-writer-key');
    expect(writer.error?.data).toMatchObject({ weftCode: 'NotFound' });

    const reader = await asKey('agents-reader-key');
    expect(reader.error).toBeUndefined();
    expect(reader.result?.['selectable']).toBe(false);
  });

  it('answers an unpublished agent file as not found to a caller who may not see it', async () => {
    const served = await serve();
    await served.put('drafted.md', agentFileText({ model: KNOWN_MODEL }));
    await served.bureau.agents.refresh();
    const asKey = (key: string) =>
      rpc(served.keyed, 'bureau.agents.models', { agentName: 'drafted' }, key);

    const stranger = await asKey('alice-key');
    expect(stranger.error?.data).toMatchObject({
      weftCode: 'NotFound',
      resource: 'agent',
      identifier: 'drafted',
    });
    const reader = await asKey('agents-reader-key');
    expect(reader.error).toBeUndefined();
    expect(reader.result?.['selectable']).toBe(true);
  });

  it('refuses a request that names no agent, or a key it does not declare', async () => {
    const served = await serve();

    const missing = await callAs(served.local, 'bureau.agents.models', {});
    const extra = await callAs(served.local, 'bureau.agents.models', {
      agentName: 'alpha',
      principal: 'someone',
    });

    expect(missing.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    expect(extra.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
  });
});
