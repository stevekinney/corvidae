import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it, mock } from 'bun:test';
import { Conversation } from 'conversationalist';

import { GuardrailTripwireError } from '../errors';
import type { GuardrailFiring } from '../types';
import { createGuardrails } from './create-guardrails';
import type {
  DetectionResult,
  InputDetector,
  OutputValidator,
  SessionTaintedEvent,
  ValidationResult,
} from './types';

function createMockDetector(name: string, result: DetectionResult): InputDetector {
  return { name, detect: async () => result };
}

function createMockValidator(name: string, result: ValidationResult): OutputValidator {
  return { name, validate: async () => result };
}

function createTestContext(userMessage = 'Hello') {
  const conversation = new Conversation();
  conversation.appendUserMessage(userMessage);
  return { conversation, step: 1 };
}

const triggeredDetection: DetectionResult = {
  triggered: true,
  confidence: 0.95,
  category: 'prompt-injection',
  detail: 'Injection detected',
};

const safeDetection: DetectionResult = {
  triggered: false,
  confidence: 0,
  category: 'prompt-injection',
};

const invalidValidation: ValidationResult = {
  valid: false,
  confidence: 0.9,
  category: 'pii',
  detail: 'PII found',
  redacted: 'Redacted text',
};

const validValidation: ValidationResult = {
  valid: true,
  confidence: 0,
  category: 'pii',
};

