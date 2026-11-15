/**
 * COR-1709 — `createDecisionRouting`: a supervisor asks a `choice` over the catalog's agents.
 */
import { createAgent, createMockGenerate, DecisionSchemaError } from '@lostgradient/operative';
import type { DecisionRequest } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createAgentCatalog } from '../agent-catalog.ts';
import { BureauError } from '../bureau-errors.ts';
import { createSupervisor } from '../create-supervisor.ts';
import { createDecisionRouting } from './decision-routing.ts';
import type { DecisionSource } from './types.ts';

function agent(name: string, description?: string) {
  return createAgent({
    name,
    ...(description === undefined ? {} : { description }),
    generate: createMockGenerate([{ content: `${name} answered`, toolCalls: [] }]),
  });
}

/** A decision source that answers with `key` and records the requests it was asked. */
function scripted(answer: string | Error) {
  const asked: DecisionRequest[] = [];
  const source: DecisionSource = {
    decide: async (request) => {
      asked.push(request);
      if (answer instanceof Error) throw answer;
      return { value: answer, provider: 'scripted', model: 'model' };
    },
  };
  return { source, asked };
}

describe('createDecisionRouting', () => {
  it('delegates to the agent the scripted model names, offering every agent', async () => {
    const catalog = createAgentCatalog({
      writer: agent('writer', 'Writes poems'),
      reviewer: agent('reviewer'),
    });
    const { source, asked } = scripted('reviewer');
    const supervisor = createSupervisor({
      agents: catalog,
      routing: createDecisionRouting(source),
    });

    const result = await supervisor.delegate('Check this draft');

    expect(result.agentResults.map((entry) => entry.agentName)).toEqual(['reviewer']);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: 'choice',
      options: [
        { key: 'writer', label: 'Writes poems' },
        { key: 'reviewer', label: 'reviewer' },
      ],
    });
    expect(asked[0]?.question).toContain('Check this draft');
  });

  it('asks as its principal (COR-2155)', async () => {
    const catalog = createAgentCatalog({ writer: agent('writer'), reviewer: agent('reviewer') });
    const optionsSeen: unknown[] = [];
    const source: DecisionSource = {
      decide: async (_request, options) => {
        optionsSeen.push(options);
        return { value: 'writer', provider: 'scripted', model: 'model' };
      },
    };
    const supervisor = createSupervisor({
      agents: catalog,
      routing: createDecisionRouting(source, { principal: 'api-key:alice' }),
    });

    await supervisor.delegate('Write it');

    // No run exists while routing: the supervisor routes first and starts the runs after, so the
    // record is filed under the routing step's id instead of a task (COR-2420).
    expect(optionsSeen).toEqual([
      { principal: 'api-key:alice', routingId: expect.stringMatching(/^routing-/) },
    ]);
  });

  it('asks without a routing id when the strategy is called without a context', async () => {
    const optionsSeen: unknown[] = [];
    const source: DecisionSource = {
      decide: async (_request, options) => {
        optionsSeen.push(options);
        return { value: 'one', provider: 'scripted', model: 'model' };
      },
    };
    const routing = createDecisionRouting<{ one: never; two: never }>(source);

    await routing('Anything', [{ name: 'one' }, { name: 'two' }]);

    expect(optionsSeen).toEqual([{}]);
  });

  it('returns the only agent without asking anything', async () => {
    const catalog = createAgentCatalog({ solo: agent('solo') });
    const { source, asked } = scripted('unused');
    const supervisor = createSupervisor({
      agents: catalog,
      routing: createDecisionRouting(source),
    });

    const result = await supervisor.delegate('Anything');

    expect(result.agentResults.map((entry) => entry.agentName)).toEqual(['solo']);
    expect(asked).toEqual([]);
  });

  it('throws NOT_FOUND for an empty catalog', async () => {
    const { source, asked } = scripted('unused');
    const routing = createDecisionRouting(source);

    const error = await Promise.resolve(routing('Anything', [])).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');
    expect(asked).toEqual([]);
  });

  it('lets a decision that cannot be made reach the supervisor as its error', async () => {
    const catalog = createAgentCatalog({ one: agent('one'), two: agent('two') });
    for (const failure of [
      new BureauError('nothing configured', 'NOT_CONFIGURED', 'generate'),
      new DecisionSchemaError({ attempts: 2, usage: undefined, validation: 'bad' }),
    ]) {
      const supervisor = createSupervisor({
        agents: catalog,
        routing: createDecisionRouting(scripted(failure).source),
      });

      const error = await supervisor.delegate('Anything').then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBe(failure);
    }
  });
});
