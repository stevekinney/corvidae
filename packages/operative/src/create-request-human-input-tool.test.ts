import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { createTool, createToolbox, createToolCall } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type {
  RequestHumanInputContext,
  RequestHumanInputOutcome,
  RequestHumanInputResult,
} from './create-request-human-input-tool';
import { createRequestHumanInputTool } from './create-request-human-input-tool';
import { createScheduleWakeupTool } from './create-schedule-wakeup-tool';
import { DurableCapabilityUnavailableError } from './durable/durable-capability-unavailable-error';
import type { CombinedOperativeEventMap } from './events';
import { HumanWaitParkedEvent } from './events';

describe('createRequestHumanInputTool', () => {
  function makeContext(runId?: string, durable = true): RequestHumanInputContext {
    return { pendingHumanWait: undefined, pendingWakeup: undefined, runId, durable };
  }

  /** Narrows an outcome the test expects to have parked. */
  function expectParked(outcome: RequestHumanInputOutcome): RequestHumanInputResult {
    if (!outcome.parked) throw new Error(`expected a parked result, got: ${outcome.message}`);
    return outcome;
  }

  function makeEmitter() {
    return new CompletableEventTarget<CombinedOperativeEventMap>();
  }

  it('has the correct tool name', () => {
    const tool = createRequestHumanInputTool({ context: makeContext() });
    expect(tool.name).toBe('requestHumanInput');
  });

  it('has a non-empty description', () => {
    const tool = createRequestHumanInputTool({ context: makeContext() });
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('writes the signalName into context.pendingHumanWait', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    tool.execute({ signalName: 'human-response' });

    expect(context.pendingHumanWait?.signalName).toBe('human-response');
  });

  it('writes the prompt into context.pendingHumanWait when provided', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    tool.execute({ signalName: 'human-response', prompt: 'Please approve this action' });

    expect(context.pendingHumanWait?.prompt).toBe('Please approve this action');
  });

  it('leaves prompt undefined in context when not provided', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    tool.execute({ signalName: 'human-response' });

    expect(context.pendingHumanWait?.prompt).toBeUndefined();
  });

  it('returns parked:true with the signalName', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    const result = expectParked(tool.execute({ signalName: 'human-response' }));

    expect(result.parked).toBe(true);
    expect(result.signalName).toBe('human-response');
  });

  it('includes prompt in result when provided', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    const result = expectParked(tool.execute({ signalName: 'human-response', prompt: 'Approve?' }));

    expect(result.prompt).toBe('Approve?');
  });

  it('does not include prompt in result when not provided', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    const result = expectParked(tool.execute({ signalName: 'human-response' }));

    expect(result.prompt).toBeUndefined();
  });

  it('returns a human-readable message containing the signalName', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    const result = tool.execute({ signalName: 'human-response' });

    expect(result.message).toContain('human-response');
  });

  it('includes the prompt in the message when provided', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    const result = tool.execute({ signalName: 'human-response', prompt: 'Do you approve?' });

    expect(result.message).toContain('Do you approve?');
  });

  describe('first park request wins (COR-1578)', () => {
    const pendingMessage = (name: string) =>
      `Not requested: this step already waits for human signal "${name}". Request it again after that wait ends.`;

    it('keeps the first signal and refuses a second one with the exact refusal shape', () => {
      const context = makeContext();
      const tool = createRequestHumanInputTool({ context });

      const first = tool.execute({ signalName: 'a', prompt: 'Approve a?' });
      const second = tool.execute({ signalName: 'b', prompt: 'Approve b?' });

      expect(first).toEqual({
        parked: true,
        signalName: 'a',
        prompt: 'Approve a?',
        message: 'Parked waiting for human signal "a". Prompt: Approve a?',
      });
      expect(second).toEqual({
        parked: false,
        signalName: 'b',
        refused: true,
        pendingPark: { kind: 'human-input', signalName: 'a' },
        message: pendingMessage('a'),
      });
      expect(context.pendingHumanWait).toEqual({ signalName: 'a', prompt: 'Approve a?' });
    });

    it('refuses a repeat of the same signal name the same way', () => {
      const context = makeContext();
      const tool = createRequestHumanInputTool({ context });

      tool.execute({ signalName: 'a' });
      const second = tool.execute({ signalName: 'a' });

      expect(second).toEqual({
        parked: false,
        signalName: 'a',
        refused: true,
        pendingPark: { kind: 'human-input', signalName: 'a' },
        message: pendingMessage('a'),
      });
      expect(context.pendingHumanWait).toEqual({ signalName: 'a' });
    });

    it('dispatches exactly one HumanWaitParkedEvent for a refused second call', () => {
      const context = makeContext('run-1');
      const emitter = makeEmitter();
      const tool = createRequestHumanInputTool({ context, emitter });
      const received: HumanWaitParkedEvent[] = [];
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        received.push(event);
      });

      tool.execute({ signalName: 'a' });
      tool.execute({ signalName: 'b' });
      tool.execute({ signalName: 'a' });

      expect(received.map((event) => event.signalName)).toEqual(['a']);
    });

    it('refuses a human-input request when a wakeup already holds the step', () => {
      const context = makeContext('run-1');
      const emitter = makeEmitter();
      const humanInput = createRequestHumanInputTool({ context, emitter });
      const wakeup = createScheduleWakeupTool({ context });
      const received: HumanWaitParkedEvent[] = [];
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        received.push(event);
      });

      wakeup.execute({ in: '6h', note: 'check' });
      const refused = humanInput.execute({ signalName: 'a', prompt: 'Approve?' });

      expect(refused).toEqual({
        parked: false,
        signalName: 'a',
        refused: true,
        pendingPark: { kind: 'wakeup', duration: '6h' },
        message:
          'Not requested: this step already waits for a wakeup in 6h. Request it again after that wait ends.',
      });
      expect(context.pendingHumanWait).toBeUndefined();
      expect(context.pendingWakeup).toEqual({ duration: '6h', note: 'check' });
      expect(received).toHaveLength(0);
    });

    it('names a numeric wakeup duration the way the wakeup success message does', () => {
      const context = makeContext();
      const humanInput = createRequestHumanInputTool({ context });
      const wakeup = createScheduleWakeupTool({ context });

      wakeup.execute({ in: 1500 });
      const refused = humanInput.execute({ signalName: 'a' });

      expect(refused.message).toBe(
        'Not requested: this step already waits for a wakeup in 1500ms. Request it again after that wait ends.',
      );
      expect(refused).toMatchObject({ pendingPark: { kind: 'wakeup', duration: 1500 } });
    });

    it('runs through a sequential toolbox: first call parks, second is refused, in order', async () => {
      const context = makeContext('run-1');
      const raw = createRequestHumanInputTool({ context });
      const tool = createTool({
        ...raw,
        execute: async (input) => await Promise.resolve(raw.execute(input)),
      });
      const toolbox = createToolbox([tool]);

      const results = await toolbox.execute(
        [
          createToolCall(tool.name, { signalName: 'a' }),
          createToolCall(tool.name, { signalName: 'b' }),
        ],
        { mode: 'sequential' },
      );

      expect(results.map((result) => result.outcome)).toEqual(['success', 'success']);
      expect(results[0]?.result).toMatchObject({ parked: true, signalName: 'a' });
      expect(results[1]?.result).toMatchObject({
        parked: false,
        refused: true,
        signalName: 'b',
        pendingPark: { kind: 'human-input', signalName: 'a' },
      });
    });

    it('describes the rule to the model in the exact sentence', () => {
      const tool = createRequestHumanInputTool({ context: makeContext() });
      expect(tool.description).toContain(
        'Only the first human-input or wakeup request in a step is honored.',
      );
    });
  });

  describe('F3 / C3 event emission', () => {
    it('dispatches HumanWaitParkedEvent when an emitter is provided', () => {
      const context = makeContext('run-42');
      const emitter = makeEmitter();
      const tool = createRequestHumanInputTool({ context, emitter });

      const received: HumanWaitParkedEvent[] = [];
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        received.push(event);
      });

      tool.execute({ signalName: 'human-response' });

      expect(received).toHaveLength(1);
      expect(received[0]?.signalName).toBe('human-response');
      expect(received[0]?.runId).toBe('run-42');
    });

    it('includes the correct signal name in the emitted event', () => {
      const context = makeContext();
      const emitter = makeEmitter();
      const tool = createRequestHumanInputTool({ context, emitter });

      let capturedSignalName: string | undefined;
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        capturedSignalName = event.signalName;
      });

      tool.execute({ signalName: 'approval-gate' });

      expect(capturedSignalName).toBe('approval-gate');
    });

    it('uses an empty string for runId when not provided in context', () => {
      const context = makeContext();
      const emitter = makeEmitter();
      const tool = createRequestHumanInputTool({ context, emitter });

      let capturedRunId: string | undefined;
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        capturedRunId = event.runId;
      });

      tool.execute({ signalName: 'human-response' });

      expect(capturedRunId).toBe('');
    });

    it('does not emit any event when no emitter is provided', () => {
      const context = makeContext();
      // No emitter — just verify this does not throw and the tool still works.
      const tool = createRequestHumanInputTool({ context });

      expect(() => {
        tool.execute({ signalName: 'human-response' });
      }).not.toThrow();

      expect(context.pendingHumanWait?.signalName).toBe('human-response');
    });

    // Regression: PRRT_kwDORvupsc6Mc3gW — the schema doc promises the prompt is
    // surfaced in the HumanWaitParkedEvent, but the dispatch dropped it, so UI /
    // event-stream consumers could not show what input was being requested.
    it('threads the prompt into the emitted event when provided (PRRT_kwDORvupsc6Mc3gW)', () => {
      const context = makeContext('run-7');
      const emitter = makeEmitter();
      const tool = createRequestHumanInputTool({ context, emitter });

      let capturedPrompt: string | undefined;
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        capturedPrompt = event.prompt;
      });

      tool.execute({ signalName: 'human-response', prompt: 'Approve this deployment?' });

      expect(capturedPrompt).toBe('Approve this deployment?');
    });

    it('leaves the event prompt undefined when no prompt is provided (PRRT_kwDORvupsc6Mc3gW)', () => {
      const context = makeContext('run-8');
      const emitter = makeEmitter();
      const tool = createRequestHumanInputTool({ context, emitter });

      const received: HumanWaitParkedEvent[] = [];
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        received.push(event);
      });

      tool.execute({ signalName: 'human-response' });

      expect(received[0]?.prompt).toBeUndefined();
    });
  });

  describe('input schema', () => {
    it('exposes an input Zod schema so armorer does not strip arguments', () => {
      const tool = createRequestHumanInputTool({ context: makeContext() });

      // The tool MUST have an `input` schema. Without it, armorer's
      // normalizeSchema(undefined) returns z.object({}) which strips every
      // field before execute() is called (Zod strips unknown keys by default),
      // causing pendingHumanWait.signalName to be undefined so the durable run
      // can never be released by the intended human signal.
      expect(tool.input).toBeDefined();
    });

    it('input schema preserves signalName and prompt when parsed', () => {
      const tool = createRequestHumanInputTool({ context: makeContext() });

      const parsed = tool.input.parse({ signalName: 'human-response', prompt: 'Approve this?' });

      // Both fields must survive schema parsing — no stripping.
      expect(parsed.signalName).toBe('human-response');
      expect(parsed.prompt).toBe('Approve this?');
    });

    it('input schema treats prompt as optional', () => {
      const tool = createRequestHumanInputTool({ context: makeContext() });

      const parsed = tool.input.parse({ signalName: 'human-response' });

      expect(parsed.signalName).toBe('human-response');
      expect(parsed.prompt).toBeUndefined();
    });

    it('input schema rejects calls with no signalName field', () => {
      const tool = createRequestHumanInputTool({ context: makeContext() });

      expect(() => tool.input.parse({ prompt: 'oops' })).toThrow();
    });
  });

  // AB-41 / AB-43 — an unavailable capability rejects with a stable typed
  // error rather than returning a success-shaped no-op.
  describe('when context.durable is false', () => {
    it('throws DurableCapabilityUnavailableError instead of writing pendingHumanWait', () => {
      const context = makeContext(undefined, false);
      const tool = createRequestHumanInputTool({ context });

      expect(() => tool.execute({ signalName: 'human-response' })).toThrow(
        DurableCapabilityUnavailableError,
      );
      expect(context.pendingHumanWait).toBeUndefined();
    });

    it('throws an error satisfying armorer isToolError (code, category, retryable, message)', () => {
      const context = makeContext(undefined, false);
      const tool = createRequestHumanInputTool({ context });

      try {
        tool.execute({ signalName: 'human-response' });
        throw new Error('expected execute to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DurableCapabilityUnavailableError);
        const durableError = error as DurableCapabilityUnavailableError;
        expect(durableError.code).toBe('DurableCapabilityUnavailableError');
        expect(durableError.category).toBe('unavailable');
        expect(durableError.retryable).toBe(false);
        expect(durableError.message).toContain('requestHumanInput');
      }
    });

    it('does not dispatch HumanWaitParkedEvent when rejected as unavailable', () => {
      const context = makeContext('run-9', false);
      const emitter = makeEmitter();
      const tool = createRequestHumanInputTool({ context, emitter });

      const received: HumanWaitParkedEvent[] = [];
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => {
        received.push(event);
      });

      expect(() => tool.execute({ signalName: 'human-response' })).toThrow(
        DurableCapabilityUnavailableError,
      );
      expect(received).toHaveLength(0);
    });

    it('throws instead of refusing when a slot is already set (the durable check runs first)', () => {
      const context = makeContext(undefined, false);
      context.pendingHumanWait = { signalName: 'existing' };
      const tool = createRequestHumanInputTool({ context });

      expect(() => tool.execute({ signalName: 'human-response' })).toThrow(
        DurableCapabilityUnavailableError,
      );
    });

    it('does not overwrite an existing pendingHumanWait slot', () => {
      const context = makeContext(undefined, false);
      context.pendingHumanWait = { signalName: 'existing' };
      const tool = createRequestHumanInputTool({ context });

      expect(() => tool.execute({ signalName: 'human-response' })).toThrow(
        DurableCapabilityUnavailableError,
      );
      expect(context.pendingHumanWait).toEqual({ signalName: 'existing' });
    });
  });

  // Configuration 1 of AB-43's four named configurations: a standalone
  // in-memory agent (no Bureau composition) — the tool has no way to be
  // omitted from the toolbox, so it must reject on invocation. Routes the
  // thrown error through armorer's real `createToolbox`/`isToolError` catch
  // to prove the resulting `ToolExecutionResult.error.category` is
  // `'unavailable'`, exactly as AB-41's decision record specifies.
  describe('standalone createAgent toolbox (armorer integration)', () => {
    it('rejects with an unavailable ToolExecutionResult when the standalone toolbox has no durable run', async () => {
      const context = makeContext(undefined, false);
      const rawTool = createRequestHumanInputTool({ context });
      const tool = createTool({
        ...rawTool,
        execute: async (input) => await Promise.resolve(rawTool.execute(input)),
      });
      const toolbox = createToolbox([tool]);

      const result = await toolbox.execute(
        createToolCall(tool.name, { signalName: 'human-response' }),
      );

      expect(result.outcome).toBe('error');
      expect(result.error?.code).toBe('DurableCapabilityUnavailableError');
      expect(result.error?.category).toBe('unavailable');
      expect(result.error?.retryable).toBe(false);
    });
  });
});
