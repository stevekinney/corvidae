/**
 * COR-1487 — an author configures a JSON Schema per signal on `requestHumanInput`; the model never
 * supplies one. The schema is checked when the tool is created and travels on the pending wait,
 * the park event, and the tool result the checkpoint persists.
 */
import { CompletableEventTarget } from '@lostgradient/lifecycle';
import type { WorkflowLogRecord } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  createRequestHumanInputTool,
  type RequestHumanInputContext,
  type RequestHumanInputOutcome,
  type RequestHumanInputResult,
} from './create-request-human-input-tool';
import {
  createHumanWaitMarkerSink,
  HUMAN_WAIT_PARKED_LOG_MARKER,
} from './durable/human-wait-park-marker';
import type { CombinedOperativeEventMap } from './events';
import { HumanWaitParkedEvent } from './events';
import {
  HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES,
  HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH,
  type HumanInputSchema,
  HumanInputSchemaError,
} from './human-input-schema';
import { humanWaitParks, parkedHumanWait } from './human-wait-parks';

const formSchema: HumanInputSchema = {
  type: 'object',
  properties: { environment: { type: 'string', enum: ['staging', 'production'] } },
  required: ['environment'],
};

function makeContext(): RequestHumanInputContext {
  return { pendingHumanWait: undefined, pendingWakeup: undefined, runId: 'run-1', durable: true };
}

function parked(outcome: RequestHumanInputOutcome): RequestHumanInputResult {
  if (!outcome.parked) throw new Error('expected the request to park');
  return outcome;
}

/** A schema nested to exactly `levels` levels, the schema object itself being level 1. */
function nestedTo(levels: number): HumanInputSchema {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = levels - 1; level >= 1; level -= 1) schema = { next: schema };
  return schema;
}

describe('createRequestHumanInputTool inputSchemas', () => {
  it('records the configured schema on the pending wait, the park event, and the result', () => {
    const context = makeContext();
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const events: HumanWaitParkedEvent[] = [];
    emitter.addEventListener(HumanWaitParkedEvent.type, (event) => events.push(event));
    const tool = createRequestHumanInputTool({
      context,
      emitter,
      inputSchemas: { deploy: formSchema },
    });

    const result = parked(tool.execute({ signalName: 'deploy', prompt: 'Where to?' }));

    expect(context.pendingHumanWait?.inputSchema).toEqual(formSchema);
    expect(events[0]?.inputSchema).toEqual(formSchema);
    expect(result.inputSchema).toEqual(formSchema);
  });

  it('leaves a signal without a configured schema exactly as it was', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context, inputSchemas: { deploy: formSchema } });

    const result = parked(tool.execute({ signalName: 'other', prompt: 'Sure?' }));

    expect(context.pendingHumanWait).toEqual({ signalName: 'other', prompt: 'Sure?' });
    expect('inputSchema' in context.pendingHumanWait!).toBe(false);
    expect('inputSchema' in result).toBe(false);
  });

  it.each([[null], [true], [undefined], [['a']]])(
    'refuses a schema whose toJSON() returns %p',
    (returned) => {
      const schema = { toJSON: () => returned } as unknown as HumanInputSchema;
      expect(() =>
        createRequestHumanInputTool({ context: makeContext(), inputSchemas: { deploy: schema } }),
      ).toThrow(/must serialize as a JSON object/);
    },
  );

  it('behaves as before for a tool created without inputSchemas', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    const result = parked(tool.execute({ signalName: 'deploy' }));

    expect(context.pendingHumanWait).toEqual({ signalName: 'deploy' });
    expect(Object.keys(result).toSorted()).toEqual(['message', 'parked', 'signalName']);
  });

  it('does not look a signal name up through the prototype', () => {
    for (const signalName of ['constructor', '__proto__', 'toString']) {
      const context = makeContext();
      const tool = createRequestHumanInputTool({ context, inputSchemas: { deploy: formSchema } });

      parked(tool.execute({ signalName }));

      expect(context.pendingHumanWait).toEqual({ signalName });
    }
  });

  it('keeps the model-facing input to the signal name and the prompt', () => {
    const tool = createRequestHumanInputTool({
      context: makeContext(),
      inputSchemas: { deploy: formSchema },
    });

    expect(Object.keys(tool.input.shape).toSorted()).toEqual(['prompt', 'signalName']);
    const parsed = tool.input.parse({
      signalName: 'deploy',
      inputSchema: { type: 'string' },
    });
    expect('inputSchema' in parsed).toBe(false);
  });

  it('keeps its own copy of a schema, so changing the original later changes nothing', () => {
    const original = structuredClone(formSchema) as { properties: Record<string, unknown> };
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context, inputSchemas: { deploy: original } });

    original.properties['injected'] = { type: 'string' };
    parked(tool.execute({ signalName: 'deploy' }));

    expect(context.pendingHumanWait?.inputSchema).toEqual(formSchema);
  });

  it('rejects a schema that is not valid JSON Schema 2020-12', () => {
    expect(() =>
      createRequestHumanInputTool({
        context: makeContext(),
        inputSchemas: { deploy: { type: 'not-a-type' } },
      }),
    ).toThrow(HumanInputSchemaError);
    expect(() =>
      createRequestHumanInputTool({
        context: makeContext(),
        inputSchemas: { deploy: { $ref: '#/$defs/missing' } },
      }),
    ).toThrow(HumanInputSchemaError);
  });

  it('rejects a schema that is not an object', () => {
    expect(() =>
      createRequestHumanInputTool({
        context: makeContext(),
        inputSchemas: { deploy: [] as unknown as HumanInputSchema },
      }),
    ).toThrow(HumanInputSchemaError);
  });

  it('rejects a schema above 32 KiB serialized, and accepts one at the limit', () => {
    const overhead = JSON.stringify({ description: '' }).length;
    const atLimit = { description: 'x'.repeat(HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES - overhead) };
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).byteLength).toBe(
      HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES,
    );
    expect(() =>
      createRequestHumanInputTool({ context: makeContext(), inputSchemas: { deploy: atLimit } }),
    ).not.toThrow();

    const over = { description: 'x'.repeat(HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES - overhead + 1) };
    expect(() =>
      createRequestHumanInputTool({ context: makeContext(), inputSchemas: { deploy: over } }),
    ).toThrow(/32768 bytes/);
  });

  it('measures the size in bytes, not characters', () => {
    const wide = { description: '€'.repeat(HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES / 3) };
    expect(() =>
      createRequestHumanInputTool({ context: makeContext(), inputSchemas: { deploy: wide } }),
    ).toThrow(HumanInputSchemaError);
  });

  it('rejects a schema nested above 8 levels, and accepts one at the limit', () => {
    expect(() =>
      createRequestHumanInputTool({
        context: makeContext(),
        inputSchemas: { deploy: nestedTo(HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH) },
      }),
    ).not.toThrow();
    expect(() =>
      createRequestHumanInputTool({
        context: makeContext(),
        inputSchemas: { deploy: nestedTo(HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH + 1) },
      }),
    ).toThrow(/8 levels/);
  });

  it('rejects the constructs a submission check refuses: pattern, $id, and a nested $id', () => {
    for (const schema of [
      { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } },
      { type: 'object', patternProperties: { '^a': { type: 'string' } } },
      { $id: 'https://example.com/x', type: 'object' },
      { type: 'object', properties: { a: { $id: 'https://example.com/a', type: 'string' } } },
    ]) {
      expect(() =>
        createRequestHumanInputTool({ context: makeContext(), inputSchemas: { deploy: schema } }),
      ).toThrow(HumanInputSchemaError);
    }
  });

  it('names the signal whose schema was rejected', () => {
    try {
      createRequestHumanInputTool({
        context: makeContext(),
        inputSchemas: { deploy: formSchema, broken: { type: 'bogus' } },
      });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(HumanInputSchemaError);
      expect((error as HumanInputSchemaError).signalName).toBe('broken');
    }
  });
});

