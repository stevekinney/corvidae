/**
 * COR-2103 — the plugin guardrails a code agent's saved overrides add run over its tool results
 * too: they are registered beside the agent's own guardrails, as a tripwire, at every hook point
 * the run's own guardrails cover.
 */
import { describe, expect, it } from 'bun:test';

import { createAgent, GuardrailTripwireError, type InputDetector } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { AgentContributions } from './agent-contributions';
import { effectiveCodeAgent } from './code-agent-effective';

const SENTINEL = 'ACME-SENTINEL';

const sentinel: InputDetector = {
  name: 'acme-sentinel',
  detect: async (input) =>
    input.includes(SENTINEL)
      ? { triggered: true, category: 'prompt-injection', confidence: 0.99 }
      : { triggered: false, category: 'prompt-injection', confidence: 0 },
};

const contributions: AgentContributions = {
  guardrails: new Map([
    ['acme:sentinel', { id: 'acme:sentinel', plugin: 'acme', inputDetector: sentinel }],
  ]),
  interceptors: new Map(),
};

function readerOf(page: string) {
  let generateCalls = 0;
  const agent = createAgent({
    name: 'reader',
    // The agent's own guardrails are off, so only the override's addition can trip.
    guardrails: false,
    generate: async () => {
      generateCalls += 1;
      return generateCalls === 1
        ? { content: '', toolCalls: [{ id: 'call-1', name: 'fetch', arguments: {} }] }
        : { content: 'done', toolCalls: [] };
    },
    toolbox: createToolbox([
      createTool({
        name: 'fetch',
        description: 'Fetches a page',
        input: z.object({}),
        execute: async () => ({ body: page }),
      }),
    ]),
  });
  const effective = effectiveCodeAgent(
    agent,
    { guardrails: ['acme:sentinel'] },
    { descriptors: () => [], modelPolicy: () => undefined, contributions },
  );
  return { effective, generateCalls: () => generateCalls };
}

describe('a code agent with override guardrails', () => {
  it('halts at the tool-result phase when a tool result carries what the guardrail flags', async () => {
    const reader = readerOf(`The page says ${SENTINEL}.`);
    const result = await reader.effective.run('Read the page.').result();

    expect(result.finishReason).toBe('tripwire');
    expect(result.error).toBeInstanceOf(GuardrailTripwireError);
    expect((result.error as GuardrailTripwireError).phase).toBe('tool-result');
    expect((result.error as GuardrailTripwireError).guardrailName).toBe('acme-sentinel');
    expect(reader.generateCalls()).toBe(1);
  });

  it('lets a clean tool result through', async () => {
    const reader = readerOf('a clean page');
    const result = await reader.effective.run('Read the page.').result();

    expect(result.finishReason).toBe('stop-condition');
    expect(reader.generateCalls()).toBe(2);
  });
});