describe('createGuardrails', () => {
  it('returns prepareStep, validateToolResult and validateResponse hooks', () => {
    const { prepareStep, validateToolResult, validateResponse } = createGuardrails({});
    expect(typeof prepareStep).toBe('function');
    expect(typeof validateToolResult).toBe('function');
    expect(typeof validateResponse).toBe('function');
  });

  describe('input guardrail integration', () => {
    it('blocks input when detector triggers', async () => {
      const detector = createMockDetector('test', triggeredDetection);
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector] },
      });

      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });

    it('allows input when no detector triggers', async () => {
      const detector = createMockDetector('test', safeDetection);
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector] },
      });

      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeUndefined();
    });
  });

  describe('output guardrail integration', () => {
    it('blocks output when validator triggers', async () => {
      const validator = createMockValidator('test', invalidValidation);
      const { validateResponse } = createGuardrails({
        output: { validators: [validator] },
      });

      const context = createTestContext();
      const response = {
        content: 'sensitive data',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      const result = await validateResponse(response, context);
      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });

    it('passes output when validator is clean', async () => {
      const validator = createMockValidator('test', validValidation);
      const { validateResponse } = createGuardrails({
        output: { validators: [validator] },
      });

      const context = createTestContext();
      const response = {
        content: 'safe text',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      const result = await validateResponse(response, context);
      expect(result).toBeUndefined();
    });
  });

  describe('session taint integration', () => {
    it('taints the session when a detector or a validator fails closed (COR-2300)', async () => {
      const taints: SessionTaintedEvent[] = [];
      const onTainted = (event: SessionTaintedEvent) => void taints.push(event);
      const input = createGuardrails({
        taint: { onTainted },
        input: {
          detectors: [
            {
              name: 'broken',
              detect: async () => {
                throw new Error('down');
              },
            },
          ],
          action: 'warn',
        },
      });
      const refused = await input.prepareStep(createTestContext());
      expect(refused?.content).toContain('blocked');
      expect(input.taint.isTainted()).toBe(true);

      const output = createGuardrails({
        taint: { onTainted },
        output: {
          validators: [
            {
              name: 'broken',
              validate: async () => {
                throw new Error('down');
              },
            },
          ],
        },
      });
      const blocked = await output.validateResponse(
        { content: 'a reply', toolCalls: [] },
        createTestContext(),
      );
      expect(blocked?.content).toContain('blocked');
      expect(output.taint.isTainted()).toBe(true);
      expect(taints).toEqual([
        expect.objectContaining({ detector: 'broken', category: 'detector-failure' }),
        expect.objectContaining({ detector: 'broken', category: 'detector-failure' }),
      ]);
    });

    it('taints session when input detection confidence exceeds threshold', async () => {
      const onTainted = mock((_event: SessionTaintedEvent) => {});
      const detector = createMockDetector('injection', {
        ...triggeredDetection,
        confidence: 0.95,
      });
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector] },
        taint: { taintThreshold: 0.9, onTainted },
      });

      const context = createTestContext();
      await prepareStep(context);

      expect(onTainted).toHaveBeenCalledTimes(1);
    });

    it('does not taint session when confidence is below threshold', async () => {
      const onTainted = mock((_event: SessionTaintedEvent) => {});
      const detector = createMockDetector('low', {
        triggered: true,
        confidence: 0.3,
        category: 'test',
      });
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector], action: 'warn' },
        taint: { taintThreshold: 0.9, onTainted },
      });

      const context = createTestContext();
      await prepareStep(context);

      expect(onTainted).not.toHaveBeenCalled();
    });

    it('adds escalated detectors after tainting', async () => {
      const escalatedDetectSpy = mock(async () => safeDetection);
      const escalatedDetector: InputDetector = {
        name: 'escalated',
        detect: escalatedDetectSpy,
      };

      let primaryCallCount = 0;
      const primaryDetector: InputDetector = {
        name: 'primary',
        detect: async () => {
          primaryCallCount++;
          // First call triggers and taints; subsequent calls are safe
          return primaryCallCount === 1 ? triggeredDetection : safeDetection;
        },
      };

      const { prepareStep } = createGuardrails({
        input: { detectors: [primaryDetector] },
        taint: {
          taintThreshold: 0.9,
          escalatedDetectors: [escalatedDetector],
        },
      });

      // First call: taints the session
      const context1 = createTestContext('injection attempt');
      await prepareStep(context1);

      // Second call: should include escalated detectors
      const context2 = createTestContext('normal message');
      await prepareStep(context2);

      expect(escalatedDetectSpy).toHaveBeenCalled();
    });

    it('runs escalated input detectors of a tainted session when the host has no input group', async () => {
      const detect = mock(async () => safeDetection);
      const { prepareStep, taint } = createGuardrails({
        taint: {
          escalatedDetectors: [{ name: 'escalated', detect }],
          initial: {
            category: 'prompt-injection',
            detector: 'earlier',
            provenance: 'user-input' as const,
            confidence: 0.95,
            at: 1,
            runId: 'run-1',
          },
        },
      });
      expect(taint.isTainted()).toBe(true);
      await prepareStep(createTestContext('a message'));
      expect(detect).toHaveBeenCalled();
    });

    it('adds escalated validators after tainting', async () => {
      const escalatedValidateSpy = mock(async () => validValidation);
      const escalatedValidator: OutputValidator = {
        name: 'escalated-v',
        validate: escalatedValidateSpy,
      };

      const detector = createMockDetector('trigger', triggeredDetection);

      const { prepareStep, validateResponse } = createGuardrails({
        input: { detectors: [detector] },
        output: { validators: [] },
        taint: {
          taintThreshold: 0.9,
          escalatedValidators: [escalatedValidator],
        },
      });

      // Taint via input
      const context1 = createTestContext('injection');
      await prepareStep(context1);

      // Now validate output — should include escalated validator
      const context2 = createTestContext('normal');
      const response = {
        content: 'response',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      await validateResponse(response, context2);

      expect(escalatedValidateSpy).toHaveBeenCalled();
    });
  });

  describe('mode: tripwire', () => {
    it('throws GuardrailTripwireError from prepareStep when an input detector triggers', async () => {
      const detector = createMockDetector('injection-detector', triggeredDetection);
      const { prepareStep } = createGuardrails({
        mode: 'tripwire',
        input: { detectors: [detector] },
      });

      const context = createTestContext();
      let caught: unknown;
      try {
        await prepareStep(context);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(GuardrailTripwireError);
      const tripwireError = caught as GuardrailTripwireError;
      expect(tripwireError.guardrailName).toBe('injection-detector');
      expect(tripwireError.category).toBe('prompt-injection');
      expect(tripwireError.phase).toBe('input');
      expect(tripwireError.confidence).toBe(0.95);
    });

    it('waits for an asynchronous taint write before it throws the tripwire (COR-2105)', async () => {
      let written = false;
      const { prepareStep } = createGuardrails({
        mode: 'tripwire',
        input: { detectors: [createMockDetector('injection-detector', triggeredDetection)] },
        taint: {
          runId: 'run-1',
          onTainted: async (event) => {
            await Promise.resolve();
            expect(event).toMatchObject({ category: 'prompt-injection', runId: 'run-1' });
            written = true;
          },
        },
      });
      expect(await rejectionOf(prepareStep(createTestContext()))).toBeInstanceOf(
        GuardrailTripwireError,
      );
      expect(written).toBe(true);
    });

    it('does not throw from prepareStep when no input detector triggers', async () => {
      const detector = createMockDetector('injection-detector', safeDetection);
      const { prepareStep } = createGuardrails({
        mode: 'tripwire',
        input: { detectors: [detector] },
      });

      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeUndefined();
    });

    it('throws GuardrailTripwireError from validateResponse when an output validator triggers', async () => {
      const validator = createMockValidator('pii-validator', invalidValidation);
      const { validateResponse } = createGuardrails({
        mode: 'tripwire',
        output: { validators: [validator] },
      });

      const context = createTestContext();
      const response = {
        content: 'sensitive data',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };

      let caught: unknown;
      try {
        await validateResponse(response, context);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(GuardrailTripwireError);
      const tripwireError = caught as GuardrailTripwireError;
      expect(tripwireError.guardrailName).toBe('pii-validator');
      expect(tripwireError.category).toBe('pii');
      expect(tripwireError.phase).toBe('output');
    });

    it('overrides an explicit action set on input/output options', async () => {
      // Even though the caller asked for 'warn', mode: 'tripwire' wins.
      const detector = createMockDetector('injection-detector', triggeredDetection);
      const { prepareStep } = createGuardrails({
        mode: 'tripwire',
        input: { detectors: [detector], action: 'warn' },
      });

      const context = createTestContext();
      let caught: unknown;
      try {
        await prepareStep(context);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GuardrailTripwireError);
    });

    it('mode: "validate" (the default) still substitutes a blocked response instead of throwing', async () => {
      const detector = createMockDetector('injection-detector', triggeredDetection);
      const { prepareStep } = createGuardrails({
        input: { detectors: [detector] },
      });

      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });
  });

  describe('empty configuration', () => {
    it('prepareStep is a no-op with no input config', async () => {
      const { prepareStep } = createGuardrails({});
      const context = createTestContext();
      const result = await prepareStep(context);
      expect(result).toBeUndefined();
    });

    it('validateResponse is a no-op with no output config', async () => {
      const { validateResponse } = createGuardrails({});
      const context = createTestContext();
      const response = {
        content: 'text',
        toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
      };
      const result = await validateResponse(response, context);
      expect(result).toBeUndefined();
    });
  });
});

