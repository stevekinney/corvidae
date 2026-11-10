/**
 * COR-2103 — the plugin guardrails a code agent's saved overrides add run over its tool results
 * too: they are registered beside the agent's own guardrails, as a tripwire, at every hook point
 * the run's own guardrails cover.
 */
import { describe, expect, it } from 'bun:test';

import type { PluginInputGuardrail, PluginToolGuardrail } from '@lostgradient/interborough-plugin';
import {
  createAgent,
  GuardrailTripwireError,
  type ToolCallValidator,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { AgentContributions } from './agent-contributions';
import { effectiveCodeAgent } from './code-agent-effective';

const SENTINEL = 'ACME-SENTINEL';

const sentinel: PluginInputGuardrail = {
  name: 'acme-sentinel',
  description: 'Flags the sentinel.',
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

/**
 * COR-2104 — a tool-call validator an override names judges the code agent's calls before they
 * run: bare, it halts the run at the tool-call phase (the override's additions run as a tripwire);
 * with `action: 'block'` it refuses the call and the run goes on.
 */
describe('a code agent with an override tool-call validator', () => {
  function refunderWith(action: ToolCallValidator['action']) {
    const ran: string[] = [];
    const refundCap: PluginToolGuardrail = {
      name: 'refund-cap',
      description: 'Caps refunds at $100.',
      ...(action === undefined ? {} : { action }),
      validate: async (call) =>
        ((call.arguments as { amount?: number }).amount ?? 0) > 100
          ? { valid: false, category: 'refund-limit', confidence: 1 }
          : { valid: true, category: 'refund-limit', confidence: 0 },
    };
    let generateCalls = 0;
    const agent = createAgent({
      name: 'refunder',
      guardrails: false,
      generate: async () => {
        generateCalls += 1;
        return generateCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'call-1', name: 'refund', arguments: { amount: 150 } }],
            }
          : { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([
        createTool({
          name: 'refund',
          description: 'Refunds an order',
          input: z.object({ amount: z.number() }),
          execute: async () => {
            ran.push('refund');
            return 'refunded';
          },
        }),
      ]),
    });
    const effective = effectiveCodeAgent(
      agent,
      { guardrails: ['acme:refund-cap'] },
      {
        descriptors: () => [],
        modelPolicy: () => undefined,
        contributions: {
          guardrails: new Map([
            [
              'acme:refund-cap',
              { id: 'acme:refund-cap', plugin: 'acme', toolValidator: refundCap },
            ],
          ]),
          interceptors: new Map(),
        },
      },
    );
    return { effective, ran };
  }

  it('halts at the tool-call phase, running no call, when the validator has no action of its own', async () => {
    const { effective, ran } = refunderWith(undefined);
    const result = await effective.run('Refund it.').result();

    expect(result.finishReason).toBe('tripwire');
    expect((result.error as GuardrailTripwireError).phase).toBe('tool-call');
    expect((result.error as GuardrailTripwireError).guardrailName).toBe('refund-cap');
    expect(ran).toEqual([]);
  });

  it('refuses the call and goes on when the validator blocks', async () => {
    const { effective, ran } = refunderWith('block');
    const result = await effective.run('Refund it.').result();

    expect(result.finishReason).toBe('stop-condition');
    expect(ran).toEqual([]);
    expect(result.steps[0]?.results[0]).toMatchObject({
      outcome: 'error',
      error: { code: 'GUARDRAIL_BLOCKED' },
    });
  });
});
