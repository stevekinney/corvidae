/**
 * COR-2104 — the outcome matrix for tool-call validators and per-guardrail actions, run end to end
 * through a `createAgent` agent: which calls execute, what the model is shown next, what the
 * conversation keeps, and which events fire.
 */
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { type Conversation, type Message } from 'conversationalist';
import { z } from 'zod';

import type { GuardrailAdditions } from '../src/agent-policy';
import type { RunEvent } from '../src/agent-run';
import { noToolCalls } from '../src/conditions/predicates';
import { createAgent } from '../src/create-agent';
import type {
  GuardrailsOptions,
  InputDetector,
  OutputValidator,
  ToolCallValidator,
} from '../src/guardrails';
import { GUARDRAIL_BLOCKED_CODE } from '../src/guardrails/tool-result-guardrail';
import type { GenerateFunction, GenerateResponse } from '../src/types';

/** Refuses a `refund` whose amount is over 100. */
function refundCap(action?: ToolCallValidator['action']): ToolCallValidator {
  return {
    name: 'refund-cap',
    description: 'Blocks refunds over $100',
    ...(action === undefined ? {} : { action }),
    validate: async (call) => {
      const amount = (call.arguments as { amount?: number }).amount ?? 0;
      return call.name === 'refund' && amount > 100
        ? { valid: false, category: 'refund-limit', confidence: 1, detail: `amount ${amount}` }
        : { valid: true, category: 'refund-limit', confidence: 0 };
    },
  };
}

const throwingValidator: ToolCallValidator = {
  name: 'broken',
  validate: async () => {
    throw new Error('validator failed');
  },
};

interface Outcome {
  readonly finishReason: string;
  readonly events: readonly RunEvent[];
  /** The tools that executed, by name, in order. */
  readonly executed: readonly string[];
  /** The tool results the model was shown at its second generate, by call id. */
  readonly shownToModel: ReadonlyMap<string, NonNullable<Message['toolResult']>>;
  readonly generateCalls: number;
  readonly conversation: Conversation;
  readonly content: string;
}

interface Setup {
  readonly guardrails?: GuardrailsOptions | false;
  readonly additionalGuardrails?: GuardrailAdditions;
  readonly amount?: number;
  readonly prompt?: string;
  readonly reply?: string;
}

async function runAgent(setup: Setup): Promise<Outcome> {
  const executed: string[] = [];
  const shownToModel = new Map<string, NonNullable<Message['toolResult']>>();
  let generateCalls = 0;
  const generate: GenerateFunction = async ({ conversation }): Promise<GenerateResponse> => {
    generateCalls += 1;
    if (generateCalls === 1) {
      return {
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'refund', arguments: { amount: setup.amount ?? 150 } },
          { id: 'call-2', name: 'lookup', arguments: { order: 'A-1' } },
        ],
      };
    }
    for (const message of conversation.getMessages()) {
      if (message.toolResult !== undefined) {
        shownToModel.set(message.toolResult.callId, message.toolResult);
      }
    }
    return { content: setup.reply ?? 'done', toolCalls: [] };
  };
  const agent = createAgent({
    name: 'refunds',
    generate,
    toolbox: createTestToolbox([
      createTool({
        name: 'refund',
        description: 'Refunds an order',
        input: z.object({ amount: z.number() }),
        async execute({ amount }) {
          executed.push('refund');
          return { refunded: amount };
        },
      }),
      createTool({
        name: 'lookup',
        description: 'Looks up an order',
        input: z.object({ order: z.string() }),
        async execute({ order }) {
          executed.push('lookup');
          return { order, status: 'paid' };
        },
      }),
    ]),
    stopWhen: noToolCalls(),
    ...(setup.guardrails === undefined ? {} : { guardrails: setup.guardrails }),
    ...(setup.additionalGuardrails === undefined
      ? {}
      : { additionalGuardrails: setup.additionalGuardrails }),
  });
  const run = agent.run(setup.prompt ?? 'Refund order A-1.');
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  const result = await run.result();
  return {
    finishReason: result.finishReason,
    events,
    executed,
    shownToModel,
    generateCalls,
    conversation: result.conversation,
    content: result.content,
  };
}

function ofType(events: readonly RunEvent[], type: string): RunEvent[] {
  return events.filter((event) => event.type === type);
}

