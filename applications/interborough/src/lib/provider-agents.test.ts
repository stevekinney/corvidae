import { afterEach, describe, expect, test } from 'bun:test';

import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';
import { listProviderAgents } from './provider-agents.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function agent(name: string, kind: 'code' | 'file') {
  return {
    name,
    displayName: `The ${name}`,
    description: null,
    definitionRevision: 1,
    kind,
    a2a: false,
  };
}

function fileDetail(id: string, model: string, models: string[] | null = null) {
  return {
    id,
    source: 'file',
    state: 'ready',
    name: id,
    description: null,
    a2a: false,
    hash: null,
    problem: null,
    definition: {
      name: id,
      description: null,
      a2a: false,
      model,
      models,
      tools: [],
      skillDescriptors: [],
      instructions: '',
    },
  };
}

function codeDetail(id: string, model: string | null, models: string[]) {
  return {
    id,
    source: 'code',
    state: 'ready',
    name: id,
    description: null,
    a2a: false,
    hash: null,
    problem: null,
    definition: null,
    codeDefinition: {
      name: id,
      description: null,
      model,
      models,
      tools: [],
      skills: [],
      skillDescriptors: [],
      instructions: null,
    },
  };
}

describe('the agents that name a model of a provider', () => {
  test('are the file and code agents whose model, or a model they may switch to, is the provider’s', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({
        agents: [
          agent('writer', 'file'),
          agent('router', 'code'),
          agent('switcher', 'file'),
          agent('other', 'file'),
          agent('scripted', 'code'),
          agent('broken', 'file'),
        ],
      }),
      'bureau.agents.definitions.get': (params) => {
        const id = String(params['id']);
        if (id === 'writer') return fileDetail(id, 'anthropic/sonnet');
        if (id === 'router') return codeDetail(id, null, ['openai/gpt-4.1', 'anthropic/haiku']);
        if (id === 'switcher') return fileDetail(id, 'openai/gpt-4.1', ['anthropic/sonnet']);
        if (id === 'scripted') return codeDetail(id, null, []);
        if (id === 'broken') return { ...fileDetail(id, 'x'), state: 'invalid', definition: null };
        return fileDetail(id, 'openai/gpt-4.1');
      },
    });

    const users = await listProviderAgents('anthropic');

    expect(users).toEqual([
      { id: 'writer', displayName: 'The writer' },
      { id: 'router', displayName: 'The router' },
      { id: 'switcher', displayName: 'The switcher' },
    ]);
  });

  test('does not take a provider whose name only starts the same for the provider', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: [agent('writer', 'file')] }),
      'bureau.agents.definitions.get': (params) =>
        fileDetail(String(params['id']), 'anthropic-proxy/sonnet'),
    });

    expect(await listProviderAgents('anthropic')).toEqual([]);
  });

  test('rejects when an agent cannot be read, so the list is never claimed to be empty', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: [agent('writer', 'file')] }),
      'bureau.agents.definitions.get': () => {
        throw new Error('The Bureau did not answer.');
      },
    });

    const failure = await listProviderAgents('anthropic').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
  });
});