describe('createGuardrails reporting to the run', () => {
  function reporter() {
    const firings: GuardrailFiring[] = [];
    return { firings, reportGuardrail: (firing: GuardrailFiring) => void firings.push(firing) };
  }

  it('reports a validate-mode input block, naming the detector and neither text nor detail', async () => {
    const { prepareStep } = createGuardrails({
      mode: 'validate',
      input: { detectors: [createMockDetector('injection-detector', triggeredDetection)] },
    });
    const { firings, reportGuardrail } = reporter();

    const result = await prepareStep({ ...createTestContext('secret-canary'), reportGuardrail });

    expect(result?.content).toContain('blocked by input guardrail');
    expect(firings).toEqual([
      {
        guardrailName: 'injection-detector',
        category: 'prompt-injection',
        phase: 'input',
        confidence: 0.95,
        action: 'block',
      },
    ]);
    expect(JSON.stringify(firings)).not.toContain('secret-canary');
    expect(JSON.stringify(firings)).not.toContain('Injection detected');
  });

  it('reports a validate-mode output redaction', async () => {
    const { validateResponse } = createGuardrails({
      mode: 'validate',
      output: {
        action: 'redact',
        validators: [createMockValidator('output-pii', invalidValidation)],
      },
    });
    const { firings, reportGuardrail } = reporter();

    const result = await validateResponse(
      { content: 'jane@example.com', toolCalls: [] },
      { ...createTestContext(), reportGuardrail },
    );

    expect(result?.content).toBe('Redacted text');
    expect(firings).toEqual([
      {
        guardrailName: 'output-pii',
        category: 'pii',
        phase: 'output',
        confidence: 0.9,
        action: 'redact',
      },
    ]);
  });

  it('reports nothing for a tripwire, whose halt is the run.tripwire event', async () => {
    const { prepareStep, validateResponse } = createGuardrails({
      mode: 'tripwire',
      input: { detectors: [createMockDetector('injection-detector', triggeredDetection)] },
      output: { validators: [createMockValidator('output-pii', invalidValidation)] },
    });
    const { firings, reportGuardrail } = reporter();

    const halts: unknown[] = [];
    for (const attempt of [
      () => prepareStep({ ...createTestContext(), reportGuardrail }),
      () =>
        validateResponse(
          { content: 'x', toolCalls: [] },
          { ...createTestContext(), reportGuardrail },
        ),
    ]) {
      try {
        await attempt();
      } catch (error) {
        halts.push(error);
      }
    }

    expect(halts).toHaveLength(2);
    expect(halts.every((error) => error instanceof GuardrailTripwireError)).toBe(true);
    expect(firings).toEqual([]);
  });

  it('reports nothing when nothing trips', async () => {
    const { prepareStep } = createGuardrails({
      mode: 'validate',
      input: { detectors: [createMockDetector('d', safeDetection)] },
    });
    const { firings, reportGuardrail } = reporter();
    await prepareStep({ ...createTestContext(), reportGuardrail });
    expect(firings).toEqual([]);
  });
});