function toolResultRows(conversation: Conversation): Array<NonNullable<Message['toolResult']>> {
  return conversation
    .getMessages()
    .flatMap((message) => (message.toolResult === undefined ? [] : [message.toolResult]));
}

const validateMode = (validator: ToolCallValidator): Setup => ({
  guardrails: { mode: 'validate', tools: { validators: [validator] } },
});

/** The validator added to the AB-40 preset, as an agent file's selection adds it. */
const defaultPreset = (validator: ToolCallValidator): Setup => ({
  additionalGuardrails: { toolValidators: [validator] },
});

describe('tool-call validators', () => {
  it.each([
    ['validate mode, no action of its own', validateMode(refundCap())],
    ['validate mode, action block', validateMode(refundCap('block'))],
    ['default preset, action block', defaultPreset(refundCap('block'))],
  ] as const)(
    'refuses the call (%s): the model gets GUARDRAIL_BLOCKED, the other call runs, both stay paired',
    async (_, setup) => {
      const outcome = await runAgent(setup);

      expect(outcome.finishReason).toBe('stop-condition');
      expect(outcome.executed).toEqual(['lookup']);
      expect(outcome.generateCalls).toBe(2);
      expect(outcome.shownToModel.get('call-1')).toMatchObject({
        callId: 'call-1',
        outcome: 'error',
        error: { category: 'permission', code: GUARDRAIL_BLOCKED_CODE },
      });
      expect(JSON.stringify(outcome.shownToModel.get('call-1'))).toContain('refund-cap');
      expect(outcome.shownToModel.get('call-2')).toMatchObject({ outcome: 'success' });
      expect(toolResultRows(outcome.conversation).map((row) => row.callId)).toEqual([
        'call-1',
        'call-2',
      ]);
      const fired = ofType(outcome.events, 'run.guardrail');
      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({
        guardrailName: 'refund-cap',
        category: 'refund-limit',
        phase: 'tool-call',
        action: 'block',
      });
      expect(ofType(outcome.events, 'run.tripwire')).toEqual([]);
    },
  );

  it('default preset, no action of its own: halts with one tool-call tripwire and runs no call', async () => {
    const outcome = await runAgent(defaultPreset(refundCap()));

    expect(outcome.finishReason).toBe('tripwire');
    expect(outcome.executed).toEqual([]);
    expect(outcome.generateCalls).toBe(1);
    const tripwires = ofType(outcome.events, 'run.tripwire');
    expect(tripwires).toHaveLength(1);
    expect(tripwires[0]).toMatchObject({ guardrailName: 'refund-cap', phase: 'tool-call' });
    expect(ofType(outcome.events, 'run.guardrail')).toEqual([]);
    // Every call of the step is still paired, with a refusal naming the guardrail.
    const rows = toolResultRows(outcome.conversation);
    expect(rows.map((row) => row.callId)).toEqual(['call-1', 'call-2']);
    for (const row of rows) {
      expect(row).toMatchObject({ outcome: 'error', error: { code: GUARDRAIL_BLOCKED_CODE } });
      expect(JSON.stringify(row)).toContain('refund-cap');
    }
  });

  it.each([
    ['validate mode', validateMode(refundCap('warn'))],
    ['default preset', defaultPreset(refundCap('warn'))],
  ] as const)('action warn (%s): the call runs and the warning is reported', async (_, setup) => {
    const outcome = await runAgent(setup);

    expect(outcome.finishReason).toBe('stop-condition');
    expect(outcome.executed).toEqual(['refund', 'lookup']);
    expect(outcome.shownToModel.get('call-1')).toMatchObject({
      outcome: 'success',
      content: { refunded: 150 },
    });
    const fired = ofType(outcome.events, 'run.guardrail');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      guardrailName: 'refund-cap',
      phase: 'tool-call',
      action: 'warn',
    });
    expect(ofType(outcome.events, 'run.tripwire')).toEqual([]);
  });

  it.each([
    ['validate mode', validateMode(refundCap())],
    ['default preset', defaultPreset(refundCap())],
  ] as const)('a valid call (%s) runs unchanged, with no event', async (_, setup) => {
    const outcome = await runAgent({ ...setup, amount: 50 });

    expect(outcome.finishReason).toBe('stop-condition');
    expect(outcome.executed).toEqual(['refund', 'lookup']);
    expect(outcome.shownToModel.get('call-1')).toMatchObject({
      outcome: 'success',
      content: { refunded: 50 },
    });
    expect(ofType(outcome.events, 'run.guardrail')).toEqual([]);
    expect(ofType(outcome.events, 'run.tripwire')).toEqual([]);
  });

  it.each([
    ['validate mode', validateMode(throwingValidator)],
    ['default preset', defaultPreset(throwingValidator)],
  ] as const)(
    'a validator that throws (%s) is contained, as a detector is: it finds nothing',
    async (_, setup) => {
      const outcome = await runAgent(setup);

      expect(outcome.finishReason).toBe('stop-condition');
      expect(outcome.executed).toEqual(['refund', 'lookup']);
      expect(ofType(outcome.events, 'run.guardrail')).toEqual([]);
      expect(ofType(outcome.events, 'run.tripwire')).toEqual([]);
    },
  );
});