describe('a human-wait schema in the checkpoint', () => {
  it('reads back from the persisted step result of the tool call', () => {
    const tool = createRequestHumanInputTool({
      context: makeContext(),
      inputSchemas: { deploy: formSchema },
    });
    const result = tool.execute({ signalName: 'deploy', prompt: 'Where to?' });
    // A checkpoint is JSON: what a restarted process reads is the round trip.
    const restored = JSON.parse(JSON.stringify([{ toolName: 'requestHumanInput', result }])) as [
      { toolName: string; result: unknown },
    ];

    expect(parkedHumanWait(restored[0])).toEqual({
      signalName: 'deploy',
      prompt: 'Where to?',
      inputSchema: formSchema,
    });
    expect(humanWaitParks(restored)).toEqual([
      { signalName: 'deploy', prompt: 'Where to?', inputSchema: formSchema },
    ]);
  });

  it('reads back as no schema from a step result written before schemas existed', () => {
    const park = parkedHumanWait({
      toolName: 'requestHumanInput',
      result: { parked: true, signalName: 'deploy', message: 'Parked' },
    });

    expect(park).toEqual({ signalName: 'deploy' });
  });

  it('ignores a schema that is not an object', () => {
    const park = parkedHumanWait({
      toolName: 'requestHumanInput',
      result: { parked: true, signalName: 'deploy', inputSchema: 'nope' },
    });

    expect(park).toEqual({ signalName: 'deploy' });
  });

  it('reaches the replay-aware park marker, which re-announces a recovered wait', () => {
    const dispatched: Event[] = [];
    const sink = createHumanWaitMarkerSink(undefined);
    const record = {
      level: 'info',
      message: HUMAN_WAIT_PARKED_LOG_MARKER,
      attributes: {
        runId: 'run-1',
        signalName: 'deploy',
        prompt: 'Where to?',
        inputSchema: formSchema,
        emitter: { dispatch: (event: Event) => dispatched.push(event) },
      },
    } as unknown as WorkflowLogRecord;

    sink(record);

    const event = dispatched[0] as HumanWaitParkedEvent;
    expect(event.signalName).toBe('deploy');
    expect(event.inputSchema).toEqual(formSchema);
  });
});
