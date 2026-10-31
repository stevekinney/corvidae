import { describe, expect, it, mock } from 'bun:test';
import { Conversation } from 'conversationalist';

import { GuardrailTripwireError } from '../errors';
import { createOutputGuardrail } from './output-guardrail';
import type {
  OutputGuardrailTriggeredEvent,
  OutputValidator,
  ValidationResult,
  ValidatorContext,
} from './types';

function createMockValidator(name: string, result: ValidationResult): OutputValidator {
  return {
    name,
    validate: async () => result,
  };
}

function createMockStepContext() {
  const conversation = new Conversation();
  conversation.appendUserMessage('Hello');
  return { conversation, step: 1 };
}

function createMockResponse(content = 'Response text') {
  return { content, toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> }> };
}

const invalidResult: ValidationResult = {
  valid: false,
  confidence: 0.9,
  category: 'test-violation',
  detail: 'Test violation found',
};

const invalidWithRedaction: ValidationResult = {
  valid: false,
  confidence: 0.9,
  category: 'test-violation',
  detail: 'Test violation found',
  redacted: 'Redacted response text',
};

const validResult: ValidationResult = {
  valid: true,
  confidence: 0,
  category: 'test-check',
};

describe('createOutputGuardrail', () => {
  describe('action: block (default)', () => {
    it('returns a new GenerateResponse with refusal text when a validator triggers', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({ validators: [validator] });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
      expect(result?.toolCalls).toEqual([]);
    });

    it('returns void when all validators pass', async () => {
      const validator = createMockValidator('test-validator', validResult);
      const hook = createOutputGuardrail({ validators: [validator] });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeUndefined();
    });

    it('uses custom blockMessage when provided', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        blockMessage: 'Custom refusal message',
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result?.content).toBe('Custom refusal message');
    });

    it('calls onTriggered callback when blocking', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        onTriggered,
      });

      const response = createMockResponse('original output');
      const context = createMockStepContext();
      await hook(response, context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event.validator).toBe('test-validator');
      expect(event.action).toBe('block');
      expect(event.output).toBe('original output');
    });
  });

  describe('action: warn', () => {
    it('returns void (passes through) when a validator triggers', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'warn',
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeUndefined();
    });

    it('calls onTriggered callback when warning', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'warn',
        onTriggered,
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      await hook(response, context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
      const event = onTriggered.mock.calls[0]![0];
      expect(event.action).toBe('warn');
    });
  });

  describe('action: redact', () => {
    it('returns a new GenerateResponse with redacted content', async () => {
      const validator = createMockValidator('test-validator', invalidWithRedaction);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'redact',
      });

      const response = createMockResponse('Original sensitive text');
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeDefined();
      expect(result?.content).toBe('Redacted response text');
      expect(result?.toolCalls).toEqual([]);
    });

    it('falls back to block when no redacted version is available', async () => {
      const validator = createMockValidator('test-validator', invalidResult);
      const hook = createOutputGuardrail({
        validators: [validator],
        action: 'redact',
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);

      expect(result).toBeDefined();
      expect(result?.content).toContain('blocked');
    });
  });

  describe('multiple validators', () => {
    it('triggers on the first failed validation', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const first = createMockValidator('first', invalidResult);
      const second = createMockValidator('second', validResult);
      const hook = createOutputGuardrail({
        validators: [first, second],
        onTriggered,
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      await hook(response, context);

      expect(onTriggered).toHaveBeenCalledTimes(1);
    });

    it('picks the highest-confidence failure', async () => {
      const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
      const low: ValidationResult = { valid: false, confidence: 0.3, category: 'low' };
      const high: ValidationResult = { valid: false, confidence: 0.95, category: 'high' };
      const first = createMockValidator('low-validator', low);
      const second = createMockValidator('high-validator', high);
      const hook = createOutputGuardrail({
        validators: [first, second],
        onTriggered,
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      await hook(response, context);

      const event = onTriggered.mock.calls[0]![0];
      expect(event.validator).toBe('high-validator');
    });
  });

  describe('error resilience', () => {
    it('does not crash when a validator throws', async () => {
      const brokenValidator: OutputValidator = {
        name: 'broken',
        validate: async () => {
          throw new Error('validator crash');
        },
      };
      const hook = createOutputGuardrail({ validators: [brokenValidator] });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);
      expect(result).toBeUndefined();
    });

    it('still catches violations when some validators throw', async () => {
      const brokenValidator: OutputValidator = {
        name: 'broken',
        validate: async () => {
          throw new Error('validator crash');
        },
      };
      const workingValidator = createMockValidator('working', invalidResult);
      const hook = createOutputGuardrail({
        validators: [brokenValidator, workingValidator],
      });

      const response = createMockResponse();
      const context = createMockStepContext();
      const result = await hook(response, context);
      expect(result).toBeDefined();
    });
  });

  describe('context construction', () => {
    it('passes correct validator context', async () => {
      const validateSpy = mock(async (_output: string, _ctx: ValidatorContext) => validResult);
      const validator: OutputValidator = { name: 'spy', validate: validateSpy };
      const hook = createOutputGuardrail({ validators: [validator] });

      const conversation = new Conversation();
      conversation.appendUserMessage('first');
      conversation.appendAssistantMessage('reply');

      const response = createMockResponse();
      response.toolCalls = [
        { name: 'tool1', arguments: {} },
        { name: 'tool2', arguments: {} },
      ];

      await hook(response, { conversation, step: 5 });

      expect(validateSpy).toHaveBeenCalledTimes(1);
      const args = validateSpy.mock.calls[0]!;
      const output = args[0];
      const ctx = args[1];
      expect(output).toBe('Response text');
      expect(ctx.step).toBe(5);
      expect(ctx.conversationLength).toBe(2);
      expect(ctx.toolCallCount).toBe(2);
    });

    it('offers the conversation as text, read only when a validator asks', async () => {
      const seen: string[] = [];
      const validator: OutputValidator = {
        name: 'reader',
        validate: async (_output, ctx) => {
          seen.push(ctx.conversationText?.() ?? 'missing');
          return validResult;
        },
      };
      const hook = createOutputGuardrail({ validators: [validator] });
      const conversation = new Conversation();
      conversation.appendUserMessage('The invoice total is 72 dollars.');
      conversation.appendAssistantMessage('Noted.');

      await hook(createMockResponse(), { conversation, step: 1 });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('The invoice total is 72 dollars.');
      expect(seen[0]).toContain('Noted.');
    });

    it('reads the conversation as it stood when the validator ran, not a later one', async () => {
      let read: (() => string) | undefined;
      const validator: OutputValidator = {
        name: 'keeper',
        validate: async (_output, ctx) => {
          read = ctx.conversationText;
          return validResult;
        },
      };
      const hook = createOutputGuardrail({ validators: [validator] });
      const conversation = new Conversation();
      conversation.appendUserMessage('before');

      await hook(createMockResponse(), { conversation, step: 1 });
      conversation.appendUserMessage('after');

      expect(read?.()).toContain('before');
      expect(read?.()).not.toContain('after');
    });
  });
});