describe('createGuardrails tool-result scanning (COR-2103)', () => {
  const lowConfidence: DetectionResult = { ...triggeredDetection, confidence: 0.5 };

  function toolResultContext() {
    return { conversation: new Conversation(), step: 3, toolCalls: [], results: [] };
  }

  const flagged = {
    callId: 'call-1',
    toolCallId: 'call-1',
    toolName: 'fetch',
    outcome: 'success' as const,
    content: 'flagged page',
    result: 'flagged page',
  };

  it('taints on a block even below the taint threshold', async () => {
    const taints: SessionTaintedEvent[] = [];
    const { validateToolResult, taint } = createGuardrails({
      input: { detectors: [createMockDetector('sentinel', lowConfidence)], action: 'block' },
      taint: { taintThreshold: 0.9, onTainted: (event) => taints.push(event) },
    });
    const replaced = await validateToolResult(flagged, toolResultContext());
    expect(replaced?.error?.code).toBe('GUARDRAIL_BLOCKED');
    expect(taint.isTainted()).toBe(true);
    expect(taints).toEqual([
      expect.objectContaining({ detector: 'sentinel', step: 3, provenance: 'tool-result' }),
    ]);
  });

  it('does not taint on a warning below the taint threshold', async () => {
    const { validateToolResult, taint } = createGuardrails({
      input: { detectors: [createMockDetector('sentinel', lowConfidence)], action: 'warn' },
      taint: { taintThreshold: 0.9 },
    });
    expect(await validateToolResult(flagged, toolResultContext())).toBeUndefined();
    expect(taint.isTainted()).toBe(false);
  });

  it('adds the escalated detectors once the session is tainted', async () => {
    const escalated = createMockDetector('escalated', triggeredDetection);
    const { validateToolResult, taint } = createGuardrails({
      input: { detectors: [], action: 'block' },
      taint: { escalatedDetectors: [escalated] },
    });
    expect(await validateToolResult(flagged, toolResultContext())).toBeUndefined();
    taint.taint({ reason: 'test', detector: 'test', category: 'test', confidence: 1, step: 1 });
    const replaced = await validateToolResult(flagged, toolResultContext());
    expect(replaced?.error?.message).toContain('"escalated"');
  });

  it('is a no-op without input detectors configured', async () => {
    const { validateToolResult } = createGuardrails({
      output: { validators: [createMockValidator('pii', invalidValidation)] },
    });
    expect(await validateToolResult(flagged, toolResultContext())).toBeUndefined();
  });

  it('throws a tool-result tripwire under mode tripwire whatever input.action says', async () => {
    const { validateToolResult } = createGuardrails({
      mode: 'tripwire',
      input: { detectors: [createMockDetector('sentinel', triggeredDetection)], action: 'warn' },
    });
    const thrown = await validateToolResult(flagged, toolResultContext()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(GuardrailTripwireError);
    expect((thrown as GuardrailTripwireError).phase).toBe('tool-result');
  });

  describe('a text body no detector can decode', () => {
    const undecodable = {
      ...flagged,
      content: null,
      result: null,
      parts: [
        {
          type: 'document' as const,
          mimeType: 'text/plain',
          source: { kind: 'data-url' as const, url: 'data:text/plain;base64,/w==' },
        },
      ],
    };
    const clean = createMockDetector('sentinel', safeDetection);

    it('is blocked under validate mode, and taints, as it is in a user message', async () => {
      const taints: SessionTaintedEvent[] = [];
      const { validateToolResult, taint } = createGuardrails({
        mode: 'validate',
        input: { detectors: [clean], action: 'warn' },
        taint: { onTainted: (event) => taints.push(event) },
      });
      const replaced = await validateToolResult(undecodable, toolResultContext());
      expect(replaced?.error?.code).toBe('GUARDRAIL_BLOCKED');
      expect(replaced?.error?.message).toContain('"content-body"');
      expect(replaced?.parts).toBeUndefined();
      expect(taint.isTainted()).toBe(true);
      expect(taints).toEqual([
        expect.objectContaining({ detector: 'content-body', provenance: 'tool-result' }),
      ]);
    });

    it('halts under the default preset with a tool-result tripwire', async () => {
      const { validateToolResult } = createGuardrails({
        mode: 'tripwire',
        input: { detectors: [clean] },
      });
      const thrown = await validateToolResult(undecodable, toolResultContext()).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(GuardrailTripwireError);
      expect((thrown as GuardrailTripwireError).phase).toBe('tool-result');
      expect((thrown as GuardrailTripwireError).guardrailName).toBe('content-body');
    });
  });

  it('reports a validate-mode firing at the tool-result phase, and no tripwire firing', async () => {
    const firings: GuardrailFiring[] = [];
    const reportGuardrail = (firing: GuardrailFiring) => void firings.push(firing);
    const validate = createGuardrails({
      input: { detectors: [createMockDetector('sentinel', triggeredDetection)], action: 'block' },
    });
    await validate.validateToolResult(flagged, { ...toolResultContext(), reportGuardrail });
    expect(firings).toEqual([
      {
        guardrailName: 'sentinel',
        category: 'prompt-injection',
        phase: 'tool-result',
        confidence: 0.95,
        action: 'block',
      },
    ]);

    const tripwire = createGuardrails({
      mode: 'tripwire',
      input: { detectors: [createMockDetector('sentinel', triggeredDetection)] },
    });
    await tripwire
      .validateToolResult(flagged, { ...toolResultContext(), reportGuardrail })
      .catch(() => undefined);
    expect(firings).toHaveLength(1);
  });
});

/**
 * COR-2104 — a detector or validator may carry an action of its own. It keeps it under either mode;
 * a bare one takes its group's. The guardrails of each action run apart, the furthest-reaching
 * first, so one set to warn never lets through what a blocking one refuses.
 */
describe('createGuardrails with an action per guardrail', () => {
  const flaggedResult = {
    callId: 'call-1',
    toolCallId: 'call-1',
    toolName: 'fetch',
    outcome: 'success' as const,
    content: 'flagged page',
    result: 'flagged page',
  };
  const toolResultContext = () => ({
    conversation: new Conversation(),
    step: 3,
    toolCalls: [],
    results: [],
  });

  it('an input entry set to warn warns in a block group, and a bare one still blocks', async () => {
    const firings: GuardrailFiring[] = [];
    const reportGuardrail = (firing: GuardrailFiring) => void firings.push(firing);
    const warned = createGuardrails({
      input: {
        action: 'block',
        detectors: [{ guardrail: createMockDetector('d', triggeredDetection), action: 'warn' }],
      },
    });
    expect(await warned.prepareStep({ ...createTestContext(), reportGuardrail })).toBeUndefined();
    expect(firings.map((firing) => firing.action)).toEqual(['warn']);

    const blocked = createGuardrails({
      input: {
        action: 'block',
        detectors: [
          { guardrail: createMockDetector('warns', triggeredDetection), action: 'warn' },
          createMockDetector('blocks', triggeredDetection),
        ],
      },
    });
    const answer = await blocked.prepareStep(createTestContext());
    expect(answer?.content).toContain('blocked by input guardrail');
  });

  it('an input entry keeps its own action under mode tripwire', async () => {
    const own = createGuardrails({
      mode: 'tripwire',
      input: {
        detectors: [{ guardrail: createMockDetector('d', triggeredDetection), action: 'block' }],
      },
    });
    const answer = await own.prepareStep(createTestContext());
    expect(answer?.content).toContain('blocked');

    const bare = createGuardrails({
      mode: 'tripwire',
      input: { detectors: [createMockDetector('d', triggeredDetection)], action: 'block' },
    });
    expect(await bare.prepareStep(createTestContext()).catch((error) => error)).toBeInstanceOf(
      GuardrailTripwireError,
    );
  });

  it('a tripwire entry halts before a block entry answers', async () => {
    const guardrails = createGuardrails({
      mode: 'validate',
      input: {
        action: 'block',
        detectors: [
          createMockDetector('blocks', triggeredDetection),
          { guardrail: createMockDetector('trips', triggeredDetection), action: 'tripwire' },
        ],
      },
    });
    const thrown = await guardrails.prepareStep(createTestContext()).catch((error) => error);
    expect(thrown).toMatchObject({ guardrailName: 'trips', phase: 'input' });
  });

  it('an output entry set to warn warns in a block group, and a bare one still blocks', async () => {
    const response = { content: 'my email is a@b.c', toolCalls: [] };
    const warned = createGuardrails({
      output: {
        action: 'block',
        validators: [{ guardrail: createMockValidator('v', invalidValidation), action: 'warn' }],
      },
    });
    expect(await warned.validateResponse(response, createTestContext())).toBeUndefined();

    const blocked = createGuardrails({
      output: {
        action: 'redact',
        validators: [
          { guardrail: createMockValidator('warns', invalidValidation), action: 'warn' },
          { guardrail: createMockValidator('blocks', invalidValidation), action: 'block' },
        ],
      },
    });
    const answer = await blocked.validateResponse(response, createTestContext());
    expect(answer?.content).toContain('blocked by output guardrail');
  });

  it('an input entry set to warn passes a tool result in a block group', async () => {
    const firings: GuardrailFiring[] = [];
    const guardrails = createGuardrails({
      input: {
        action: 'block',
        detectors: [{ guardrail: createMockDetector('d', triggeredDetection), action: 'warn' }],
      },
    });
    const answer = await guardrails.validateToolResult(flaggedResult, {
      ...toolResultContext(),
      reportGuardrail: (firing) => void firings.push(firing),
    });
    expect(answer).toBeUndefined();
    expect(firings).toEqual([expect.objectContaining({ phase: 'tool-result', action: 'warn' })]);
  });

  it('the group’s own action still refuses a body no detector can decode', async () => {
    const guardrails = createGuardrails({
      input: {
        action: 'block',
        detectors: [{ guardrail: createMockDetector('d', safeDetection), action: 'warn' }],
      },
    });
    const answer = await guardrails.validateToolResult(
      {
        ...flaggedResult,
        content: null,
        result: null,
        parts: [
          {
            type: 'document' as const,
            mimeType: 'text/plain',
            source: { kind: 'data-url' as const, url: 'data:text/plain;base64,/w==' },
          },
        ],
      },
      toolResultContext(),
    );
    expect(answer?.error?.message).toContain('"content-body"');
  });

  it('refuses an action its group does not have, rather than leave the guardrail unrun', async () => {
    const guardrails = createGuardrails({
      input: {
        detectors: [
          {
            guardrail: createMockDetector('d', triggeredDetection),
            action: 'redact' as 'block',
          },
        ],
      },
    });
    expect(
      await guardrails.prepareStep(createTestContext()).catch((error) => error),
    ).toBeInstanceOf(TypeError);
  });
});
