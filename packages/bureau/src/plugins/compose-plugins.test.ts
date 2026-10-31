/**
 * COR-1879 — what a running plugin contributes reaches the option it belongs to.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { type ComposableOptions, composePlugins } from './compose-plugins';

describe('composePlugins', () => {
  it('folds every contribution kind into its Bureau option, under plugin:name', async () => {
    const everything = definePlugin({
      name: 'kit',
      version: '1.2.0',
      description: 'Contributes one of each.',
      setup: () => ({
        activities: [{ name: 'fetch', execute: async () => 'fetched' }],
        triggerKinds: [
          {
            name: 'inbox',
            version: '0.1.0',
            description: 'Mail arrives.',
            configuration: z.object({}),
            start: async () => () => undefined,
          },
        ],
        validators: [
          {
            identity: { name: 'tidy', version: '1' },
            validate: () => ({ status: 'met' }) as never,
          },
        ],
        guardrails: { inputDetectors: [{ name: 'scan', detect: async () => ({}) as never }] },
        runHooks: [{ name: 'audit' }],
        decisionRouters: [{ name: 'router', kinds: new Set(), decide: async () => ({}) as never }],
        hookActionKinds: [
          {
            name: 'page',
            description: 'Pages someone.',
            configuration: z.object({}),
            run: async () => undefined,
          },
        ],
        evalJudges: [
          { name: 'judge', version: '1', evaluate: () => ({ pass: true, score: 1, message: '' }) },
        ],
        codeAgents: [
          {
            name: 'writer',
            agent: createAgent({ generate: async () => ({ content: '', toolCalls: [] }) }),
          },
        ],
      }),
    });
    const given: ComposableOptions = {
      plugins: [{ descriptor: everything, source: 'package', location: '@example/kit' }],
      hooks: {},
      onlineEvals: { judges: [], sampleRate: 1 },
    };
    const { options, records } = await composePlugins(given);

    expect(records[0]?.status).toBe('running');
    expect(options.contributionCatalog?.resolve('activity', 'kit:fetch@1.2.0').ok).toBe(true);
    expect(options.contributionCatalog?.resolve('trigger-kind', 'kit:inbox@0.1.0').ok).toBe(true);
    expect(options.validators?.map(({ identity }) => identity)).toEqual([
      { name: 'kit:tidy', version: '1' },
    ]);
    expect([...(options.agentContributions?.guardrails.keys() ?? [])]).toEqual(['kit:scan']);
    expect([...(options.agentContributions?.runHooks.keys() ?? [])]).toEqual(['kit:audit']);
    expect(Object.keys(options.decisions?.models ?? {})).toEqual(['kit:router']);
    expect(options.hooks?.actionKinds?.map(({ plugin, kind }) => `${plugin}/${kind.name}`)).toEqual(
      ['kit/page'],
    );
    expect(options.onlineEvals?.judges.map(({ name }) => name)).toEqual(['kit:judge']);
    expect(Object.keys(options.agents ?? {})).toEqual(['kit:writer']);
  });
});