describe('createOutputGuardrail over thinking parts (COR-1806)', () => {
  /** Flags any text that contains `SECRET`, and offers the text with it redacted. */
  const secretValidator: OutputValidator = {
    name: 'secret',
    validate: async (text) =>
      text.includes('SECRET')
        ? {
            valid: false,
            confidence: 0.9,
            category: 'secret',
            redacted: text.replaceAll('SECRET', '[REDACTED]'),
          }
        : { valid: true, confidence: 0, category: 'secret' },
  };

  const thinking = (text: string) => ({
    type: 'thinking' as const,
    thinking: text,
    signature: 'signature',
  });

  /** A clean answer whose reasoning (and nothing else) holds the secret. */
  function responseWithThought(thought: string) {
    const call = { id: 'call-1', name: 'lookup', arguments: {} };
    return {
      content: 'A clean answer.',
      toolCalls: [call],
      parts: [
        thinking(thought),
        { type: 'redacted_thinking' as const, data: 'opaque' },
        { type: 'text' as const, text: 'A clean answer.' },
      ],
    };
  }

  it('passes a response whose thinking is clean, parts untouched', async () => {
    const hook = createOutputGuardrail({ validators: [secretValidator], action: 'redact' });
    expect(await hook(responseWithThought('a clean thought'), createMockStepContext())).toBe(
      undefined,
    );
  });

  it('blocks the whole response when only the thinking is flagged', async () => {
    const hook = createOutputGuardrail({ validators: [secretValidator], action: 'block' });

    const result = await hook(responseWithThought('the SECRET is x'), createMockStepContext());

    expect(result?.content).toContain('blocked');
    expect(result?.toolCalls).toEqual([]);
    expect(result?.parts).toBeUndefined();
  });

  it('redacts a step with no tool calls by removing the flagged thinking: the answer and other parts stand', async () => {
    const hook = createOutputGuardrail({ validators: [secretValidator], action: 'redact' });
    const response = { ...responseWithThought('the SECRET is x'), toolCalls: [] };
    response.parts.splice(1, 0, thinking('a clean second thought') as never);

    const result = await hook(response, createMockStepContext());

    expect(result?.content).toBe('A clean answer.');
    expect(result?.toolCalls).toEqual([]);
    expect(result?.parts).toEqual([
      thinking('a clean second thought'),
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'A clean answer.' },
    ]);
    expect(result?.withheldThinking).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('redacts a tool-call step by marking the flagged thinking withheld, every part kept unchanged', async () => {
    // A provider requires a tool-use turn's thinking back complete and unmodified on the next
    // request, so the parts stay as they are and only the stream is told to leave them out.
    const hook = createOutputGuardrail({ validators: [secretValidator], action: 'redact' });
    const response = responseWithThought('the SECRET is x');
    response.parts.splice(2, 0, thinking('another SECRET thought') as never);
    response.parts.splice(1, 0, thinking('a clean second thought') as never);
    const parts = structuredClone(response.parts);

    const result = await hook(response, createMockStepContext());

    expect(result?.content).toBe('A clean answer.');
    expect(result?.toolCalls).toEqual(response.toolCalls);
    expect(result?.parts).toEqual(parts);
    expect(result?.withheldThinking).toEqual([0, 3]);
  });

  it('redacts flagged content as before even when the thinking is flagged too', async () => {
    const hook = createOutputGuardrail({ validators: [secretValidator], action: 'redact' });
    const response = { ...responseWithThought('the SECRET is x'), content: 'the SECRET answer' };

    const result = await hook(response, createMockStepContext());

    expect(result).toEqual({ content: 'the [REDACTED] answer', toolCalls: [] });
  });

  it('throws the tripwire for flagged thinking, as it does for flagged content', async () => {
    const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
    const hook = createOutputGuardrail({
      validators: [secretValidator],
      action: 'tripwire',
      onTriggered,
    });

    let thrown: unknown;
    try {
      await hook(responseWithThought('the SECRET is x'), createMockStepContext());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GuardrailTripwireError);
    expect(onTriggered).toHaveBeenCalledTimes(1);
  });

  it('calls onTriggered once and passes the response through under warn', async () => {
    const onTriggered = mock((_event: OutputGuardrailTriggeredEvent) => {});
    const hook = createOutputGuardrail({
      validators: [secretValidator],
      action: 'warn',
      onTriggered,
    });
    const response = responseWithThought('the SECRET is x');

    expect(await hook(response, createMockStepContext())).toBeUndefined();
    expect(onTriggered).toHaveBeenCalledTimes(1);
    expect(onTriggered.mock.calls[0]![0].validator).toBe('secret');
  });
});