/** Trips on the word "forbidden" with full confidence. */
const forbiddenDetector: InputDetector = {
  name: 'forbidden-input',
  detect: async (input) =>
    input.includes('forbidden')
      ? { triggered: true, category: 'policy', confidence: 1 }
      : { triggered: false, category: 'policy', confidence: 0 },
};

const forbiddenValidator: OutputValidator = {
  name: 'forbidden-output',
  validate: async (output) =>
    output.includes('forbidden')
      ? { valid: false, category: 'policy', confidence: 1 }
      : { valid: true, category: 'policy', confidence: 0 },
};

describe('an action per guardrail', () => {
  it('an input entry with action warn warns, in a group whose action is block', async () => {
    const outcome = await runAgent({
      guardrails: {
        mode: 'validate',
        input: { action: 'block', detectors: [{ guardrail: forbiddenDetector, action: 'warn' }] },
      },
      prompt: 'Refund the forbidden order.',
      amount: 50,
    });

    expect(outcome.finishReason).toBe('stop-condition');
    expect(outcome.generateCalls).toBe(2);
    expect(outcome.executed).toEqual(['refund', 'lookup']);
    // Each step re-reads the request until a reply answers it, and warns each time.
    const fired = ofType(outcome.events, 'run.guardrail');
    expect(fired.length).toBeGreaterThan(0);
    for (const event of fired) {
      expect(event).toMatchObject({
        guardrailName: 'forbidden-input',
        phase: 'input',
        action: 'warn',
      });
    }
  });

  it('a bare input entry in the same group still blocks', async () => {
    const outcome = await runAgent({
      guardrails: { mode: 'validate', input: { action: 'block', detectors: [forbiddenDetector] } },
      prompt: 'Refund the forbidden order.',
    });

    expect(outcome.generateCalls).toBe(0);
    expect(outcome.content).toContain('blocked by input guardrail');
  });

  it('an output entry with action warn warns, in a group whose action is block', async () => {
    const outcome = await runAgent({
      guardrails: {
        mode: 'validate',
        output: {
          action: 'block',
          validators: [{ guardrail: forbiddenValidator, action: 'warn' }],
        },
      },
      reply: 'The forbidden refund is done.',
      amount: 50,
    });

    expect(outcome.finishReason).toBe('stop-condition');
    expect(outcome.content).toBe('The forbidden refund is done.');
    const fired = ofType(outcome.events, 'run.guardrail');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      guardrailName: 'forbidden-output',
      phase: 'output',
      action: 'warn',
    });
  });

  it('an added input entry with action warn warns under the default preset', async () => {
    const outcome = await runAgent({
      additionalGuardrails: { inputDetectors: [{ guardrail: forbiddenDetector, action: 'warn' }] },
      prompt: 'Refund the forbidden order.',
      amount: 50,
    });

    expect(outcome.finishReason).toBe('stop-condition');
    expect(ofType(outcome.events, 'run.tripwire')).toEqual([]);
    expect(ofType(outcome.events, 'run.guardrail')[0]).toMatchObject({
      guardrailName: 'forbidden-input',
      action: 'warn',
    });
  });

  it('an added bare input entry trips under the default preset', async () => {
    const outcome = await runAgent({
      additionalGuardrails: { inputDetectors: [forbiddenDetector] },
      prompt: 'Refund the forbidden order.',
    });

    expect(outcome.finishReason).toBe('tripwire');
    expect(ofType(outcome.events, 'run.tripwire')[0]).toMatchObject({
      guardrailName: 'forbidden-input',
      phase: 'input',
    });
  });
});
