/**
 * COR-1577 — which of a catalog agent's resolved options a session run takes from the agent.
 * Every key `RunOptions` can carry is classified once, in `session-agent-options.ts`, and the
 * fresh start, the recovery and the reattach all copy through the same function. A key the
 * classification does not name is a type error; these tests fail when the resolver returns a key
 * it does not know about, and when a classified key is not carried.
 */
import {
  createAgent,
  type RunOptions,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  AGENT_OWNED_RUN_OPTION_KEYS,
  copyAgentOwnedRunOptions,
  scheduledAgentRunOptions,
  SESSION_AGENT_OPTION_DISPOSITIONS,
} from './session-agent-options';

describe('session agent options', () => {
  it('classifies every key a fully configured agent’s resolver returns', async () => {
    const agent = createAgent({
      generate: async () => ({ content: '', toolCalls: [] }),
      toolbox: createToolbox([]),
      instructions: 'be brief',
      output: z.object({ answer: z.string() }),
      stopWhen: stopWhen.noToolCalls(),
      maximumSteps: 3,
    });
    if (!hasDefinitionResolver(agent)) throw new Error('Expected a definition resolver.');

    const resolved = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('hello', {
      agentName: 'a',
      runId: 'r',
      principal: 'p',
    });

    const unclassified = Object.keys(resolved).filter(
      (key) => !(key in SESSION_AGENT_OPTION_DISPOSITIONS),
    );
    expect(unclassified).toEqual([]);
  });

  it('carries the structured-output contract, and every other agent-owned option', () => {
    const marker = (name: string) => ({ marker: name });
    const source: Record<string, unknown> = {};
    for (const key of AGENT_OWNED_RUN_OPTION_KEYS) source[key] = marker(key);

    const copied = copyAgentOwnedRunOptions(source as never) as Record<string, unknown>;

    expect(Object.keys(copied).toSorted()).toEqual([...AGENT_OWNED_RUN_OPTION_KEYS].toSorted());
    const owned: readonly string[] = AGENT_OWNED_RUN_OPTION_KEYS;
    for (const key of ['output', 'schemaRetries', 'schemaRetryMessage']) {
      expect(owned).toContain(key);
    }
  });

  it('never carries what belongs to the run or to the Bureau', () => {
    const source: Record<string, unknown> = {};
    for (const [key, disposition] of Object.entries(SESSION_AGENT_OPTION_DISPOSITIONS)) {
      if (disposition !== 'agent') source[key] = { owner: disposition };
    }

    const copied = copyAgentOwnedRunOptions(source as never);

    expect(copied).toEqual({});
  });

  it('leaves out an option the agent left unset', () => {
    expect(copyAgentOwnedRunOptions({ schemaRetries: undefined } as never)).toEqual({});
  });
});

describe('scheduledAgentRunOptions', () => {
  it('carries every agent-owned option, the token cap, and the execute options under the scheduler context', () => {
    const agentOptions = {
      maximumTokens: 5,
      executeOptions: { concurrency: 2, requestContext: { principal: 'agent' } },
    } as never as RunOptions;
    for (const key of AGENT_OWNED_RUN_OPTION_KEYS) Object.assign(agentOptions, { [key]: key });

    const projected = scheduledAgentRunOptions(agentOptions, { principal: 'scheduler' } as never);

    for (const key of AGENT_OWNED_RUN_OPTION_KEYS) expect(projected[key]).toBe(key as never);
    expect(projected.maximumTokens).toBe(5);
    expect(projected.executeOptions).toEqual({
      concurrency: 2,
      requestContext: { principal: 'scheduler' },
    });
  });
});
